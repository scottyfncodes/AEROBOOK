-- What a company data export of this database must contain, for
-- `npm run verify:export -- <zip> --expect expected.json`.
--
-- One read-only statement returning one JSON value: live record counts per
-- collection, the number of people and audit entries, and every document's
-- id and size in bytes. No names, contents, emails or secrets. Run it just
-- before making the export, with nobody else editing, and save the value as
-- expected.json. (The export itself adds an audit entry, so users and
-- auditEntries are checked as minimums; everything else must match exactly.)
--
--   psql "$DATABASE_URL" -X -A -t -f scripts/dr/export-expected.sql > expected.json
--
-- or paste it into the Neon SQL editor and copy the result.
select json_build_object(
  'counts', (
    select jsonb_object_agg(c.collection, coalesce(n.live, 0)) || jsonb_build_object(
             'users', (select count(*) from "user"),
             'auditEntries', (select count(*) from app_audit))
      from (values ('contacts'), ('aircraft'), ('opportunities'), ('policies'), ('activities'),
                   ('followUps'), ('files'), ('templates'), ('imports')) as c(collection)
      left join (select collection, count(*) as live from app_record where data is not null group by collection) n
        on n.collection = c.collection
  ),
  'documents', (
    select coalesce(json_agg(json_build_object('id', id, 'size', (data ->> 'size')::bigint) order by id), '[]'::json)
      from app_record where collection = 'files' and data is not null
  )
) as expected;
