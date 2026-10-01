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
npm test             # 523 tests; the 210 API, sync and messaging tests also need:
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
  chat.ts         conversations and groups, members only
  comments.ts     comments on an aircraft
  notify.ts       who hears about a message or comment, and whether by push
  push.ts         web push subscriptions and sending
  inbox.ts        unread counts and new events, polled by the open app
  messaging.ts    the routes for all of the above
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

An admin can also **delete** someone, under Settings → Team → Delete. It
cannot be undone, and asks for their name first. The account is emptied —
sign-in, password, two-step sign-in, sessions, push subscriptions, watched
aircraft, read markers, personal settings and group memberships go, and the
email address is free for a new account — while everything they recorded
stays, shown as "Name (deleted)". Follow-ups for them go back to everyone.
Their "user" row is kept as a disabled shell (listed in `app_deleted_user`)
because messages, comments and history point at it, and the admin routes
refuse to give it access, a password or a role again. Only an admin with
access can delete, never themselves, so an admin always remains. The
deletion is written to the admin audit log, not the team's history.

### Two-step sign-in

Anyone can turn on **two-step sign-in** under **Settings → Account**: after
the password, signing in also needs the six-digit code from an authenticator
app (Google Authenticator, Microsoft Authenticator, 1Password and the like).
Setup asks for the password, shows a QR code (and the key to type in by
hand), shows ten single-use backup codes once, and only turns on when a code
from the app has been entered. Turning it on signs that person out on every
other device, so a session made with the password alone does not outlive it.

- Signing in: the right password gives no session, only a ten-minute
  challenge; the code (or a backup code, once each) completes it. Five wrong
  codes end the challenge, ten in a row lock two-step sign-in for fifteen
  minutes, and the endpoints are rate-limited. "Trust this device" is refused:
  every sign-in needs the code. A wrong password is answered the same whoever
  the account belongs to, so it does not show who has it on.
- Anyone can turn it on for their own account; nobody can turn it on for
  someone else. People who leave it off sign in as before. It gives no extra
  access: account management stays with admins.
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

**Follow up** sets a reminder for yourself: a note, a date and a priority.
**Assign** gives someone else on the team a task: who, what to do (Follow up,
Call, Send quote, Send contract or Other), a note for them, a date and a
priority. Anyone can assign to anyone. A task remembers who gave it, shows
"From …" on its holder's list, and **Edit** opens it as a task again, to
change it or hand it to someone else.

