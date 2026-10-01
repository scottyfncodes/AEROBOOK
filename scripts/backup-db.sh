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
#   BACKUP_MIN_RETENTION_DAYS optional, default 30
set -euo pipefail

fail() {
  echo "::error::$*" >&2
  exit 1
}

for name in DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  [[ -n "${!name:-}" ]] || fail "$name is not set"
done
[[ "$BACKUP_AGE_RECIPIENT" == age1* ]] ||
  fail "BACKUP_AGE_RECIPIENT must be an age public key (age1...), never the private key"
# Neon's pooler cannot hold the snapshot pg_dump works from.
[[ "$DATABASE_URL" != *-pooler.* ]] ||
  fail "DATABASE_URL is Neon's pooled host; use the direct one (without -pooler)"

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
        or exists (select 1 from pg_roles s where s.rolname = 'neon_superuser'
                    and pg_has_role(current_user, s.oid, 'member'))
        or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
                      and has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')))
  from pg_roles r where r.rolname = current_user
SQL
)
[[ "$writable" == f ]] ||
  fail "The database role can change data; use the read-only role from the README"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
dump="$work/aerobook-$stamp.dump"

# Custom format: compressed, and pg_restore can restore all of it or one table.
pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-privileges --file="$dump"

# A dump that cannot be read back, or that is missing the accounts table, is
# not a backup. Fail loudly so GitHub emails about it.
listing=$(pg_restore --list "$dump")
grep -qE 'TABLE [^ ]+ user( |$)' <<<"$listing" || fail "The dump has no \"user\" table; refusing to upload it"

# Encrypted to a public key: whoever can read the bucket, or this job's
# secrets, still cannot read the data. Only the offline private key can.
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump.age" "$dump"

# Every run gets a name of its own, so a backup is never written over.
prefix="${BACKUP_PREFIX:-aerobook}"
key="$prefix/$(date -u +%Y/%m)/aerobook-$stamp-${GITHUB_RUN_ID:-local}.dump.age"
aws s3 cp "$dump.age" "s3://$BACKUP_S3_BUCKET/$key" "${endpoint[@]}" --only-show-errors

echo "Backed up $(du -h "$dump.age" | cut -f1) to $key"
