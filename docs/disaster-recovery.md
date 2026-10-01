# Disaster recovery

How an authorized operator brings AEROBOOK back after its database or
deployment is lost or damaged, and how to prove that it still can. The last
restoration test is recorded in [dr-tests/](dr-tests/); the first was on
2026-10-01.

No recovery time objective (RTO) or recovery point objective (RPO) has been
set for AEROBOOK. The numbers below are what the tooling allows and what a
test measured, not targets.

## What exists, and where

| What | Where it lives | What protects it | Restorable? |
| --- | --- | --- | --- |
| Records, history, sign-in, chat (all of Postgres) | Neon project `polished-fog-50218432` ("neon-rose-basket"), branch `main`, created through the Vercel Marketplace Neon integration on team `nocodo` | Neon's change history (instant restore / branching from the past) | **Yes, but only 6 hours back** — the Free plan's limit. No snapshots, no snapshot schedule, no `pg_dump` exports. |
| Uploaded documents (the files) | Private Vercel Blob store `store_uXMjOtS8GAu1DmC5` (Production) | The app keeps a deleted document's file for 30 days (`app_file_trash`). Nothing else. | **No independent backup.** If the store or a file in it is lost, it is gone. |
| Document *metadata* (name, type, what it is attached to, `blobPath`) | Postgres (`app_record`, collection `files`) | As Postgres | Yes, as Postgres |
| Application code | GitHub `scottyfncodes/aerobook`, branch `main` | Git; Vercel keeps every past deployment | Yes |
| Configuration and secrets | Vercel → aerobook → Settings → Environment Variables | Nothing. Secrets are stored as *sensitive* and cannot be read back. | **No** — see [Secrets](#secrets) |
| Preview data | Separate Neon project `curly-king-93952877`, separate Blob store | — | Not needed for recovery |

Vercel does not back up the database: it only connects the Neon project to the
deployment and fills in `DATABASE_URL` and the `PG*`/`POSTGRES_*` variables.
The Neon project is billed and owned through the Vercel team, so access to
Neon goes through Vercel (Vercel → Storage → the Neon store → *Open in
Neon*).

The in-app JSON export (Settings, admins only) is a copy of the shared records
made by hand on one device. It does not include files, accounts, chat or
history, and it was not part of the restoration test.

## Who needs access

Recovery needs, at minimum, one person who can:

- sign in to Vercel team `nocodo` with a role that can change environment
  variables and open the Neon store (Owner or Member);
- open the Neon project from there (Neon Console, project
  `polished-fog-50218432`);
- push to the GitHub repository;
- read the secrets escrow (below).

Keep this to the business owner and one named technical operator, and make
sure at least two people can do it — one person holding every key is a single
point of failure. Never put a credential in this repository, an issue, a chat
or a report.

### Secrets

Vercel marks these *sensitive*: once saved, nobody can read them back. Keep a
copy of each in a password manager that the people above can open, and update
it whenever one changes.

| Variable | If it is lost |
| --- | --- |
| `BETTER_AUTH_SECRET` | Everyone is signed out, and **every two-step sign-in becomes unusable** (the TOTP secrets are encrypted with it). Each such person needs an admin reset (README → *Two-step sign-in*). Passwords still work. |
| `CRON_SECRET` | Make a new one; the daily email and maintenance runs resume. |
| `RESEND_API_KEY` | Make a new key in Resend for the verified domain. |
| `VAPID_PRIVATE_KEY` (with `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`) | Make a new pair (`npx web-push generate-vapid-keys`); each device picks it up the next time it opens the app. |
| `DATABASE_URL` and the `PG*`/`POSTGRES_*` set | Re-created by reconnecting the Neon store to the project in Vercel → Storage. |
| `BLOB_STORE_ID` | Re-created by connecting the Blob store in Vercel → Storage. |

## Recovering the database

Decide first which case you are in.

### A. Bad data, database still running (a mistaken bulk delete, a bad import, corruption)

Only possible if you act **within 6 hours** of the damage. After that, Neon's
history no longer reaches back far enough; fall back to the activity history
(README → *Activity history*), which keeps each record's previous version in
`app_audit.before`.

1. **Find the moment before the damage.** Activity history in the app shows
   who changed what and when. In the Neon Console you can query the past
   read-only (Time Travel) to confirm a timestamp.
2. **Restore into a copy first, never straight onto production.** Neon
   Console → project → Branches → *Create branch*, parent `main`, *Past data*
   at that timestamp. Name it `recovery-YYYY-MM-DD`. This does not touch
   `main`.
3. **Check the copy.** Open the Neon SQL Editor on the new branch and run
   `scripts/dr/verify.sql`. Compare it with the same query on `main`: the
   records you expect back should be there and `links.*.dangling` should all
   be 0.
4. **Put it into service.** Neon Console → `main` → Backup & Restore →
   *Restore from history* (or *From another branch*, choosing the checked
   branch). This overwrites `main` with that point in time, keeps the
   endpoint — so `DATABASE_URL` does not change and nothing in Vercel needs
   editing — and saves what `main` held just before as a branch named
   `main_old_<timestamp>`, so the restore itself can be undone.
   Everything written to `main` after the restore point is lost unless you
   copy it back from that `_old_` branch.
5. Go to [After any recovery](#after-any-recovery).

### B. The Neon project or its data is gone

1. Neon keeps deleted projects for a recovery period; check Neon Console
   (or Vercel → Storage) for a recoverable project first.
2. If there is nothing to recover, there is **no copy of the database
   anywhere else today**. Create a new Neon store in Vercel → Storage,
   connect it to the `aerobook` project for Production, apply
   `db/schema.sql` and `db/migrations/*.sql`, and use `SETUP_TOKEN` to create
   the first admin. Then restore the most recent in-app JSON export, if
   anyone has one. Accounts, chat, history and documents' files are not in
   that export.

This is why the recommendations at the end matter.

## Restoring the application

The code is in GitHub and Vercel redeploys `main` on every push.

- **Bad deploy:** Vercel → aerobook → Deployments → pick the last good one →
  *Promote to Production* / *Instant Rollback*.
- **Project lost:** create a new Vercel project from the repository, connect
  the Neon store and a private Blob store for Production, re-enter the
  secrets from escrow, then redeploy. Add the production URL to `APP_ORIGINS`
  if it is a custom domain.

## Documents

Files are not in Postgres and are not restored by a database restore.

- A database restore to an earlier time can bring back a document *record*
  whose file was deleted afterwards. The file is still in Blob for 30 days
  after deletion, and the maintenance run will not remove a file a record
  points at again.
- If the Blob store itself is lost, the files cannot be recovered. The
  records stay, and opening one fails. `scripts/dr/verify.sql` reports how
  many document records point at a file (`documents.with_blob_path`) and a
  checksum of those paths, so you can at least list what is missing.

## After any recovery

1. Open the production URL, sign in, and check a contact, an aircraft, its
   timeline and a document.
2. Run `scripts/dr/verify.sql` against production; confirm the counts look
   right and every `links.*.dangling` is 0.
3. Confirm the daily cron runs the next morning (Vercel → Logs).
4. Tell the team: anything they entered after the restore point has to be
   entered again.
5. Delete temporary recovery branches you no longer need (not `main`, not
   the `_old_` backup until you are sure).

## Testing recovery (do this regularly)

A test restores production into an isolated copy and proves the app works on
it. It never writes to production. Takes about 20 minutes.

1. **Copy.** Neon Console → Branches → *Create branch* from `main` (Head, or
   a past timestamp to rehearse case A). Name it `dr-test-YYYY-MM-DD`. Note
   its endpoint host (`ep-…`) and production's endpoint host.
2. **Compare data.** Run `scripts/dr/verify.sql` on both branches in the SQL
   Editor. Every row must match except `database.restored_at` and
   `database.wal_lsn` (for a past timestamp, expect only the changes made
   since then to differ).
3. **Prove the app runs on it.** On the test branch only, create a role for
   the test and give it the tables (in the SQL Editor, with the test branch
   selected):

   ```sql
   create role dr_app login password '<generate one; do not save it>';
   do $$ declare r record; begin
     execute 'grant dr_app to neondb_owner';
     execute 'grant usage, create on schema public to dr_app';
     for r in select c.oid, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r','S') and pg_get_userbyid(c.relowner) = 'neondb_owner'
     loop
       if r.relkind = 'r' then execute format('alter table public.%I owner to dr_app', r.relname);
       elsif not exists (select 1 from pg_depend d where d.objid = r.oid and d.deptype in ('a','i')) then
         execute format('alter sequence public.%I owner to dr_app', r.relname);
       end if;
     end loop;
   end $$;
   ```

   That role exists only on the test branch, so a mistyped host cannot sign
   in to production with it. Then, from a checkout of this repository with
   `npm ci` done:

   ```bash
   DATABASE_URL='postgres://dr_app:<password>@<test endpoint host>/neondb?sslmode=require' \
   DR_EXPECT_HOST=<test endpoint host> \
   DR_FORBID_HOST=<production endpoint host> \
   npm run dr:smoke
   ```

   It refuses to run unless the host is the test branch's. It starts
   AEROBOOK with no email, push or Blob keys, signs in as a throwaway user,
   reads every record, the history and the team list through the API,
   checks every relationship, removes the throwaway user, and prints counts
   only.

   Where the machine cannot reach Neon directly, run it in a Vercel Sandbox
   whose network allows only the test branch's host and
   `registry.npmjs.org`; bundle the server with
   `npx esbuild server/local.ts --bundle --platform=node --format=esm --packages=external --outfile=server.mjs`
   and pass that file: `node scripts/dr/smoke.mjs server.mjs`.
4. **Record it** in `docs/dr-tests/YYYY-MM-DD.md`: what was restored, from
   when, how long it took, the verify output's counts, the smoke result,
   and anything that did not work.
5. **Clean up.** Delete the `dr-test-…` branch (it holds a full copy of the
   business's data) and stop the sandbox.

## Known weaknesses (as of 2026-10-01)

1. **Six hours of history.** Damage noticed the next morning cannot be undone
   from Neon. Neon's Launch plan allows up to 7 days; Scale up to 30.
2. **No copy outside Neon.** Losing the Neon project, or the Vercel team that
   owns it, loses everything. A nightly `pg_dump` to storage OptiSky controls
   would close this.
3. **Documents have no backup at all.**
4. **Secrets cannot be read back from Vercel**, and losing
   `BETTER_AUTH_SECRET` disables two-step sign-in for everyone who uses it.
5. **One account holds the keys.** The Vercel team, the Neon organization and
   the GitHub repository should each have a second authorized owner.