Everyone can pick a color for their name under **Settings → Account → Your
color**: a small dot beside their name on tasks ("From Scott", "For Andrew").
Ten colors, one person each, first come first served — the database's unique
index settles two people picking the same one at once. Tapping yours again
gives it up, and deleting someone frees theirs. The name is always beside the
dot, so nothing depends on telling colors apart. The person given one gets a notification ("Scott assigned you a task:
Send quote") — never the note, which stays in the app. Unassigned follow-ups — including everything recorded before
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

## Chat

**Chat** (its own tab) is for talking to the rest of the team: one-to-one
conversations, and named groups. Anyone can message anyone on the team whose
access is on. In a group, any member can rename it and add people, anyone can
leave, and whoever started it (or an admin) can remove someone; someone who
leaves or is removed can no longer open it, and what they wrote stays.
Messages cannot be edited or deleted — chat is a record of what was said.

**Group history is shared with whoever is in the group.** Someone added to an
existing group sees its whole history, including everything said before they
joined. Someone who leaves (or is removed) loses access to all of it, and if
they are added back later they see the whole history again, including what
was said while they were away. This is deliberate: AEROBOOK's chat is the
team's internal chat, and a group's history is the context a newcomer needs.
There is no per-message visibility by when someone joined, so do not put
anything in a group that the people who may later be added to it should not
read. Someone added later does not start with the old messages counted as
unread; they start from where the group is when they join.

Conversations are **not** part of the shared data that every device syncs:
they live in their own tables (`app_conversation`, `app_conversation_member`,
`app_message`) and are fetched only by their members. Every chat route starts
by checking that the signed-in person is a current member, and answers
anything else exactly as it answers an id that does not exist (404), so a
guessed or copied id reveals nothing — admins included.

The tab shows how many messages are unread, and so does the Home Screen icon
where the device supports it.

## Comments on an aircraft

Every aircraft has a **Comments** section, near the top of its page: the
discussion about that tail, kept on its record rather than in chat. Comments
are multi-line, oldest first, with who wrote them and when. Their author can
edit them (they are then marked *edited*, and what they said before is kept
in `app_aircraft_comment_revision`); their author or an admin can delete
them, which only marks them — the words stay in the database.

Who may read and write them follows the rest of AEROBOOK: everyone signed in
whose access is on sees every aircraft, so everyone sees its comments. The
server checks every time that the aircraft exists and has not been deleted,
and finds a comment only through the aircraft in the address, so an id
copied from another aircraft finds nothing. Comments on a deleted aircraft
are kept, and come back if it does.

Comments since you last looked are marked new — a gold dot on the aircraft in
the list, "2 new" on the section — and count as read once the section has
been on screen.

The activity history records comments by tail ("Scott added a comment on
N123AB"), never by what they say; group changes are recorded for admins
(`app_audit`, collection `chat`) but not shown in the history, and messages
are never recorded there. The audit log is not a second copy of anyone's
conversations.

## Notifications

One notification layer (`server/notify.ts`) serves chat and comments alike.
When a message or comment is saved it works out who should hear about it,
writes one `app_notification` row for each, and decides for each person
whether their devices also get a push:

- **Who.** A direct message: the other person. A group: its current members.
  A comment: everyone **watching** that aircraft — commenting starts watching
  (unless you have said otherwise), and anyone can Watch or stop watching an
  aircraft from its Comments section. So a comment reaches the people in that
  aircraft's discussion, never the whole team. A task: the person it was just
  given to, unless they gave it to themselves; editing it without changing
  who has it says nothing. Never the author, and never anyone whose access is
  off.
- **In the app.** While AEROBOOK is open it checks every few seconds
  (`POST /api/inbox`; quicker in an open conversation, slower when nobody has
  touched the screen for a while, and not at all in the background). Something
  new elsewhere pops up at the top of the screen; the conversation already on
  screen just shows the new message.
- **Push.** Not while the person has AEROBOOK open and in use on any device —
  the open app tells the server where it is, and a device counts as away 45
  seconds after it last did. Not again for the same conversation or aircraft
  within two minutes of the last push while it is still unread; the next one
  says how many are waiting ("3 new messages · latest from Scott"). If that
  last push reached none of the person's devices (the push service turned it
  down), the newest message held back behind it is pushed in its place, so a
  failed push never silences what comes after it. A newer
  notification for the same conversation replaces the older one on the
  device. None of this touches unread counts, which come from what each
  person has read, so holding back a push never hides a message.

Each person turns push on per device under **Settings → Notifications**, and
can send themselves a test or turn it off again. Signing out turns it off on
that device. Subscriptions are only accepted for real push services (Apple,
Google, Mozilla, Microsoft), and one a push service reports as gone is
forgotten. The server makes the request to whatever endpoint it stores, so
the check is strict: `https://`, a host that is *exactly* one of the push
services' hosts (`fcm.googleapis.com`, `web.push.apple.com`,
`updates.push.services.mozilla.com`, or one `*.notify.windows.com` host), no
port or user, and nothing in the URL that Node's legacy `url.parse()` — which
`web-push` uses to connect — could read differently from the browser's URL
parser. It is checked again just before every send. The service worker (`public/sw.js`) only shows notifications and
opens the app on the right page when one is tapped — a conversation, or the
aircraft scrolled to its comments; it caches nothing.

**iPhone and iPad** (iOS/iPadOS 16.4 or later): web push only works for
AEROBOOK added to the Home Screen and opened from there — in a Safari tab the
Notifications section says so. Permission is asked for only when **Turn on
notifications** is tapped. Focus modes and Low Power Mode can delay or hold
back notifications, as they do for any app. Desktop Chrome, Edge and Firefox
work from a normal tab; Safari on the Mac from a normal tab too (or a Dock
web app).

