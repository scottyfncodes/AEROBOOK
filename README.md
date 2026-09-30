# AEROBOOK

A CRM for an aircraft broker who also sells aviation insurance, shared by a
small team (sized for up to about ten people).
Aircraft and insurance policies are first-class records, not custom fields on
a contact.

The chain it exists to make fast:

> person → aircraft → insurance → opportunity → activity → follow-up →
> documents → outcome

Open any aircraft and the first thing on the screen answers who owns it, where
its insurance stands, what is happening with it commercially, and what the next
move is. Open any contact and it answers what they have, what they *want*, and
when you next owe them something.

## Running it

Everything needs a Postgres database. Put these in `.env.local`:

```bash
DATABASE_URL=postgres://...            # any Postgres; Neon in production
BETTER_AUTH_SECRET=...                 # long random string: openssl rand -base64 32
SETUP_TOKEN=...                        # only needed to create the first admin
```

```bash
npm install
npm run db:migrate   # create the tables
npm run dev          # app and API together on one port
npm test             # 367 tests; the 60 API and sync tests also need:
npm run test:server  #   TEST_DATABASE_URL (a throwaway database — it is wiped)
npm run build        # production build into dist/
npm run serve        # serve the build and the API the way Vercel does
npm run e2e          # drive it in Chromium at iPhone dimensions
```

`npm run e2e` expects `npm run serve` running against an **empty** database
with `SETUP_TOKEN=e2e-setup-token`; it creates the first admin itself, and
takes `BASE_URL` and `CHROME_PATH` from the environment.

`npm run build` needs nothing but Node. Chromium and potrace are only used by
the brand script below, which is not part of the build.

## How it is put together

```
api/index.ts      the one Vercel Function; every /api path lands here
server/           the API: sign-in, sync, first-time setup
  auth.ts         Better Auth — invite-only email and password, admin/user
  sync.ts         pull and push of records, with versions and history
  app.ts          routing, and who may do what
db/schema.sql     the whole database schema
src/lib/          domain logic, all pure and tested
  csv.ts          RFC 4180 reader that never throws on malformed input; the
                  writer defuses cells a spreadsheet would run as formulas
  documents.ts    the kinds of file kept as documents
  mapping.ts      scored header detection onto AEROBOOK fields
  names.ts        owner-name parsing (FAA lists are last-name-first)
  tail.ts         tail-number normalisation
  matching.ts     duplicate detection indexes
  importer.ts     preview (pure) and apply (writes) — same code path
  email.ts        template rendering and mailto building
  insurance.ts    renewal state, countdowns and what needs attention
  search.ts       one index across contacts, aircraft and opportunities
  aviation.ts     ISA atmosphere, wind triangle, weight and balance, premiums
  links.ts        external links, built from stable endpoints only
src/data/         types, the store, cloud sync, the device cache
src/components/   shared UI
src/screens/      one file per screen
```

## Insurance

A policy is its own record, attached to the aircraft it covers and the person
who holds it. An opportunity is optional — a renewal is visible long before
anyone decides to work it as a deal.

Its state is **derived from the expiration date, not typed in**: a policy that
lapsed last week reads as expired whatever was last selected. The three states
only the user can know — renewal in progress, quote received, bound — are kept
as chosen. Inside sixty days the countdown reads *"Renewal in 43 days"*; beyond
that it reads as a date, because a count that large is not a countdown.

## Accounts

There is no sign-up. The first admin is created once, on the setup screen,
with the `SETUP_TOKEN` set on the deployment; after that, an admin adds each
person under **Settings → Team**, sets or resets their password, makes them
an admin, or turns their access off. Turning access off keeps their name on
everything they recorded. Someone whose access is off is told *"Invalid email
or password"* whatever they type, exactly as for a wrong password, so a
guessed password is never confirmed. Sign-in attempts are rate-limited.

### Two-step sign-in (admins)

An admin can turn on **two-step sign-in** under **Settings → Account**: after
the password, signing in also needs the six-digit code from an authenticator
app (Google Authenticator, Microsoft Authenticator, 1Password and the like).
Setup asks for the password, shows a QR code (and the key to type in by
hand), shows ten single-use backup codes once, and only turns on when a code
from the app has been entered. Turning it on signs that admin out on every
other device, so a session made with the password alone does not outlive it.

