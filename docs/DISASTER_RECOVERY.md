# AEROBOOK Disaster Recovery

How OptiSky / OptiSurance keeps using AEROBOOK, and gets all of its data back,
without depending on any one person. Written so that a technically competent
person who has never worked on AEROBOOK can follow it.

No credential or secret value appears in this document. Where one is needed,
it says which one and where it lives.

| | |
|---|---|
| **Last verified** | 2 October 2026 (see section E) |
| **Applies to** | The production deployment: Vercel project `aerobook`, Neon project `neon-rose-basket`, Vercel Blob store `store_uXMjOtS8GAu1DmC5` |
| **Re-verify** | Every quarter, after any change to hosting, and after any recovery |

---

## A. What is backed up

Everything AEROBOOK knows, except the document files themselves, is in one
Postgres database hosted by **Neon**. The database is protected by Neon's own
backup features, not by anything AEROBOOK adds:

- **Point-in-time history**: Neon can restore the database to any moment in
  the last **6 hours** (the project's current plan setting,
  `history_retention_seconds = 21600`).
- **Snapshots**: a snapshot is a copy of the database at one moment, kept
  until deleted. The project has **no automatic snapshot schedule** today.
  One manual snapshot, `dr-verify-2026-10-02`, was taken for the recovery test
  in section E.
- Neon encrypts the storage behind the database at rest, with keys Neon
  manages. AEROBOOK does not add its own backup encryption, so there is no
  separate backup key to keep. The one secret that matters for restored data
  is `BETTER_AUTH_SECRET` (see C).

What is in the database, and so in every Neon backup:

| Data | Where in the database |
|---|---|
| Contacts: every field, custom fields and "what they want" | `app_record`, collection `contacts` |
| Aircraft, with current and previous owners | `app_record`, `aircraft` |
| Opportunities and insurance policies | `app_record`, `opportunities`, `policies` |
| **Notes**: activities (calls, emails, meetings, notes) linked to contacts, aircraft and opportunities | `app_record`, `activities` |
| The notes field on each contact, aircraft, opportunity and policy | inside each record |
| Follow-ups and tasks, with who they are for | `app_record`, `followUps` |
| **Document metadata**: name, type, size, category, what each is attached to, where its file is stored | `app_record`, `files` |
| Email templates, import history, each person's settings | `app_record`, `templates`, `imports`, `settings` |
| Aircraft comments, their earlier versions and deletions | `app_aircraft_comment`, `app_aircraft_comment_revision` |
| Chat conversations and messages | `app_conversation`, `app_conversation_member`, `app_message` |
| User accounts, roles, password hashes, access on/off, deleted people | `"user"`, `account`, `app_deleted_user` |
| Two-step sign-in secrets and backup codes (encrypted with `BETTER_AUTH_SECRET`) | `"twoFactor"` |
| **Audit data**: every create, edit and delete with the record as it was before, and every sign-in security and role event | `app_audit` |
| Documents deleted in the last 30 days (the list; the files are in Blob) | `app_file_trash` |
| The admin recovery code, as a hash only | `app_admin_recovery` |
| Notifications, push subscriptions, read markers, sessions | their own tables |

## B. What is NOT backed up

Do not claim 100% recovery while any of these is unaddressed.

1. **Document files.** The files are in **private Vercel Blob storage**, not in
   Postgres. Restoring the database brings back each document's *record*
   (name, size, links, storage path), **not the file**. AEROBOOK does not
   back up the Blob store, and Vercel Blob keeps no version history. The only
   protections are:
   - a deleted document's file stays in Blob for **30 days** (the trash) and
     comes back if its record is restored in that time;
   - the **complete archive** (Settings → Data → *Export complete archive*,
     admins only) contains every file. It is the only copy outside Blob, and
     only as recent as the last time an admin made one.
2. **Anything older than 6 hours, outside a snapshot.** Neon cannot restore
   the database to a moment more than 6 hours ago unless a snapshot was taken
   then. Within the database, `app_audit.before` still keeps every earlier
   version of every record (see the README, "Activity history"), which covers
   most mistakes. A database lost or corrupted as a whole, and noticed after
   6 hours, can only be rebuilt from the latest snapshot or complete archive.
3. **Vercel settings and secrets.** Environment variables are not in any
   backup. `BETTER_AUTH_SECRET`, `CRON_SECRET`, `RESEND_API_KEY` and
   `VAPID_PRIVATE_KEY` are stored as *sensitive*: Vercel will not show them
   again, even to an owner. If one is lost, a new one is made (C explains
   what that costs).