Push needs `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (see
Deployment). Without them everything else — chat, comments, the in-app
pop-ups — works the same, and the app says push is not set up. There are no
email notifications for messages; the notification layer has one place
(`deliver()`) where another way of delivering would go.

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
  that can go stale.
- **It never discards a CSV column.** Anything unrecognised is kept as custom
  data on the record.
- **It never silently overwrites.** An import that would replace an existing
  value shows the conflict and waits for a decision.
- **It never makes a document public.** Files sit in private storage and are
  only ever read through the app, by someone signed in. The JSON backup
  carries the list of them, not the files, and the screens say so.
- **Its notifications never say what was written.** A push says who, and
  where — "New message from Scott", "New comment on N123AB from Scott" — and
  the words stay inside the app. Follow-up reminders are still in-app, on the
  home screen and the task list, and in the daily email.

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
navy tile.

```bash
npm run brand      # regenerates the icons in public/brand/
```

The icons are drawn from geometry in `scripts/build-brand.mjs`; edit them
there, never the output files. The script needs Chromium to render them,
which the normal build does not — outputs are committed.

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
Push notifications need `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (a key
pair made once with `npx web-push generate-vapid-keys`; the private key is a
secret, the public one is handed to browsers) and `VAPID_SUBJECT` (a contact
for the push services, e.g. `mailto:you@yourdomain.com`). If the keys are
changed, each device picks up the new ones the next time AEROBOOK is opened
there; until then it gets no pushes.
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

## Backups

Every night at 07:17 UTC, `.github/workflows/backup.yml` runs
`scripts/backup-db.sh`. It dumps the production database, restores the dump
in full into an empty Postgres on the runner and checks it, encrypts it to an
[age](https://age-encryption.org) public key, and uploads it to a Backblaze B2
or AWS S3 bucket. Any failure fails the job, and GitHub emails about it;
nothing is uploaded from a run that fails.

The dump is every schema except `neon_auth`, which belongs to Neon Auth and
which AEROBOOK does not use; all of AEROBOOK's tables are in `public`.

**Uploaded documents are not backed up.** The files in Vercel Blob storage
(everything attached under Documents) are not in these backups; only the
database is. If the Blob store is deleted, the database restores with
document records whose files are gone.

It exists for the day one of our accounts is taken over. Someone holding the
Vercel or Neon login can delete the database and Neon's six hours of
history with it, so the copy lives somewhere that login cannot reach, under
rules that login cannot change. Before each upload the script refuses to go
on unless these hold, so a weakened setup stops the backups loudly instead
of quietly:

- **Read-only.** The database role cannot insert, update, delete or truncate
  any table or column, cannot change a sequence, owns nothing and cannot
  `SET ROLE` to anything that does, and is not a superuser or a member of
  `neon_superuser` or `pg_write_all_data`.
- **A whole, faithful copy.** Before the dump, every table is counted inside
  a read-only transaction, and `pg_dump` dumps from that same snapshot. The
  dump must then restore without a single error into the empty Postgres on
  the runner (never anywhere else: the script accepts only an empty database
  on localhost), every table's row count must match, and `public."user"`
  must have at least one account. A dump cut short or damaged, an empty
  database, or one missing the accounts table is refused.
- **Locked.** The bucket has Object Lock on with a default retention of at
  least 30 days in COMPLIANCE mode, which no one can shorten or lift, us
  included. The 30-day minimum cannot be lowered by a setting.
- **Encrypted before it leaves.** The job holds only the public key; the
  private key (`AGE-SECRET-KEY-…`) is kept offline, printed and in a
  password manager, and never put in GitHub, Vercel, Neon or the bucket.
  Without it the backups cannot be read, so keep two copies. Each file is
  also encrypted to a key made for that run alone, so the script can check
  the encrypted file decrypts to the dump before uploading it; that key is
  never saved and is gone when the run ends.

Each run writes a new file, named for the second it ran and the run's id.
What the script cannot check, and setup has to get right: the storage
account is its own, under its own login with its own MFA (not signed in with
GitHub, Google or Vercel); and its key can add files but not delete them.

Nothing tells you if the job stops running altogether (GitHub pauses
schedules in a repository with no commits for 60 days, emailing first), so
glance at the bucket now and then.

### Setting it up

1. Make the key pair on your own computer: `age-keygen -o aerobook-backup.key`.
   It prints the public key (`age1…`). Store the file offline as above.
2. Create the bucket **with Object Lock on** (it can only be turned on when
   the bucket is made), a default retention of 30 days in Compliance mode,
   and a lifecycle rule removing files after a year. Then a key for this
   bucket alone:
   - B2: an application key with `writeFiles` and `readBucketRetentions`
     only — not `deleteFiles`, `writeFileRetentions` or `bypassGovernance`.
   - S3: a user whose only permissions are `s3:PutObject` on the bucket's
     objects and `s3:GetBucketObjectLockConfiguration` on the bucket.
3. Give the backup its own read-only database role. Run this in Neon's SQL
   editor on the production branch (a role made from the Roles page could
   write):

   ```sql
   create role aerobook_backup with login password '<long random string>';
   grant pg_read_all_data to aerobook_backup;
   ```

   If Neon will not grant `pg_read_all_data`, grant it table by table instead:

   ```sql
   grant usage on schema public to aerobook_backup;
   grant select on all tables in schema public to aerobook_backup;
   grant select on all sequences in schema public to aerobook_backup;
   alter default privileges for role neondb_owner in schema public
     grant select on tables to aerobook_backup;
   alter default privileges for role neondb_owner in schema public
     grant select on sequences to aerobook_backup;
   ```

   Its connection string is production's **direct** one (the host without
   `-pooler`) with this role and password.