- Signing in: the right password gives no session, only a ten-minute
  challenge; the code (or a backup code, once each) completes it. Five wrong
  codes end the challenge, ten in a row lock two-step sign-in for fifteen
  minutes, and the endpoints are rate-limited. "Trust this device" is refused:
  every sign-in needs the code. A wrong password is answered the same whoever
  the account belongs to, so it does not show who has it on.
- Only admins can turn it on. Someone who had it on as an admin keeps it if
  they stop being one. Ordinary users sign in as before.
- New backup codes and turning it off each need the password.
- Lost phone and backup codes: another admin opens that person under
  **Settings → Team → Reset two-step sign-in**. It turns it off, signs them out
  everywhere and ends a sign-in waiting for its code; they sign in with their
  password and set it up again. An admin cannot reset their own.
- The secret and backup codes are stored in the `twoFactor` table encrypted
  with `BETTER_AUTH_SECRET`. Changing that secret therefore also stops every
  authenticator working: everyone with two-step sign-in has to be reset.
- Every step is written to `app_audit` under the collection `security` (who,
  what, whose account; never a code or a secret) and kept out of the activity
  history everyone reads:

```sql
select at, user_name, action, record_id, summary from app_audit
 where collection = 'security' order by id desc;
```

If the **only** admin loses their phone and backup codes, there is no one to
reset it in the app; someone with database access does it:

```sql
begin;
delete from "twoFactor" where "userId" = '<their user id>';
update "user" set "twoFactorEnabled" = false where id = '<their user id>';
delete from session where "userId" = '<their user id>';
delete from verification where identifier like '2fa-%' and value = '<their user id>';
insert into app_audit (user_id, user_name, action, collection, record_id, summary)
values (null, 'Database', 'two-factor-reset', 'security', '<their user id>', 'Reset two-step sign-in');
commit;
```

### What everyone shares

Everyone sees and edits the same contacts, aircraft, opportunities, policies,
timeline, follow-ups and templates. Each person has their own profile (the
signature on their emails) and appearance setting. Restoring a backup and
erasing everything affect the whole team, so only admins see them.

The server holds that line too, whatever a browser is made to send: someone
who is not an admin may delete at most 100 records in any hour (a contact with
all their notes is a few dozen). A save that would go past that has none of
its deletions made — the records come back to that person's screen with a
message to ask an admin — while the rest of it is saved as usual. Every
change also keeps what the record held before it (see Activity history), so a
mistaken or malicious edit or deletion can be put back.

## Follow-ups

Every follow-up can be for someone: whoever creates one owns it unless they
pick someone else under **For**, and **Edit** hands it to another person or
back to nobody. Unassigned follow-ups — including everything recorded before
accounts — count as everyone's until someone takes one.

The follow-up list has three views: **Mine** (your own and the unassigned),
**All** (the whole team's), and **Overdue** (the whole team's that have
slipped). Home counts only Mine. When a follow-up is completed and the next
one scheduled, the next one stays with the same person. Names come from
`GET /api/team`, which any signed-in person may call; managing accounts stays
admin-only.

## Documents

A document is a record in the shared data (name, type, size, what it is
attached to) plus the file in **private Vercel Blob storage** — never in
Postgres, never at a public URL. The browser uploads straight to Blob with a
short-lived token from `POST /api/files/upload`, which is only issued to
someone signed in and only for a path under `files/`, up to 25 MB, never
replacing a file already stored. Only the kinds of file AEROBOOK keeps are
accepted — PDF, photos (JPEG, PNG, HEIC, WebP, GIF, TIFF), Word, Excel, plain
text and CSV (`src/lib/documents.ts`); the app refuses anything else before
uploading, and the token itself carries the list, so Vercel Blob refuses it
too. Opening a document goes through `GET /api/files/content`, which checks
the session and that a document record points at that file, and always serves
it as a download, as its own type only when that is one of those kinds.
Deleting the document's record stops the file being served at once; the file
itself waits in `app_file_trash` for 30 days, so the document
can be restored, and is then removed by the daily maintenance run
(`GET /api/maintenance/run`, called by Vercel Cron with `CRON_SECRET`, like the
daily email). A file any document record points at again is never removed,
so a second record naming another document's file cannot be used to delete
it. Without `CRON_SECRET` nothing is ever removed from storage.

