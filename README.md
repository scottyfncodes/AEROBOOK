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
npm test             # 358 tests; the 52 API and sync tests also need:
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
  csv.ts          RFC 4180 reader that never throws on malformed input
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
everything they recorded. Sign-in attempts are rate-limited.

Everyone sees and edits the same contacts, aircraft, opportunities, policies,
timeline, follow-ups and templates. Each person has their own profile (the
signature on their emails) and appearance setting. Restoring a backup and
erasing everything affect the whole team, so only admins see them.

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
someone signed in and only for a path under `files/`, up to 25 MB. Opening a
document goes through `GET /api/files/content`, which checks the session and
that a document record points at that file, and always serves it as a
download. Deleting the document's record deletes the file, on the server.

A document attached before cloud storage (or while offline) stays in that
browser until it can be moved up, which the app does on its own the next time
it opens. Without `BLOB_READ_WRITE_TOKEN` the app keeps documents in the
browser as it used to; `npm run serve` and `npm run dev` use a `.local-files`
folder instead.

## Activity history

**Settings → Activity history** lists every change anyone on the team saved,
newest first, grouped by day: "Scott edited aircraft N917JH", linked to the
record while it still exists and saying what a note or follow-up was on. A
burst of the same thing — an import creating a hundred contacts — reads as one
line with a count that expands.

It is read-only. It comes from `app_audit`, which the server writes as each
change is saved (see Data); `GET /api/history` returns it in pages of 100 to
anyone signed in and answers any other method with 405. Personal settings are
never recorded.

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

The mark and the footer signature are the owner's own hand, not a drawn
imitation of it. `brand-source/signature.jpg` is traced twice: the whole
signature, tight-cropped, for the quiet sign-off at the foot of the
dashboard, and a close crop of just its capital "A" — peak, the long
downstroke, the short one, the crossbar — for the app-bar and splash logo,
since the full signature is illegible at those sizes. Both land as
`currentColor` SVGs applied through a CSS mask, so one asset works in both
themes and takes whatever colour surrounds it.

The home-screen icon set spells out "Aerobook": the same traced "A", scaled
up and given a heavier stroke so it stays the dominant glyph, followed by
"erobook" hand-lettered in the same forward-leaning pen — there is no
"erobook" in the source signature to trace, so those letters are invented
strokes built to match its lean and weight.

```bash
npm run brand      # regenerates public/brand/ from brand-source/signature.jpg
```

Needs Chromium (for the canvas-based ink matting) and `potrace` (the actual
tracing), neither of which the normal build touches — outputs are committed.
Run it only when the source signature changes.

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
Apply `db/schema.sql` to a new database before the first deploy.