4. **Documents only in someone's browser.** A document attached while
   offline (or before cloud storage) stays on that device until the app
   uploads it. At verification there were **none** (all 10 production
   documents had a storage path).
5. **Copies outside AEROBOOK**: CSV and JSON exports, complete archives, the
   daily email, device caches. They are not backups, and are governed by the
   Customer Information Storage Policy (`docs/data-handling-policy.md`).

Intentionally **not in the complete archive** (still in the database
backup): chat messages (private to their members), deleted comments and
earlier comment versions, other people's personal settings, the audit log,
and account data. The archive is the business's records; the database is
everything.

## C. Recovery dependencies

| System | What it holds | Needed to | Held by (at verification) |
|---|---|---|---|
| **Vercel** team `nocodo`, project `aerobook` | Hosting, environment variables and secrets, the cron jobs, the Blob store, the Neon integration | Keep AEROBOOK running; reach documents; restore anything | Scott's Vercel account: the team's only member, as Owner |
| **Neon** project `neon-rose-basket` (`polished-fog-50218432`), org "Vercel: nocodo" | The database and its backups | Restore the database; run the recovery script; run the fingerprint | Created through the Vercel integration under Scott's account |
| **Vercel Blob** store `store_uXMjOtS8GAu1DmC5` (production) | Document files | Read or restore any document file | Inside the Vercel team above. The production deployment reaches it through Vercel's OIDC token; there is no read-write token stored anywhere |
| **GitHub** `scottyfncodes/AEROBOOK` | Source code | Redeploy, or rebuild somewhere else | Scott's personal GitHub account |
| **`BETTER_AUTH_SECRET`** | Signs sessions; encrypts two-step sign-in secrets | Keep two-step sign-in working on restored data | Vercel only, marked sensitive (cannot be read back). If it must be replaced: everyone is signed out, passwords still work, and everyone's two-step sign-in must be reset (README, "Two-step sign-in") |
| **Admin recovery code** | One-time code that makes someone an admin | Name an admin when none is left | Made by an admin; kept offline by OptiSky's designated custodian |
| Domain / DNS | none: AEROBOOK uses Vercel's own addresses (`aerobook-three.vercel.app`) | — | — |
| Resend (daily email), VAPID keys (push) | Optional services | Daily email and push only; AEROBOOK works without them | Vercel environment variables |

**The remaining single point of failure is account access, not the
software.** Every infrastructure account above was, at verification, in
Scott's name. Until OptiSky holds its own access (section F), recovery from
anything worse than "the app is running and an OptiSky admin can sign in"
needs Scott.

## D. Recovery procedures

### D1. Scott is unavailable; AEROBOOK is running

Nothing to restore. An OptiSky admin carries on:

1. Sign in, and make sure **two-step sign-in is on** (Settings → Account). The
   admin-contingency actions below all need it.
2. To make someone else an admin: they turn on two-step sign-in first; then
   **Settings → Team → their name → Make an admin…**, and confirm with your
   password and the code from your authenticator app. Taking the role away
   is the same button. Developers cannot be changed this way; nothing here
   can make anyone a developer.
3. If no admin recovery code exists, make one: **Settings → Team → Admin
   recovery code → Make a code**. Print or write it down and give it to
   OptiSky's designated custodian (for example, in the company safe or the
   business password manager). It is shown once, works once, and making a new
   one cancels the old.
4. Make a **complete archive** (Settings → Data → *Export complete archive*)
   and store it where the storage policy says. Repeat at least monthly.

### D2. No admin can sign in

In order of preference:

1. **Admin recovery code.** Someone with an AEROBOOK account signs in, turns
   on two-step sign-in if it is not on, and chooses **Settings → Account →
   Use an admin recovery code**. They enter the code, their password and a
   current authenticator code. They become an admin; the code is used up
   (make a new one straight away, D1 step 3).
2. **A developer** (if one is reachable) sets the role under Settings → Team.
3. **Database access** (needs Neon access). From a checkout of the repository:

   ```bash
   npm ci
   DATABASE_URL='<Neon connection string for the production branch>' npm run admin:recover -- list
   DATABASE_URL='<…>' npm run admin:recover -- grant someone@optisky.example
   ```

   It only moves an existing person with access between user and admin,
   never touches a developer, a password or two-step sign-in, and records
   the change in the audit log as "Database (admin-recover script)".

   If that person has also lost their authenticator, reset it first with the
   SQL under "Two-step sign-in" in the README.

