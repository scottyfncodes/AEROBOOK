#!/usr/bin/env bash
# The nightly backup: a dump of the production database, encrypted, copied to
# storage outside GitHub, Vercel and Neon. See "Backups" in the README.
#
#   DATABASE_URL             the database to dump (a read-only role is enough)
#   BACKUP_AGE_RECIPIENT     the age public key (age1...) the dump is encrypted to
#   BACKUP_S3_BUCKET         bucket name
#   BACKUP_S3_ENDPOINT       S3-compatible endpoint (Backblaze B2, Cloudflare R2,
#                            or leave empty for AWS S3)
#   AWS_ACCESS_KEY_ID        a key that can add files but not delete them
#   AWS_SECRET_ACCESS_KEY
#   AWS_DEFAULT_REGION       the bucket's region ("auto" for R2)
#   BACKUP_PREFIX            optional, default "aerobook"
set -euo pipefail

for name in DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::$name is not set" >&2
    exit 1
  fi
done
if [[ "$BACKUP_AGE_RECIPIENT" != age1* ]]; then
  echo "::error::BACKUP_AGE_RECIPIENT must be an age public key (age1...), never the private key" >&2
  exit 1
fi

# pg_dump refuses a server newer than itself, and an older one would be
# turned away in the middle of the night; say so plainly instead.
server=$(psql "$DATABASE_URL" -XAtc 'show server_version_num')
client=$(pg_dump --version | grep -oE '[0-9]+' | head -1)
if (( client < server / 10000 )); then
  echo "::error::pg_dump $client is older than the database (Postgres $((server / 10000)))" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
stamp=$(date -u +%Y-%m-%dT%H%MZ)
dump="$work/aerobook-$stamp.dump"

# Custom format: compressed, and pg_restore can restore all of it or one table.
pg_dump "$DATABASE_URL" --format=custom --compress=9 --no-owner --no-privileges --file="$dump"

# A dump that cannot be read back, or that is missing the accounts table, is
# not a backup. Fail loudly so GitHub emails about it.
listing=$(pg_restore --list "$dump")
if ! grep -qE 'TABLE [^ ]+ user( |$)' <<<"$listing"; then
  echo "::error::The dump has no \"user\" table; refusing to upload it" >&2
  exit 1
fi

# Encrypted to a public key: whoever can read the bucket, or this job's
# secrets, still cannot read the data. Only the offline private key can.
age --recipient "$BACKUP_AGE_RECIPIENT" --output "$dump.age" "$dump"

prefix="${BACKUP_PREFIX:-aerobook}"
key="$prefix/$(date -u +%Y/%m)/aerobook-$stamp.dump.age"
endpoint=()
[[ -n "${BACKUP_S3_ENDPOINT:-}" ]] && endpoint=(--endpoint-url "$BACKUP_S3_ENDPOINT")

# Newer AWS CLIs add checksums that B2 and R2 do not all accept.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
aws s3 cp "$dump.age" "s3://$BACKUP_S3_BUCKET/$key" "${endpoint[@]}" --only-show-errors

echo "Backed up $(du -h "$dump.age" | cut -f1) to $key"