A document attached before cloud storage (or while offline) stays in that
browser until it can be moved up, which the app does on its own the next time
it opens. Without `BLOB_READ_WRITE_TOKEN` the app keeps documents in the
browser as it used to; `npm run serve` and `npm run dev` use a `.local-files`
folder instead.

## Daily email

Each morning everyone gets an email of their own follow-ups (the Mine list:
theirs plus the unassigned): overdue, due today, and the next seven days, with
a button into the app. Nobody gets an empty one, nor one while their access is
off, and anyone can turn theirs off under **Settings → Daily email**, where
**Send me today's email now** sends a copy to their own address on demand.

Vercel Cron calls `GET /api/digest/run` daily at 14:00 UTC (7am in Los Angeles
in summer, 6am in winter) with `CRON_SECRET` as a bearer token; the route
refuses anything else. The "day" is the calendar day in `DIGEST_TIME_ZONE`
(default `America/Los_Angeles`). A row in `app_digest` per person per day, and
Resend's idempotency key, mean a repeated run sends nothing twice; a failed
send is retried by the next run. Mail goes through Resend from
`DIGEST_FROM` (default `AEROBOOK <digest@optibook.cloud>`); without
`RESEND_API_KEY` nothing is sent.

## Activity history

**Settings → Activity history** lists every change anyone on the team saved,
newest first, grouped by day: "Scott edited aircraft N917JH", linked to the
record while it still exists and saying what a note or follow-up was on. A
burst of the same thing — an import creating a hundred contacts — reads as one
line with a count that expands.

It is read-only. It comes from `app_audit`, which the server writes as each
change is saved (see Data); `GET /api/history` returns it in pages of 100 to
anyone signed in and answers any other method with 405. Personal settings are
never recorded, and neither are sign-in and account security events, which
share the table under the collection `security` (see Accounts).

Each row also keeps, in `before`, the whole record as it was before that
change — nothing for a creation. It is not sent to the app; it is there so
an admin with database access can put a record back:

```sql
-- The last version of a deleted or overwritten record, as it was.
select at, user_name, action, before from app_audit
 where collection = 'contacts' and record_id = 'con_…' order by id desc;
```

Writing that `before` back as the record (with the next version number)
restores it, and restores a document's file too while it is still in the
trash.

## Data

The app still keeps the whole dataset in memory — a few thousand records —
and every screen reads it synchronously. What changed is where it is saved.

Each record is a row in Postgres (`app_record`), stored as the same JSON the
app works with, with a version number. After every change the app compares
the new state with what the server last agreed and sends only the records
that differ, each with the version it was edited from. If someone else saved
that record first, theirs stands and the app says so. Other people's changes
arrive when the app regains focus and every 30 seconds. Every create, edit
and delete is also written to `app_audit` with who did it, for the activity
history to come.

A copy is cached on the device, so the app opens offline — marked as such —
and changes that were on their way when the app closed are sent the next time
it opens.

**Documents** are records like the rest, with the file itself in private
cloud storage (see Documents).

A device that used AEROBOOK before accounts shows a one-time **Upload** banner
while the account is still empty, and sends everything it held.

## Things it deliberately does not do

- **It never says an email was sent.** AEROBOOK has no mail integration, so an
  email is recorded as *prepared*, *opened in mail* or *copied*.
- **It ships no aviation data.** Aircraft performance, airport details and
  registrations come from the authoritative source via a link, not from a copy
  that can go stale. The calculators work on numbers the user types.
- **It never discards a CSV column.** Anything unrecognised is kept as custom
  data on the record.
- **It never silently overwrites.** An import that would replace an existing
  value shows the conflict and waits for a decision.
- **It never makes a document public.** Files sit in private storage and are
  only ever read through the app, by someone signed in. The JSON backup
  carries the list of them, not the files, and the screens say so.
- **It has no notifications.** Reminders are in-app, on the home screen and the
  task list, because a browser cannot deliver a background notification on iOS
  reliably enough to build a working day on.

## The supplied sample file

`sample-data/owners-cirrus-design-corp-sr22t.csv` (117 aircraft) is used as a
real acceptance test in `src/lib/acceptance.test.ts`: the file is read off
disk and run through the same parser, detector, preview and importer the UI
uses. It asserts 117 aircraft, 115 contacts (two owners hold two aircraft
each), the email subject, greeting and mailto, and that re-importing the same
file creates nothing.

