-- AEROBOOK recovery fingerprint.
--
-- Read-only. Run it against the production database and against a restored
-- copy (a Neon branch restored from a snapshot, or a database loaded from a
-- dump); the two results must be identical, row for row, for everything that
-- existed when the backup was taken. See docs/DISASTER_RECOVERY.md.
--
--   psql "$DATABASE_URL" -f scripts/recovery-fingerprint.sql
--
-- Each row is one check: what it counts (n), a second number (extra: deleted
-- records, broken links, banned people, or the highest audit id), and an md5
-- of the sorted primary keys (ids_md5) and of the sorted contents
-- (content_md5). Matching md5s mean the same set of records with the same
-- contents, not just the same number.
--
-- live_ids_sha256 is the SHA-256 of the IDs of what the app shows (records
-- not deleted; comments not deleted, on aircraft not deleted), exactly as a
-- complete archive's manifest.json records it under
-- collections.<name>.idsSha256, so an archive can be checked against the
-- database it came from.
--
-- No customer data is printed: only counts and hashes.

with rec as (
  select collection, id, version, data from app_record
),
live as (
  select collection, id, data from rec where data is not null
),
-- Every link one business record makes to another, by field.
refs as (
  select r.collection as src, r.id as src_id, f.field, f.target_collection, r.data->>f.field as target_id
    from live r
    join (values
      ('activities', 'contactId', 'contacts'), ('activities', 'aircraftId', 'aircraft'),
      ('activities', 'opportunityId', 'opportunities'),
      ('followUps', 'contactId', 'contacts'), ('followUps', 'aircraftId', 'aircraft'),
      ('followUps', 'opportunityId', 'opportunities'), ('followUps', 'insurancePolicyId', 'policies'),
      ('files', 'contactId', 'contacts'), ('files', 'aircraftId', 'aircraft'),
      ('files', 'opportunityId', 'opportunities'), ('files', 'insurancePolicyId', 'policies'),
      ('policies', 'contactId', 'contacts'), ('policies', 'aircraftId', 'aircraft'),
      ('policies', 'opportunityId', 'opportunities'),
      ('opportunities', 'contactId', 'contacts'), ('opportunities', 'aircraftId', 'aircraft')
    ) as f(collection, field, target_collection) on f.collection = r.collection
   where coalesce(r.data->>f.field, '') <> ''
  union all
  select 'aircraft', a.id, 'ownerships.contactId', 'contacts', o->>'contactId'
    from live a, jsonb_array_elements(coalesce(a.data->'ownerships', '[]'::jsonb)) o
   where a.collection = 'aircraft' and coalesce(o->>'contactId', '') <> ''
),
checks (check_name, n, extra, ids_md5, content_md5, live_ids_sha256) as (
  -- Business records, per collection.
  select 'record:' || collection,
         count(*) filter (where data is not null),
         count(*) filter (where data is null),
         md5(string_agg(id, ',' order by id)),
         md5(string_agg(id || ':' || version || ':' || coalesce(md5(data::text), '-'), ',' order by id)),
         encode(sha256(convert_to(coalesce(
           string_agg(id, ',' order by id collate "C") filter (where data is not null), ''), 'UTF8')), 'hex')
    from rec group by collection
  union all
  -- Links between records: total, and how many point at nothing or at a deleted record.
  select 'links:' || src || '.' || field,
         count(*),
         count(*) filter (where not exists (
           select 1 from live t where t.collection = refs.target_collection and t.id = refs.target_id)),
         md5(string_agg(src_id || '>' || target_id, ',' order by src_id, target_id)),
         null, null
    from refs group by src, field
  union all
  -- Documents: one record per stored file.
  select 'documents:blob-paths',
         count(*) filter (where data ? 'blobPath'),
         count(*) filter (where not data ? 'blobPath'),
         md5(string_agg(coalesce(data->>'blobPath', '-'), ',' order by data->>'blobPath')),
         md5(string_agg(id || ':' || coalesce(data->>'blobPath', '-') || ':' || coalesce(data->>'size', '-'), ',' order by id)),
         null
    from live where collection = 'files'
  union all
  select 'documents:trash', count(*), 0, md5(string_agg(path, ',' order by path)), null, null from app_file_trash
  union all
  -- Aircraft comments and their history.
  select 'comments', count(*), count(*) filter (where deleted_at is not null),
         md5(string_agg(id::text, ',' order by id)),
         md5(string_agg(id || ':' || aircraft_id || ':' || author_id || ':' || md5(body), ',' order by id)),
         null
    from app_aircraft_comment
  union all
  select 'comments:exportable', count(*), 0, null, null,
         encode(sha256(convert_to(coalesce(string_agg(c.id::text, ',' order by c.id), ''), 'UTF8')), 'hex')
    from app_aircraft_comment c
    join app_record r on r.collection = 'aircraft' and r.id = c.aircraft_id and r.data is not null
   where c.deleted_at is null
  union all
  select 'comments:orphaned', count(*), 0, null, null, null
    from app_aircraft_comment c
   where not exists (select 1 from app_record r where r.collection = 'aircraft' and r.id = c.aircraft_id)
  union all
  select 'comment-revisions', count(*), 0, md5(string_agg(id::text, ',' order by id)),
         md5(string_agg(id || ':' || comment_id || ':' || md5(body), ',' order by id)), null
    from app_aircraft_comment_revision
  union all
  -- Chat.
  select 'conversations', count(*), 0, md5(string_agg(id, ',' order by id)), null, null from app_conversation
  union all
  select 'messages', count(*), 0, md5(string_agg(id::text, ',' order by id)),
         md5(string_agg(id || ':' || conversation_id || ':' || md5(body), ',' order by id)), null
    from app_message
  union all
  -- People and their roles. Password hashes are compared by hash, never shown.
  select 'users:' || coalesce(role, 'user'), count(*), count(*) filter (where banned),
         md5(string_agg(id, ',' order by id)),
         md5(string_agg(id || ':' || email || ':' || coalesce("twoFactorEnabled", false), ',' order by id)),
         null
    from "user" group by coalesce(role, 'user')
  union all
  select 'accounts:password', count(*), 0, md5(string_agg("userId", ',' order by "userId")),
         md5(string_agg("userId" || ':' || md5(coalesce(password, '')), ',' order by "userId")), null
    from account where "providerId" = 'credential'
  union all
  select 'two-factor', count(*), 0, md5(string_agg("userId", ',' order by "userId")), null, null from "twoFactor"
  union all
  select 'deleted-users', count(*), 0, md5(string_agg(user_id, ',' order by user_id)), null, null from app_deleted_user
  union all
  -- The audit log: every change ever saved, with what each record held before.
  select 'audit:' || collection, count(*), max(id),
         md5(string_agg(id::text, ',' order by id)),
         md5(string_agg(id || ':' || action || ':' || record_id || ':' || coalesce(md5(before::text), '-'), ',' order by id)),
         null
    from app_audit group by collection
)
select check_name, n, extra, ids_md5, content_md5, live_ids_sha256 from checks order by check_name;