4. In GitHub → Settings → Environments, create an environment named `backup`.
   Under Deployment branches choose **Selected branches** and allow `main`
   only, so a workflow on any other branch cannot read these. Then add:

   | Kind | Name | Value |
   |---|---|---|
   | secret | `BACKUP_DATABASE_URL` | the read-only, direct connection string |
   | secret | `BACKUP_S3_KEY_ID` | the add-only key's id |
   | secret | `BACKUP_S3_SECRET` | the add-only key's secret |
   | variable | `BACKUP_AGE_RECIPIENT` | the `age1…` public key |
   | variable | `BACKUP_S3_BUCKET` | the bucket name |
   | variable | `BACKUP_S3_ENDPOINT` | B2's S3 endpoint, e.g. `https://s3.us-west-004.backblazeb2.com`; empty for AWS |
   | variable | `BACKUP_S3_REGION` | e.g. `us-west-004` |

5. Actions → Nightly database backup → Run workflow, and check a file
   appears in the bucket. Then restore it once, as below, so you know it works.

### Restoring

Download the file you want from the bucket, then restore into a new, empty
database, such as a fresh Neon branch or project, never over the one in use:

```bash
age -d -i aerobook-backup.key aerobook-2026-10-01T071702Z-123456789.dump.age > aerobook.dump
pg_restore --exit-on-error --no-owner --no-privileges -d "postgres://…new database…" aerobook.dump
```

`pg_restore --list aerobook.dump` shows what is inside, and `-t <table>` restores
one table. Check the data, then point production's `DATABASE_URL` at the
restored database and redeploy.

### Testing it

`npm run test:backup` runs `scripts/backup-db.test.sh` against a Postgres on
this machine (`BACKUP_TEST_ADMIN_URL`, default
`postgres://postgres:postgres@localhost:5432/postgres`) with the upload
stubbed. It checks that good backups upload and restore, and that each
refusal above happens with nothing uploaded: roles that can write, buckets
without a 30-day COMPLIANCE lock, dumps cut short or damaged, a missing or
empty accounts table, a wrong verification database, bad settings, and a
failed upload.