`e2e-check.mjs` drives the built app in Chromium at iPhone dimensions and walks
the journeys the app exists for, through the real UI: import, search by a
lowercase tail, generate and record an email, set a follow-up, add an insurance
policy and check the renewal countdown, open a brokerage opportunity and move
it through the pipeline, record what an owner wants, create a client and their
aircraft from scratch, reload, re-import and export. It fails on any console
error, any horizontal overflow at 390px, or any link without a destination.

## Upgrading

Version 2 of the stored document lifted insurance out of the opportunity it
used to hang off, and turned the opportunity's unused `followUpDate` into a
real follow-up. The migration runs on load *and* on restoring a backup, so an
older export can still be read. Two vocabulary changes come with it: the
opportunity statuses `Open` and `Quote` became `Lead` and `Quoting`, `Closed`
became `Lost` — which is how every query already treated it — and the ambiguous
`Both` type became `Sale + Insurance`.

## Brand

AEROBOOK is its own product, dressed in the same house style as OPTISKY —
the palette and typeface below — but it carries no OPTISKY emblem or
tagline.

| Colour | Hex | Use |
| --- | --- | --- |
| Navy | `#0B2D4A` | dark-mode surfaces, light-mode text, icon tile |
| Slate | `#5B6770` | secondary text |
| Gold | `#C9A96B` | the one accent colour, the icon's jet |
| Ivory | `#F7F7F5` | light-mode paper, dark-mode text |

Type is Montserrat (self-hosted via `@fontsource-variable/montserrat`, so it
works offline). All of it lives as tokens in `src/styles/tokens.css`.

The logo is the name alone: a widely spaced "AEROBOOK" wordmark
(`src/components/Brand.tsx`). The home-screen icons are a gold jet on the
navy tile. The footer sign-off is the owner's own signature, traced from
`brand-source/signature.jpg`.

```bash
npm run brand      # regenerates public/brand/: icons, signature
```

The icons are drawn from geometry in `scripts/build-brand.mjs`; edit them
there, never the output files. The script needs Chromium (icon rendering and
the signature's ink matting) and `potrace` (the signature trace), neither of
which the normal build touches — outputs are committed.

## Deployment

Vercel, from this repository — a push to the production branch deploys it.
The page is a static bundle; `api/index.ts` is a Vercel Function, and
`vercel.json` sends every `/api/*` path to it, rewrites everything else to the
SPA, and sets `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`
and `X-Robots-Tag: noindex`.

The project needs `DATABASE_URL` (Neon's pooled connection string),
`BETTER_AUTH_SECRET`, a private Blob store connected to the project, and
`SETUP_TOKEN` only until the first admin exists. A connected store provides
either `BLOB_STORE_ID` (the deployment signs in with Vercel's OIDC token, and
uploads use presigned URLs scoped to one path) or `BLOB_READ_WRITE_TOKEN`
(uploads use client tokens); the app handles both. `APP_ORIGINS` adds a custom domain.
The daily email needs `RESEND_API_KEY` (a Resend sending key for a verified
domain) and `CRON_SECRET` (any long random string; Vercel sends it with each
cron call); `APP_URL` overrides the link in it, which otherwise is the
production URL.
Apply `db/schema.sql` to a new database before the first deploy. Later
additions to AEROBOOK's own tables are applied by the server itself before
its first write. Changes to the sign-in tables are not: each is a file in
`db/migrations/`, applied by hand **before** deploying the code that needs it
(Better Auth checks its tables when it starts and will not serve without
them). Each is additive and safe to run twice, and the code already deployed
ignores what it adds. `db/migrations/2026-10-admin-two-factor.sql` is the
one for two-step sign-in.

### Preview deployments

Every branch gets a preview deployment, running whatever code is on that
branch. It must never reach the business's data, so **a preview serves no
API at all** (every `/api/*` request answers 503) unless its environment has
`PREVIEW_DATA=separate`. Set that for the Preview environment only, and only
once Preview has its own:

- `DATABASE_URL` — a Neon branch, not the production database (the Neon
  integration can create one per preview), and the other `POSTGRES_*`/`PG*`
  variables scoped to Production alone;
- `BETTER_AUTH_SECRET` — a different random string from production's;
- Blob store — a separate store connected for Preview only.

Production values should be scoped to **Production** alone in Vercel →
Settings → Environment Variables. The guard is there for the time between:
it stops a branch from touching production data by accident, but code on a
branch could remove it, so the separate settings are what actually close
the door.
