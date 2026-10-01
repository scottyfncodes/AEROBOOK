-- AEROBOOK disaster-recovery verification.
--
-- One read-only statement. Run it against production and against a restored
-- copy and compare the two results; see docs/disaster-recovery.md.
--
-- It returns counts, checksums and broken-link counts only — never a record's
-- contents, a name, an email or a secret — so its output is safe to paste
-- into a report.
--
--   psql "$DATABASE_URL" -X -A -t -f scripts/dr/verify.sql
--
-- or paste it into the Neon SQL editor with the branch selected.
with
-- Every relationship between records, as (collection, field, target).
refs(collection, field, target) as (values
  ('activities',    'contactId',         'contacts'),
  ('activities',    'aircraftId',        'aircraft'),
  ('activities',    'opportunityId',     'opportunities'),
  ('followUps',     'contactId',         'contacts'),
  ('followUps',     'aircraftId',        'aircraft'),
  ('followUps',     'opportunityId',     'opportunities'),
  ('followUps',     'insurancePolicyId', 'policies'),
  ('opportunities', 'contactId',         'contacts'),
  ('opportunities', 'aircraftId',        'aircraft'),
  ('policies',      'contactId',         'contacts'),
  ('policies',      'aircraftId',        'aircraft'),
  ('policies',      'opportunityId',     'opportunities'),
  ('files',         'contactId',         'contacts'),
  ('files',         'aircraftId',        'aircraft'),
  ('files',         'opportunityId',     'opportunities'),
  ('files',         'insurancePolicyId', 'policies')
),
live as (select collection, id, data from app_record where data is not null),
links as (
  select r.collection, r.field, r.target, l.data ->> r.field as ref
    from refs r join live l on l.collection = r.collection
   where coalesce(l.data ->> r.field, '') <> ''
  union all
  -- An aircraft's owners, current and past.
  select 'aircraft', 'ownerships.contactId', 'contacts', o ->> 'contactId'
    from live l, jsonb_array_elements(coalesce(l.data -> 'ownerships', '[]')) o
   where l.collection = 'aircraft'
),
checks(section, name, value) as (
  select 'database', 'restored_at', now()::text
  union all select 'database', 'wal_lsn',
    case when pg_is_in_recovery() then pg_last_wal_replay_lsn()::text else pg_current_wal_lsn()::text end
  union all select 'database', 'tables_public', count(*)::text
    from information_schema.tables where table_schema = 'public'

  -- Records, per collection: how many, how many deleted (kept as tombstones),
  -- and a checksum over id, version and contents.
  union all select 'records', collection || '.live', count(*) filter (where data is not null)::text
    from app_record group by collection
  union all select 'records', collection || '.deleted', count(*) filter (where data is null)::text
    from app_record group by collection
  union all select 'records', collection || '.md5',
    md5(string_agg(id || ':' || version || ':' || coalesce(md5(data::text), '-'), ',' order by id))
    from app_record group by collection
  union all select 'records', 'max_seq', coalesce(max(seq), 0)::text from app_record

  -- Uploaded documents: records that point at a file in Blob storage.
  union all select 'documents', 'with_blob_path', count(*)::text
    from live where collection = 'files' and coalesce(data ->> 'blobPath', '') <> ''
  union all select 'documents', 'browser_only', count(*)::text
    from live where collection = 'files' and coalesce(data ->> 'blobPath', '') = ''
  union all select 'documents', 'blob_paths_md5',
    coalesce(md5(string_agg(data ->> 'blobPath', ',' order by data ->> 'blobPath')), '-')
    from live where collection = 'files' and coalesce(data ->> 'blobPath', '') <> ''
  union all select 'documents', 'in_trash', count(*)::text from app_file_trash

  -- Relationships: references that point at a record that is not there.
  union all select 'links', collection || '.' || field || '.total', count(*)::text
    from links group by collection, field
  union all select 'links', collection || '.' || field || '.dangling',
    count(*) filter (where not exists (
      select 1 from live t where t.collection = links.target and t.id = links.ref))::text
    from links group by collection, field

  -- Audit trail / activity history.
  union all select 'audit', 'rows', count(*)::text from app_audit
  union all select 'audit', 'max_id', coalesce(max(id), 0)::text from app_audit
  union all select 'audit', 'with_before', count(*) filter (where before is not null)::text from app_audit
  union all select 'audit', 'md5',
    coalesce(md5(string_agg(id || ':' || action || ':' || collection || ':' || record_id, ',' order by id)), '-')
    from app_audit

  -- Sign-in: accounts, credentials, two-step sign-in. Counts only.
  union all select 'auth', 'users', count(*)::text from "user"
  union all select 'auth', 'admins', count(*) filter (where role = 'admin')::text from "user"
  union all select 'auth', 'password_accounts', count(*) filter (where "providerId" = 'credential')::text from account
  union all select 'auth', 'two_factor', count(*)::text from "twoFactor"
  union all select 'auth', 'users_md5', md5(string_agg(id, ',' order by id)) from "user"

  -- Team features.
  union all select 'team', 'conversations', count(*)::text from app_conversation
  union all select 'team', 'conversation_members', count(*)::text from app_conversation_member
  union all select 'team', 'messages', count(*)::text from app_message
  union all select 'team', 'aircraft_comments', count(*)::text from app_aircraft_comment
  union all select 'team', 'notifications', count(*)::text from app_notification
  union all select 'team', 'push_subscriptions', count(*)::text from app_push_subscription
  union all select 'team', 'deleted_users', count(*)::text from app_deleted_user
)
select section, name, value from checks order by section, name;
