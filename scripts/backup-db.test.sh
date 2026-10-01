#!/usr/bin/env bash
# Tests for scripts/backup-db.sh, against a real Postgres with the upload
# stubbed. Each case says what the backup must do and checks it did.
#
#   npm run test:backup
#
# Needs psql, pg_dump, pg_restore and age, and a Postgres on this machine it
# may create and drop databases and roles on (BACKUP_TEST_ADMIN_URL, default
# postgres://postgres:postgres@localhost:5432/postgres). Everything it makes
# is called bk_test_* and is removed after.
set -uo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
admin=${BACKUP_TEST_ADMIN_URL:-postgres://postgres:postgres@localhost:5432/postgres}
base=${admin%/*}   # postgres://user:pass@host:port
host=${base#*@}    # host:port
[[ "$host" == localhost* || "$host" == 127.0.0.1* ]] || { echo "BACKUP_TEST_ADMIN_URL must be on localhost"; exit 1; }

work=$(mktemp -d)
bucket="$work/bucket"
stubs="$work/bin"
mkdir -p "$bucket" "$stubs"
real_pg_dump=$(command -v pg_dump)
real_pg_restore=$(command -v pg_restore)
ROLES="ro sel super member colgrant writer app"

q() { psql "$admin" -XAtqv ON_ERROR_STOP=1 "$@"; }
as() { echo "postgres://$1@$host/bk_test_src"; }
drop_all() {
  for db in src verify; do q -c "drop database if exists bk_test_$db with (force)" 2>/dev/null; done
  for r in $ROLES; do q -c "drop role if exists bk_test_$r" 2>/dev/null; done
}
trap 'drop_all; rm -rf "$work"' EXIT
drop_all

# ------------------------------------------------------------ the database
# Like production: AEROBOOK's tables in public, owned by a role that is not a
# superuser (Neon's neondb_owner), and Neon Auth's own "user" in neon_auth.
q -c "create role bk_test_app login password 'app'" -c "create database bk_test_src owner bk_test_app" >/dev/null
OWNER=$(as bk_test_app:app)
psql "$OWNER" -XAtqv ON_ERROR_STOP=1 -f "$root/db/schema.sql" >/dev/null 2>&1 || { echo "could not load db/schema.sql"; exit 1; }
psql "$OWNER" -XAtqv ON_ERROR_STOP=1 <<'SQL'
insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
values ('u1', 'Test Admin', 'a@example.com', true, now(), now(), 'admin'),
       ('u2', 'Test User', 'u@example.com', true, now(), now(), 'user');
create schema neon_auth;
create table neon_auth."user" (id text primary key);
-- Enough rows that table data, not the table of contents, is most of the file.
create table bulk as select md5(i::text) as v from generate_series(1, 50000) i;
SQL
psql "$base/bk_test_src" -XAtqv ON_ERROR_STOP=1 <<'SQL'
create role bk_test_ro login password 'ro-SECRET-pw';
grant pg_read_all_data to bk_test_ro;
create role bk_test_sel login password 'sel';
grant usage on schema public to bk_test_sel;
grant select on all tables in schema public to bk_test_sel;
grant select on all sequences in schema public to bk_test_sel;
create role bk_test_super login superuser password 'su';
create role bk_test_member login noinherit password 'me';
grant pg_read_all_data to bk_test_member;
grant bk_test_app to bk_test_member;
create role bk_test_colgrant login password 'co';
grant pg_read_all_data to bk_test_colgrant;
grant update (name) on "user" to bk_test_colgrant;
create role bk_test_writer login password 'wr';
grant pg_read_all_data, pg_write_all_data to bk_test_writer;
SQL
RO=$(as bk_test_ro:ro-SECRET-pw)
VERIFY="$base/bk_test_verify"
fresh_verify() { q -c "drop database if exists bk_test_verify with (force)" -c "create database bk_test_verify" >/dev/null; }

# ------------------------------------------------------------ the stubs
# aws: the Object Lock answer is LOCK_JSON; "cp" copies into $bucket, or
# fails when AWS_FAIL_UPLOAD is set.
cat >"$stubs/aws" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == s3api ]]; then
  [[ -n "\${LOCK_JSON:-}" ]] || { echo "ObjectLockConfigurationNotFoundError" >&2; exit 254; }
  echo "\$LOCK_JSON"; exit 0
fi
[[ -n "\${AWS_FAIL_UPLOAD:-}" ]] && { echo "upload failed" >&2; exit 1; }
dest="\${4#s3://}"; mkdir -p "$bucket/\$(dirname "\$dest")"; cp "\$3" "$bucket/\$dest"
EOF
# pg_dump: the real one, then damaged the way a bad disk or a dump cut off
# part-way would leave it. CORRUPT_DUMP=cut drops the second half;
# CORRUPT_DUMP=data overwrites bytes three quarters in, inside the table data,
# leaving the table of contents at the start readable.
cat >"$stubs/pg_dump" <<EOF
#!/usr/bin/env bash
"$real_pg_dump" "\$@" || exit \$?
f=
for a in "\$@"; do [[ "\$a" == --file=* ]] && f="\${a#--file=}"; done
[[ -n "\$f" ]] || exit 0
size=\$(stat -c %s "\$f")
case "\${CORRUPT_DUMP:-}" in
  cut) truncate -s \$(( size / 2 )) "\$f" ;;
  data) printf 'damaged%.0s' {1..64} | dd of="\$f" bs=1 seek=\$(( size * 3 / 4 )) conv=notrunc status=none ;;
esac
EOF
# pg_restore: the real one, but LOSE_ROWS then deletes rows from what it just
# restored, as a restore that silently lost data would.
cat >"$stubs/pg_restore" <<EOF
#!/usr/bin/env bash
"$real_pg_restore" "\$@" || exit \$?
if [[ -n "\${LOSE_ROWS:-}" ]]; then
  for a in "\$@"; do [[ "\$a" == --dbname=* ]] && db="\${a#--dbname=}"; done
  [[ -n "\${db:-}" ]] && psql "\$db" -XAtqc "delete from bulk where v < '1'" >/dev/null
fi
exit 0
EOF
chmod +x "$stubs/aws" "$stubs/pg_dump" "$stubs/pg_restore"

age-keygen -o "$work/key.txt" 2>"$work/pub.txt"
PUB=$(grep -o 'age1[a-z0-9]*' "$work/pub.txt")
lock() { echo "{\"ObjectLockConfiguration\":{\"ObjectLockEnabled\":\"Enabled\"$1}}"; }
LOCK30=$(lock ',"Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}')

passed=0
failed=0
uploads() { find "$bucket" -name '*.age' | wc -l; }
pass() { passed=$((passed + 1)); echo "ok   - $1"; }
flunk() { failed=$((failed + 1)); echo "FAIL - $1"; }

# expect ok|fail "what" "text the output must contain (fail only)" [VAR=value...]
expect() {
  local want=$1 what=$2 needle=$3 before after out code
  shift 3
  fresh_verify
  before=$(uploads)
  out=$(env PATH="$stubs:$PATH" DATABASE_URL="$RO" BACKUP_VERIFY_URL="$VERIFY" \
    BACKUP_AGE_RECIPIENT="$PUB" BACKUP_S3_BUCKET=test BACKUP_S3_ENDPOINT=https://s3.example.com \
    AWS_ACCESS_KEY_ID=x AWS_SECRET_ACCESS_KEY=aws-SECRET-key AWS_DEFAULT_REGION=r GITHUB_RUN_ID=$RANDOM$RANDOM \
    LOCK_JSON="$LOCK30" "$@" "$root/scripts/backup-db.sh" 2>&1)
  code=$?
  after=$(uploads)
  if [[ "$out" == *SECRET* ]]; then flunk "$what (a password or key appeared in the output)"; sed 's/^/       /' <<<"$out"; return; fi
  if [[ $want == ok ]] && (( code == 0 && after == before + 1 )); then pass "$what"; return; fi
  if [[ $want == fail ]] && (( code != 0 && after == before )) && [[ "$out" == *"$needle"* ]]; then pass "$what"; return; fi
  flunk "$what (exit $code, files uploaded $before -> $after)"
  sed 's/^/       /' <<<"$out"
}

echo "# backups that must succeed"
expect ok "read-only role (pg_read_all_data)" ""
expect ok "read-only role (the README's table grants)" "" DATABASE_URL="$(as bk_test_sel:sel)"
expect ok "a one-year lock" "" LOCK_JSON="$(lock ',"Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Years":1}}')"

echo "# what was uploaded"
latest=$(find "$bucket" -name '*.age' | sort | tail -1)
fresh_verify
if age -d -i "$work/key.txt" "$latest" >"$work/restored.dump" 2>/dev/null &&
   pg_restore --exit-on-error --no-owner --no-privileges -d "$VERIFY" "$work/restored.dump" &&
   [[ "$(psql "$VERIFY" -XAtc "select string_agg(name, ',' order by name) from public.\"user\"")" == "Test Admin,Test User" ]]; then
  pass "the uploaded file decrypts with the offline key and restores both accounts"
else
  flunk "the uploaded file did not decrypt and restore"
fi
if grep -qa 'Test Admin' "$latest"; then flunk "the uploaded file contains plaintext"; else pass "the uploaded file is unreadable without the key"; fi
if age -d -i "$work/key.txt" "$latest" 2>/dev/null | grep -qa 'Neon Auth\|neon_auth'; then
  flunk "the dump includes the neon_auth schema"
else
  pass "the dump holds AEROBOOK's schema only, not neon_auth"
fi

echo "# a database role that could change data"
expect fail "superuser" "can change data" DATABASE_URL="$(as bk_test_super:su)"
expect fail "the tables' owner" "can change data" DATABASE_URL="$OWNER"
expect fail "a member of the owner (noinherit, so it can SET ROLE)" "can change data" DATABASE_URL="$(as bk_test_member:me)"
expect fail "a column-level UPDATE grant" "can change data" DATABASE_URL="$(as bk_test_colgrant:co)"
expect fail "pg_write_all_data" "can change data" DATABASE_URL="$(as bk_test_writer:wr)"

echo "# a bucket that does not lock backups"
expect fail "no Object Lock" "Object Lock" LOCK_JSON=
expect fail "GOVERNANCE mode" "not COMPLIANCE" LOCK_JSON="$(lock ',"Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":30}}')"
expect fail "a 7-day lock" "at least 30" LOCK_JSON="$(lock ',"Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":7}}')"
expect fail "lock on but no default retention" "not COMPLIANCE" LOCK_JSON="$(lock '')"
expect fail "BACKUP_MIN_RETENTION_DAYS lowered below 30" "below 30" BACKUP_MIN_RETENTION_DAYS=1 \
  LOCK_JSON="$(lock ',"Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":7}}')"

echo "# a backup that is not a good copy"
expect fail "a dump cut off part-way" "refusing to upload" CORRUPT_DUMP=cut
expect fail "damaged table data, table of contents intact" "did not restore" CORRUPT_DUMP=data
expect fail "a restore that loses rows" "does not match the database" LOSE_ROWS=1
psql "$OWNER" -XAtqc 'alter table "user" rename to user_gone'
expect fail "no public \"user\" table (only neon_auth's)" "no \"user\" table"
psql "$OWNER" -XAtqc 'alter table user_gone rename to "user"' -c 'create table bk_hold as select * from "user"' -c 'delete from "user"'
expect fail "an empty \"user\" table" "no accounts"
psql "$OWNER" -XAtqc 'insert into "user" select * from bk_hold' -c 'drop table bk_hold'

echo "# settings that must be refused"
expect fail "a variable missing" "BACKUP_S3_BUCKET is not set" BACKUP_S3_BUCKET=
expect fail "the private key in place of the public one" "never the private key" BACKUP_AGE_RECIPIENT=AGE-SECRET-KEY-1ABC
expect fail "Neon's pooled host" "pooled" DATABASE_URL=postgres://u:p@ep-x-pooler.us-east-1.aws.neon.tech/db
expect fail "no verification database" "BACKUP_VERIFY_URL is not set" BACKUP_VERIFY_URL=
expect fail "a verification database elsewhere than this machine" "this machine" BACKUP_VERIFY_URL=postgres://u:p@db.example.com/x
expect fail "a verification database that is not empty" "not empty" BACKUP_VERIFY_URL="$base/bk_test_src"
expect fail "a verification database redirected with ?host=" "no ?options" BACKUP_VERIFY_URL="$VERIFY?host=db.example.com"
expect fail "a wrong database password (and it is not printed)" "password authentication failed" DATABASE_URL="$(as bk_test_ro:wrong-SECRET-pw)"

echo "# failures after the dump"
expect fail "the upload fails" "upload failed" AWS_FAIL_UPLOAD=1

echo
echo "$passed passed, $failed failed"
(( failed == 0 ))
