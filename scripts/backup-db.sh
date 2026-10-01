#!/usr/bin/env bash
# The nightly backup: a dump of the production database, encrypted, copied to
# storage outside GitHub, Vercel and Neon. See "Backups" in the README.
#
#   DATABASE_URL             the database to dump: a read-only role, on the
#                            direct (not "-pooler") host
#   BACKUP_AGE_RECIPIENT     the age public key (age1...) the dump is encrypted to
#   BACKUP_S3_BUCKET         bucket name; it must have Object Lock on
#   BACKUP_S3_ENDPOINT       S3-compatible endpoint (Backblaze B2), or empty for AWS S3
#   AWS_ACCESS_KEY_ID        a key that can add files but not delete them
#   AWS_SECRET_ACCESS_KEY
#   AWS_DEFAULT_REGION       the bucket's region
#   BACKUP_PREFIX            optional, default "aerobook"
#   BACKUP_MIN_RETENTION_DAYS optional, default 30; it cannot be set lower
#   BACKUP_VERIFY_URL        an empty Postgres on this machine; every dump is
#                            restored into it and compared before upload
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

for name in DATABASE_URL BACKUP_VERIFY_URL BACKUP_AGE_RECIPIENT BACKUP_S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  [[ -n "${!name:-}" ]] || fail "$name is not set"
done
[[ "$BACKUP_AGE_RECIPIENT" == age1* ]] ||
  fail "BACKUP_AGE_RECIPIENT must be an age public key (age1...), never the private key"
# Neon's pooler cannot hold the snapshot pg_dump works from.
[[ "$DATABASE_URL" != *-pooler.* ]] ||
  fail "DATABASE_URL is Neon's pooled host; use the direct one (without -pooler)"
