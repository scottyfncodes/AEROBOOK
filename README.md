# AEROBOOK

A personal CRM for an aircraft broker who also sells aviation insurance.
Aircraft are first-class records, not a custom field on a contact.

The workflow it exists for:

> aircraft-owner CSV → intelligent import → aircraft and person automatically
> connected → personalised outreach → follow-up → relationship history

## Running it

```bash
npm install
npm run dev        # development server
npm test           # 205 tests
npm run build      # production build into dist/
npm run preview    # serve the build, then in another shell:
npm run e2e        # drive it in Chromium at iPhone dimensions
```

`npm run e2e` takes `BASE_URL` and `CHROME_PATH` from the environment.

`npm run build` needs nothing but Node. Chromium and potrace are only used by
the brand script below, which is not part of the build.

## How it is put together

```
src/lib/          domain logic, all pure and tested
  csv.ts          RFC 4180 reader that never throws on malformed input
  mapping.ts      scored header detection onto AEROBOOK fields
  names.ts        owner-name parsing (FAA lists are last-name-first)
  tail.ts         tail-number normalisation
  matching.ts     duplicate detection indexes
  importer.ts     preview (pure) and apply (writes) — same code path
  email.ts        template rendering and mailto building
  search.ts       one index across contacts, aircraft and opportunities
  aviation.ts     ISA atmosphere, wind triangle, weight and balance, premiums
  links.ts        external links, built from stable endpoints only
src/data/         types, IndexedDB persistence, the store
src/components/   shared UI
src/screens/      one file per screen
```

The whole dataset is a single JSON document in IndexedDB. A personal CRM is a
few thousand records, so keeping it in memory and writing the document on
change is simpler and faster than a row-per-record schema. `localStorage` is
the fallback when IndexedDB is unavailable. Nothing leaves the device.

## Things it deliberately does not do

- **It never says an email was sent.** AEROBOOK has no mail integration, so an
  email is recorded as *prepared*, *opened in mail* or *copied*.
- **It ships no aviation data.** Aircraft performance, airport details and
  registrations come from the authoritative source via a link, not from a copy
  that can go stale. The calculators work on numbers the user types.
- **It ships no restaurant list.** The layover guide opens a live search
  against the Michelin Guide, maps or the web, because a hard-coded list is
  wrong the day a place closes.
- **It never discards a CSV column.** Anything unrecognised is kept as custom
  data on the record.
- **It never silently overwrites.** An import that would replace an existing
  value shows the conflict and waits for a decision.

## The supplied sample file

`sample-data/owners-cirrus-design-corp-sr22t.csv` (117 aircraft) is used as a
real acceptance test in `src/lib/acceptance.test.ts`: the file is read off
disk and run through the same parser, detector, preview and importer the UI
uses. It asserts 117 aircraft, 115 contacts (two owners hold two aircraft
each), the email subject, greeting and mailto, and that re-importing the same
file creates nothing.

`e2e-check.mjs` drives the built app in Chromium at iPhone dimensions and
walks the same journey through the real UI — import, search by a lowercase
tail, generate and record the email, set a follow-up, reload, re-import,
export. It fails on any console error, any horizontal overflow at 390px, or
any link without a destination.

## Brand

The mark is an "A" whose crossbar runs well past both legs, drawn in fine
strokes that lean forward — the visual language is a modern aviation
operations tool: near-black surfaces, one warm signal colour, and no
decoration that doesn't carry information.

```bash
npm run brand      # regenerates public/brand/ from scripts/build-brand.mjs
```

Outputs are committed, so a normal build needs neither Chromium nor this
script. Run it only when the mark changes.

## Deployment

Vercel, from this repository — a push to the production branch deploys it.
The build is a plain static bundle; `vercel.json` handles the SPA rewrite and
sets `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and
`X-Robots-Tag: noindex`.
