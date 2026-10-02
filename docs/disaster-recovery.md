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
| Records, history, sign-in, chat (all of Postgres) | Neon project `polished-fog-50218432` ("neon-rose-basket"), branch `main`, created through the Vercel Marketplace Neon integration on team `nocodo` | Neon's change history (instant restore / branching from the past) | **Yes, but only 6 hours back** — the Free plan's limit. No snapshots or snapshot schedule. A nightly encrypted `pg_dump` off-site is in the repository ([README → Backups](../README.md#backups)), but makes no copies until it has been set up. |
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

The in-app JSON export (Settings → Export everything) is a copy of the shared
records made by hand on one device. It does not include files, accounts, chat
or history. The **company data export** (Settings → Data export, admins only;
see [below](#the-company-data-export)) carries the records, the document
files, the users and the audit log in one ZIP, with a SHA-256 manifest. Both
are copies made by a person on a device: neither runs on its own.

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

None of that infrastructure access comes with being an AEROBOOK admin, and
none of the admin contingency below grants it.

## Admin contingency: naming an admin without the developer

AEROBOOK has three roles: user, admin (manages accounts) and developer (also
decides who is an admin). Without the steps below only a developer can make
someone an admin, which makes the business depend on one person. This is
application access only. It never gives the developer role, never touches a
developer's account, and gives nothing in Vercel, Neon, Blob or GitHub.

**Who may do what**

| Situation | Who | How |
|---|---|---|
| An admin is available | Any admin (or developer) with two-step sign-in on | Settings → Team → the person → *Make an admin…* (or *Take away the admin role…*). The person must already have two-step sign-in on. Confirmed with the admin's own password **and** a current authenticator code. Not for yourself; never a developer. |
| No admin left | Anyone with an AEROBOOK account, access on, two-step sign-in on, **and the admin recovery code** | Settings → Account → *Use an admin recovery code*, with the code, their own password and a current authenticator code. They become an admin; the code is used up. |
| No admin and no code | Whoever holds Neon access | `DATABASE_URL='<production, direct>' npm run admin:recover -- grant <email>` (also `list`, `revoke`). Only between user and admin; never a developer, a password or two-step sign-in. |

**The admin recovery code.** Made by an admin under Settings → Team → *Admin
recovery code* (same password-and-code confirmation), shown **once**. It is
160 random bits, stored only as a SHA-256 hash (`app_admin_recovery`), works
once, and making a new one cancels the old; an admin can also cancel it.
Print it or write it down and give it to the person the business puts in
charge of it; keep it with other business-continuity records, never in
AEROBOOK, email, chat or this repository. After it is used, make a new one.

**Safeguards.** A session an admin is impersonating cannot do any of this.
Five wrong passwords or codes in 15 minutes lock these actions for that
person for 15 minutes; 20 wrong recovery codes an hour, team-wide, stop
redemption for the hour. Better Auth's own role routes stay developer-only,
because they have no such confirmation.

**Audit.** Every grant, removal, recovery-code creation, cancellation, use
and failed attempt, every failed confirmation, and every role change made
through Better Auth (a developer's included) is in `app_audit` under
`security`, with who, whose, and from which role to which — never a password,
a code or the recovery code:

```sql
select at, user_name, action, record_id, summary, before from app_audit
 where collection = 'security'
   and action in ('admin-granted', 'admin-revoked', 'role-changed', 'admin-recovered',
                  'admin-recovery-failed', 'admin-recovery-code-created',
                  'admin-recovery-code-revoked', 'step-up-failed')
 order by id desc;
```

Because every path above needs two-step sign-in, read "Lost
`BETTER_AUTH_SECRET`" below: losing that secret disables everyone's
authenticator at once.

### Secrets

Vercel marks these *sensitive*: once saved, nobody can read them back. Keep a
copy of each in a password manager that the people above can open, and update
it whenever one changes.

| Variable | If it is lost |
| --- | --- |
| `BETTER_AUTH_SECRET` | Everyone is signed out, and **every two-step sign-in becomes unusable** (the TOTP secrets are encrypted with it). Passwords still work. See [Lost `BETTER_AUTH_SECRET`](#lost-better_auth_secret). |
| `CRON_SECRET` | Make a new one; the daily email and maintenance runs resume. |
| `RESEND_API_KEY` | Make a new key in Resend for the verified domain. |
| `VAPID_PRIVATE_KEY` (with `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`) | Make a new pair (`npx web-push generate-vapid-keys`); each device picks it up the next time it opens the app. |
| `DATABASE_URL` and the `PG*`/`POSTGRES_*` set | Re-created by reconnecting the Neon store to the project in Vercel → Storage. |
| `BLOB_STORE_ID` | Re-created by connecting the Blob store in Vercel → Storage. |

### Lost `BETTER_AUTH_SECRET`

What happens (tested in `server/recovery.test.ts`): with a replacement
secret, every session ends; passwords still work; an authenticator code
entered after the password is refused (the server cannot decrypt the stored
secret and answers with an error, never a session).

1. Make a new long random secret (`openssl rand -base64 32`), set it as
   `BETTER_AUTH_SECRET` for Production in Vercel, redeploy, and put a copy in
   the secrets escrow.
2. Someone who can still sign in — an admin or developer **without**
   two-step sign-in, since password alone works for them — resets each
   affected person: Settings → Team → the person → *Reset two-step sign-in*.
   A user cannot; nobody can reset their own. Each reset is in the audit log
   (`two-factor-reset`).
3. If every admin has two-step sign-in (as the admin contingency requires),
   nobody can sign in to do step 2. Someone with Neon access runs the reset
   in README → *Two-step sign-in* ("If the only admin…") for one admin; that
   admin signs in with their password, sets two-step sign-in up again, and
   resets everyone else from Settings.
4. Each person signs in with their password, turns two-step sign-in on again
   (Settings → Account), saves the new backup codes, and from then on signs
   in with password and the new code.

No business data changes. Keeping the secret in escrow avoids all of this.

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
2. If the nightly backup has been set up ([README → Backups](../README.md#backups)),
   restore the latest file into a new Neon store as described there (README
   → *Restoring*), run `scripts/dr/verify.sql` on it, and point Production's
   `DATABASE_URL` at it. Uploaded documents' files are not in that backup.
3. If there is nothing to recover and no backup, there is **no copy of the
   database anywhere else**. Create a new Neon store in Vercel → Storage,
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
- If the Blob store itself is lost, the files cannot be recovered from
  AEROBOOK's infrastructure: there is no backup of it. The only other copy is
  the most recent **company data export**, if one was made and kept. The
  records stay, and opening one fails. `scripts/dr/verify.sql` reports how
  many document records point at a file (`documents.with_blob_path`) and a
  checksum of those paths, so you can at least list what is missing.

## The company data export

Settings → Data export → *Export Company Data* (admins only). Built in the
admin's browser from the live app: records through the normal sync,
documents one at a time through the signed-in file route, users, comments
and the audit log from admin-only routes. Nothing is kept on the server; the
only thing it writes is one `company-export` entry in the audit log. The ZIP
is **not encrypted**: it is the whole company's data, so store it only where
the business keeps confidential records, and delete old copies.

**What it contains:** contacts (every field), aircraft and every past owner,
opportunities, insurance policies, activities, notes (from every place a
note is written), tasks, aircraft comments, document metadata **and the
document files**, users (name, email, role, access, whether two-step sign-in
is on), the audit log, email templates, import history, and
`aerobook-backup.json` (every record and link, restorable under Settings →
Restore from a full export). README.txt inside explains how the files join.

**What it deliberately leaves out:** passwords and password hashes,
sessions, two-step secrets, server keys; deleted records and earlier
versions of records (`app_audit.before`); deleted comments and earlier
versions of comments; chat. Those are only in the database (and its
backups).

**`manifest.json`** (added 2026-10-02): the path, size in bytes and SHA-256
of every other file in the package, computed over the exact bytes zipped,
sorted by path. Format:

```json
{
  "format": "aerobook-company-export-manifest",
  "version": 1,
  "algorithm": "SHA-256",
  "exportedAt": "2026-10-02T12:00:00.000Z",
  "files": [{ "path": "README.txt", "bytes": 3001, "sha256": "…" }, …]
}
```

Exports made before this change have no manifest.

### Checking an export

1. Just before exporting, with nobody editing, run
   `scripts/dr/export-expected.sql` on production (Neon SQL editor, or
   `psql -X -A -t -f`) and save the result as `expected.json`. It holds counts
   and each document's id and size — no contents.
2. Make the export.
3. From a checkout of this repository (`npm ci` once):

   ```bash
   npm run verify:export -- aerobook-company-export-YYYY-MM-DD.zip --expect expected.json
   ```

It checks, and exits 1 with the reason if any fails: the ZIP opens and every
file's CRC-32 matches; every file the export always has is present; every
file matches its SHA-256 in the manifest, nothing is there the manifest does
not list, and nothing appears twice; the JSON backup and the spreadsheets
list the same records; every link between records resolves; every document
record has its file, at `documents/<id>/<name>`, with the size its record
says, and no other file is under `documents/`; and the counts and every
document's id and size match `expected.json`. It prints counts, document
IDs, sizes and SHA-256s only. `--allow-no-manifest` checks an export made
before manifests existed for everything except the SHA-256 comparison.

Neither Blob nor the database keeps a hash of each document as uploaded, so
the check against production is presence and size; the SHA-256s prove the
copy has not changed since it was exported.

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

### The automated drill

`server/recovery.test.ts` (run by `npm run test:server`, with a throwaway
Postgres) does the restore end to end on every run: data goes in through
the app, the database is copied with `create database … template`, the app
starts on the copy, and it checks `scripts/dr/verify.sql` row for row;
sign-in with two-step codes and roles; every contact, aircraft, opportunity,
policy, activity, follow-up and document record field for field; the audit
log and earlier versions; every document byte for byte; and a company data
export verified against its manifest and `export-expected.sql`. It also
shows that the database alone does not bring documents back, and runs both
lost-`BETTER_AUTH_SECRET` recoveries above (admin reset, and the SQL reset)
through to a sign-in with password and a new code. It uses local Postgres
and a local folder for documents, not Neon or Blob.

## Status (as of 2026-10-02)

| | Implemented | Tested | In production | Needs someone to act |
|---|---|---|---|---|
| Admin designation by an admin, recovery code, `admin:recover`, audit | Yes | Yes (`server/admin-roles.test.ts`) | **Not until this code is deployed from `main`** | An admin turns on two-step sign-in, makes the recovery code, hands it to the custodian |
| Company data export with documents | Yes | Yes | Yes | An admin makes one and keeps it |
| SHA-256 manifest and `verify:export` | Yes | Yes (`src/lib/exportVerify.test.ts`, drill) | **Not until deployed** | Make a production export and run the check |
| Restore drill incl. lost secret | Yes | Yes (`server/recovery.test.ts`) | n/a | Repeat the manual test above regularly |
| Neon restore into a branch | — | Manually 2026-10-01 and 2026-10-02 ([dr-tests/](dr-tests/)) | Yes | — |
| Nightly encrypted database backup | Yes | `npm run test:backup` | **Has never run**: GitHub only runs scheduled workflows from the default branch, which is not `main` | Make `main` the default branch; finish setup (README → Backups); run it once |
| Document files outside Vercel Blob | Only via a company data export | — | — | Make and keep exports |
| Second owner of Vercel, Neon, GitHub | — | — | No (one person holds them) | Add one |
| Secrets escrow | — | — | Unverified | Record them in a shared password manager |

AEROBOOK is **not** fully recoverable without its developer until the items
in the last column are done.

## Known weaknesses (as of 2026-10-01)

1. **Six hours of history.** Damage noticed the next morning cannot be undone
   from Neon. Neon's Launch plan allows up to 7 days; Scale up to 30.
2. **No copy outside Neon, until the nightly backup is set up.** Losing the
   Neon project, or the Vercel team that owns it, loses everything. The
   nightly encrypted `pg_dump` to separate, locked storage
   ([README → Backups](../README.md#backups)) closes this once its bucket,
   keys and GitHub environment exist; it covers the database, not documents.
3. **Documents have no backup at all.**
4. **Secrets cannot be read back from Vercel**, and losing
   `BETTER_AUTH_SECRET` disables two-step sign-in for everyone who uses it.
5. **One account holds the keys.** The Vercel team, the Neon organization and
   the GitHub repository should each have a second authorized owner.