# The check restores into BACKUP_VERIFY_URL, so it must never be able to
# point at a real database: it has to be on this machine, and empty.
# No "?options" either: libpq would let ?host= send it somewhere else.
[[ "$BACKUP_VERIFY_URL" =~ ^postgres(ql)?://[^@/?]*@(localhost|127\.0\.0\.1)(:[0-9]+)?/[^?]*$ ]] ||
  fail "BACKUP_VERIFY_URL must be a database on this machine (localhost), with no ?options"

endpoint=()
if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
  endpoint=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  # Newer AWS CLIs add checksums that not every S3-compatible service accepts.
  # AWS itself needs them on an Object Lock bucket, so only off AWS.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
fi

# The bucket must refuse deletes for long enough, in a mode nobody can lift
# (COMPLIANCE, not GOVERNANCE). Checked every night, so a lock turned off or
# shortened stops the backups loudly rather than quietly weakening them.
min_days="${BACKUP_MIN_RETENTION_DAYS:-30}"
[[ "$min_days" =~ ^[0-9]+$ ]] && (( min_days >= 30 )) ||
  fail "BACKUP_MIN_RETENTION_DAYS cannot be below 30"
lock=$(aws s3api get-object-lock-configuration --bucket "$BACKUP_S3_BUCKET" "${endpoint[@]}" --output json) ||
  fail "Could not read the bucket's Object Lock settings (is Object Lock on, and may this key read them?)"
mode=$(jq -r '.ObjectLockConfiguration.Rule.DefaultRetention.Mode // empty' <<<"$lock")
days=$(jq -r '.ObjectLockConfiguration.Rule.DefaultRetention | (.Days // 0) + (.Years // 0) * 365' <<<"$lock")
[[ "$(jq -r '.ObjectLockConfiguration.ObjectLockEnabled // empty' <<<"$lock")" == Enabled ]] ||
  fail "Object Lock is not enabled on the bucket"
[[ "$mode" == COMPLIANCE ]] || fail "The bucket's default retention is '${mode:-none}', not COMPLIANCE"
(( days >= min_days )) || fail "The bucket keeps backups locked for $days days; it must be at least $min_days"

# pg_dump refuses a server newer than itself; say so plainly instead.
server=$(psql "$DATABASE_URL" -XAtc 'show server_version_num')
[[ "$(pg_dump --version)" =~ ([0-9]+) ]] && client=${BASH_REMATCH[1]}
(( client >= server / 10000 )) || fail "pg_dump $client is older than the database (Postgres $((server / 10000)))"

# The backup must not be able to change what it backs up. pg_dump only reads,
# but a mistaken connection string (the owner's) would hand this job, and
# anyone who reads its secrets, the power to write. Refuse to run with one.
writable=$(psql "$DATABASE_URL" -XAt <<'SQL'
select (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolbypassrls
        -- roles that can write anything, or Neon's admin role
        or exists (select 1 from pg_roles s
                    where s.rolname in ('neon_superuser', 'pg_write_all_data')
                      and pg_has_role(current_user, s.oid, 'member'))
        or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.relkind in ('r', 'p', 'S') and n.nspname not in ('pg_catalog', 'information_schema')
                      and (pg_has_role(current_user, c.relowner, 'member')   -- an owner, even via SET ROLE
                           or (c.relkind <> 'S' and (has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
                                                     or has_any_column_privilege(c.oid, 'INSERT, UPDATE')))
                           or (c.relkind = 'S' and has_sequence_privilege(c.oid, 'UPDATE')))))
  from pg_roles r where r.rolname = current_user
SQL
)
[[ "$writable" == f ]] ||
  fail "The database role can change data; use the read-only role from the README"

work=$(mktemp -d)
snap_pid=
cleanup() {
  [[ -n "$snap_pid" ]] && kill "$snap_pid" 2>/dev/null
  rm -rf "$work"
}
trap cleanup EXIT
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
dump="$work/aerobook-$stamp.dump"

# Every table except Neon Auth's (the neon_auth schema), which AEROBOOK does
# not use. All of AEROBOOK's own are in public.
count_rows="select format('%s.%s %s', n.nspname, c.relname,
                (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', n.nspname, c.relname), false, true, '')))[1])
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'neon_auth')
               and left(n.nspname, 3) <> 'pg_' order by 1;"

# Count every table and dump it from the same moment: a read-only
# transaction is held open and pg_dump joins its snapshot, so the counts and
# the dump describe exactly the same data even while people are using the app.
coproc SNAP { psql "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1; }
snap_pid=$SNAP_PID
echo "begin isolation level repeatable read read only; select pg_export_snapshot();" >&"${SNAP[1]}"
read -r -t 60 -u "${SNAP[0]}" snapshot || fail "Could not start a snapshot of the database"
echo "$count_rows select '--end--';" >&"${SNAP[1]}"
source_counts=
counted=
while read -r -t 300 -u "${SNAP[0]}" line; do
  [[ "$line" == --end-- ]] && { counted=1; break; }
  source_counts+="$line"$'\n'
done
source_counts=${source_counts%$'\n'}
[[ -n "$counted" && -n "$source_counts" ]] || fail "Could not count the database's rows"

pg_dump "$DATABASE_URL" --snapshot="$snapshot" --exclude-schema=neon_auth \
  --format=custom --compress=9 --no-owner --no-privileges --file="$dump"
echo "commit;" >&"${SNAP[1]}"
exec {SNAP[1]}>&-
wait "$snap_pid" 2>/dev/null
snap_pid=

# A backup is only accepted once it has been restored in full and holds
# exactly what the database held. pg_restore stops at the first error, so a
# dump cut short or damaged fails here, never in the middle of a real restore.
grep -qE '^[0-9]+; [0-9]+ [0-9]+ TABLE public user( |$)' <<<"$(pg_restore --list "$dump")" ||
  fail "The dump has no \"user\" table; refusing to upload it"
verify_tables=$(psql "$BACKUP_VERIFY_URL" -XAtc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                                                  where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')")
[[ "$verify_tables" == 0 ]] || fail "BACKUP_VERIFY_URL is not empty; it must be a fresh database"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$BACKUP_VERIFY_URL" "$dump" ||
  fail "The dump did not restore; refusing to upload it"
restored_counts=$(psql "$BACKUP_VERIFY_URL" -XAt -v ON_ERROR_STOP=1 -c "$count_rows")
if [[ "$restored_counts" != "$source_counts" ]]; then
  diff <(echo "$source_counts") <(echo "$restored_counts") | sed 's/^/  /' >&2 || true
  fail "The restored copy does not match the database (table row counts above); refusing to upload it"
fi
accounts=$(awk '$1 == "public.user" { print $2 }' <<<"$source_counts")
(( ${accounts:-0} > 0 )) || fail "The \"user\" table has no accounts; refusing to upload a backup of an empty database"

# Encrypted to a public key: whoever can read the bucket, or this job's
# secrets, still cannot read the data. Only the offline private key can.
# It is also encrypted to a key made for this run alone, so the file itself
# can be opened and compared before upload; that key is never saved anywhere
# and is gone when the run ends.
age-keygen -o "$work/run.key" 2>/dev/null
run_recipient=$(age-keygen -y "$work/run.key")
age --recipient "$BACKUP_AGE_RECIPIENT" --recipient "$run_recipient" --output "$dump.age" "$dump"
cmp -s <(age --decrypt --identity "$work/run.key" "$dump.age") "$dump" ||
  fail "The encrypted file does not decrypt to the dump; refusing to upload it"
rm -f "$work/run.key"

# Every run gets a name of its own, so a backup is never written over.
prefix="${BACKUP_PREFIX:-aerobook}"
key="$prefix/$(date -u +%Y/%m)/aerobook-$stamp-${GITHUB_RUN_ID:-local}.dump.age"
aws s3 cp "$dump.age" "s3://$BACKUP_S3_BUCKET/$key" "${endpoint[@]}" --only-show-errors

echo "Backed up $(du -h "$dump.age" | cut -f1) to $key: ${accounts} accounts, $(wc -l <<<"$source_counts") tables, restored and checked"