Every one of these is recorded in `app_audit` (collection `security`):

```sql
select at, user_name, action, record_id, summary, before from app_audit
 where collection = 'security'
   and action in ('admin-granted', 'admin-revoked', 'role-changed', 'admin-recovered',
                  'admin-recovery-failed', 'admin-recovery-code-created',
                  'admin-recovery-code-revoked', 'step-up-failed')
 order by id desc;
```

### D3. Data was damaged or deleted

- **One or a few records, any age:** put back the last good version from
  `app_audit.before` (README, "Activity history"). A document's file comes
  back with its record if it is still in the 30-day trash.
- **Much of the database, within the last 6 hours:** restore with Neon, into
  a new branch first, never straight over production:
  1. Neon console → project → *Branches* → *Create branch*, from `main`,
     *Past data*, at a time just before the damage (or *Snapshots* →
     restore a snapshot as a new branch).
  2. Run the fingerprint (section E) on the new branch and on `main`, and
     check the difference is what you expect.
  3. When it is right, make the restored branch the default (Neon: *Set as
     default* / *Restore* → *finalize*), so the production connection string
     serves it. Keep the old branch until you are sure.
  4. Redeploy nothing: AEROBOOK reads whatever the connection string serves.
- **Everything, older than 6 hours, with no snapshot:** restore the latest
  complete archive (D4, steps 4–7).

### D4. The hosting is gone (or OptiSky must move AEROBOOK)

1. Get the source code (GitHub, or any clone of it).
2. Create a Postgres database (Neon is what AEROBOOK uses) and a Vercel
   project from the repository. Set `DATABASE_URL`, a new long random
   `BETTER_AUTH_SECRET`, a `SETUP_TOKEN`, and connect a **private** Blob
   store (README, "Deployment").
3. If a database backup survives (a Neon snapshot or branch, or a `pg_dump`),
   restore it into the new database and **reuse the old
   `BETTER_AUTH_SECRET` if anyone still has it**; otherwise everyone's
   two-step sign-in must be reset. Skip to step 7.
4. With no database backup, run `npm run db:migrate`, open the app, and
   create the first account on the setup screen with `SETUP_TOKEN`.
5. Settings → Data → **Restore from a full export**, choosing
   `aerobook-data.json` from the latest complete archive. This restores every
   record and link. Recreate each person's account under Settings → Team.
6. Documents: the files are in the archive under `documents/<document id>/`,
   and `csv/documents.csv` says which record each belongs to. AEROBOOK has
   no bulk re-upload: attach each file again to its record, then delete the
   old document record (its storage path points at the lost store). This
   is the slowest step; the files themselves are not lost.
7. Verify (section E).

## E. Verifying a recovery

### The checks

1. **Fingerprint the database.** `scripts/recovery-fingerprint.sql` is
   read-only and prints only counts and hashes, never customer data:

   ```bash
   psql "$DATABASE_URL" -f scripts/recovery-fingerprint.sql
   ```

   Run it on the source and the restored copy. Every row must match. Rows
   cover each record collection (live and deleted, ID set and content),
   every kind of link between records (`extra` = links pointing at nothing),
   document storage paths, the trash, comments and their history, chat,
   users and roles, password hashes (hashed again), two-step sign-in, and
   the audit log per collection. Nothing written after the backup was taken
   should match, and only that should differ.
2. **Check the app.** Sign in (with two-step sign-in), check the roles under
   Settings → Team, open some contacts, aircraft and documents.
3. **Check the documents and the export.** Make a complete archive in the
   restored app and run:

   ```bash
   npm run verify:archive -- aerobook-complete-archive-YYYY-MM-DD.zip
   ```

   It checks every file's checksum, every document's size and SHA-256, every
   record against the manifest, and every link, and exits non-zero if
   anything is missing. Its `ids sha256` lines must equal the
   `live_ids_sha256` column of the fingerprint for the same collections
   (`comments:exportable` for comments).
4. **The automated drill.** `server/recovery.test.ts` runs all of this on
   every CI build against a throwaway database: data goes in through the
   app, the database is copied, the app runs on the copy, and sign-in,
   roles, records, links, document bytes, audit history and the archive are
   all checked against the fingerprint. It also proves that a database
   restored without its document storage does **not** bring documents back,
   and that two-step sign-in needs the same `BETTER_AUTH_SECRET`.

### Results of the 2 October 2026 test

Production was snapshotted (`dr-verify-2026-10-02`) and the snapshot
restored as a separate Neon branch (`dr-verify-2026-10-02`, id
`br-delicate-flower-b7wmlo8a`; production's `main` branch was not changed).
The fingerprint was taken on both.

| Check | Production | Restored | Match |
|---|---|---|---|
| Contacts (live / deleted) | 117 / 1 | 117 / 1 | IDs and contents identical |
| Activities and notes | 134 / 3 | 134 / 3 | identical |
| Aircraft | 118 / 3 | 118 / 3 | identical |
| Opportunities / policies / follow-ups | 2 / 0 / 3 | 2 / 0 / 3 | identical |
| Templates / imports | 12 / 1 | 12 / 1 | identical |
| Document records (all with a storage path) | 10 (1 deleted, 1 in trash) | 10 (1 / 1) | identical, same paths and sizes |
| Links between records | 404, 0 broken | 404, 0 broken | identical |
| Aircraft comments | 1 (deleted) | 1 | identical |
| Chat | 2 conversations, 8 messages | same | identical |
| Users: developer / admin / user | 1 / 1 / 3 (2 deleted) | same | identical, password hashes identical |
| Two-step sign-in enrolments | 1 | 1 | identical |
| Audit log rows | 454 (highest id 454) | 454 | identical, every `before` identical |

All 43 fingerprint checks matched exactly.

**What that test did not cover, and why:**

- **Running the app against the restored branch.** The test environment
  could not connect to Neon directly, and was not permitted to use the
  production database credential. The app-level checks (sign-in, roles,
  records, document bytes, export) were instead run by the automated drill
  in `server/recovery.test.ts` on a copied database. To close this, run D3
  steps 1–2 and E 2–3 against a restored branch with a Preview deployment
  or `npm run serve`.
- **Document files.** The production Blob store can only be read by the
  production deployment (OIDC) or with a read-write token, and neither was
  available to the test. **The 10 production document files were not read
  or hashed.** Verify them by making a complete archive in production and
  running `npm run verify:archive` on it: it reports any document whose file
  is missing or does not match its record.
- **Two-step sign-in on the restored data** needs production's
  `BETTER_AUTH_SECRET`, which is stored as sensitive in Vercel and was not
  read. The restored branch has the same encrypted secrets; the drill shows
  they work with the same key and not with another.

## F. Ownership and access

These are four separate things. Losing one must not cost another.

| | What it is | Who should hold it |
|---|---|---|
| **AEROBOOK software / code** | The source code in GitHub, and the right to change and deploy it | Its author (Scott). Unchanged by this document. OptiSky should hold a current copy of the repository (or read access) so that D4 is possible |
| **OptiSky / OptiSurance business data** | The contacts, aircraft, policies, notes, follow-ups, documents and comments the team entered | OptiSky. Its admins can see and export all of it (complete archive) at any time, with no developer involved |
| **Infrastructure access** | Vercel (hosting, secrets, Blob), Neon (database and backups), GitHub | At verification, Scott alone. **OptiSky should be given its own access**: an OptiSky owner as a member (Owner role) of the Vercel team, which also carries the Neon integration and the Blob store, and access to the Neon organization. This is what D3 and D4 need |
| **Emergency administrative access** | Becoming an AEROBOOK admin when none is left | OptiSky's designated custodian of the admin recovery code (D2.1); failing that, whoever holds Neon access (D2.3) |

Being an AEROBOOK admin gives no access to Vercel, Neon, GitHub or the
source code, and holding those gives no AEROBOOK account. Each is granted
separately.

### Open actions (as of 2 October 2026)

1. Give OptiSky its own access to the Vercel team and the Neon project (F).
   **Until this is done, OptiSky cannot recover from a hosting or database
   failure without Scott.**
2. Turn on two-step sign-in for the production admin account. At
   verification only the developer account had it, and every
   admin-contingency action needs it.
3. Make an admin recovery code and hand it to the custodian (D1.3).
4. Make and verify a complete archive in production (E.3); repeat monthly.
5. Turn on scheduled Neon snapshots, or extend point-in-time history beyond
   6 hours (both need a paid Neon plan), so that damage noticed after 6 hours
   can be undone.
6. When the verification branch and snapshot `dr-verify-2026-10-02` are no
   longer wanted, delete them in the Neon console. They hold a full copy of
   the customer data (see the storage policy, section 7).
