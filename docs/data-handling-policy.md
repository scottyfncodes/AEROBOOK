# AEROBOOK Customer Information Storage Policy

| | |
|---|---|
| **Applies to** | Everyone with an AEROBOOK account, admins included, and anyone who imports data into it |
| **Policy owner** | _[Name, title]_. Until someone is named, this is the senior admin on **Settings → Team** |
| **Approved by** | _[Name, title]_ on _[date]_ |
| **Version** | 1.0, _[effective date]_ |
| **Next review** | Twelve months after the effective date, or sooner (see section 8) |

> **Before it takes effect:** fill in the bracketed placeholders, especially
> the approved systems in section 4, and have OptiSurance's licensing or
> compliance counsel review it. This policy sets out how the team works. It is
> not legal advice and does not replace any duty OptiSurance has under federal
> or state insurance and privacy law.

## 1. Why this policy exists

AEROBOOK is the team's CRM for aircraft brokerage and aviation insurance. It
is built to answer who owns an aircraft, where the insurance stands, what is
happening commercially and what the next step is. It is **not** a place to
keep identity documents, financial account details, health information or
complete insurance files.

Technical controls such as sign-in, two-step sign-in and private file storage
protect what is in AEROBOOK. They cannot make it safe to hold something that
should never have been entered. AEROBOOK is also designed to keep things,
which makes a mistake harder to undo:

- **Everyone on the team sees everything.** Every signed-in person can read
  and edit every contact, aircraft, policy, note, follow-up and document.
  Nothing can be restricted to particular people.
- **Edits and deletions are kept.** Every change saves a full copy of the
  record as it was before (`app_audit.before`). Deleting a field or record in
  the app does not remove the earlier text.
- **The activity history shows text to everyone.** It displays up to 120
  characters of an activity subject, follow-up note or document name.
- **Chat cannot be edited or deleted.** Edited aircraft comments keep every
  earlier version, and deleted comments are only marked as deleted.
- **Deleted documents are kept for 30 days** before the daily maintenance run
  removes them.
- **Copies leave the server.** Every device caches the full dataset in its
  browser. Follow-up notes go out in the daily email. Anyone on the team can
  export everything as CSV files or a full JSON file.

**The rule:** if information is not in the "Permitted" column of section 3,
it does not go into AEROBOOK, in any field, note, comment, chat message,
document or file name.

## 2. Roles and responsibilities

| Role | Responsibilities |
|---|---|
| **Policy owner** | Maintains this policy and the approved-systems list. Runs the annual review. Decides what to do in edge cases. Owns the response when prohibited information is entered (section 7) and keeps the incident log. Confirms that training has been completed. |
| **AEROBOOK admins** | Add people to AEROBOOK only after they finish training (section 6). Carry out the purge procedure in the appendix when the policy owner asks. Turn off access the same day someone leaves. |
| **Everyone with an account** | Follows this policy. Removes or redacts information before entering it. Reports any prohibited information they enter or find, the same business day. |
| **Developers / anyone changing AEROBOOK** | Do not add fields, imports or integrations that would collect information in the Prohibited or Approved-systems-only columns without the policy owner's sign-off. Update this policy when a change affects where data goes. |

## 3. What may and may not be stored

### Permitted in AEROBOOK

Store only what is needed to work the relationship and the deal:

- **Contact details:** name, company, title or role, business or personal
  email, phone and mailing address, and contact type and status.
- **What the person wants:** buying or selling interest, wanted aircraft,
  budget range, mission, timeline and insurance interest.
- **Aircraft details:** tail number, year, make, model, serial number, base
  airport, ownership history, asking or target price and listing links. Most
  of this is public through the FAA registry.
- **Insurance policy summary:** carrier, policy number, broker or agent of
  record, effective and expiration dates, premium, hull value, liability
  limit, deductible, renewal status and quoted premium.
- **Business summaries:** what was discussed and agreed on a call, email or
  meeting, what comes next, and the outcome.
- **Pilot summary information needed to place coverage:** certificates and
  ratings held and approximate total and make-and-model hours, written as a
  summary, not as copies of logbooks or certificates.
- **Documents without restricted content:** aircraft spec sheets, listing
  photos, purchase agreements and LOIs, quotes and proposals, declarations
  pages, and policy forms. A document is only permitted if it contains
  nothing from the two lists below, or if those items have been redacted.

### Approved systems only

AEROBOOK may hold a **reference** to these items, such as "Application sent
to the carrier on 3/14, filed in _[system]_", but never the item itself:

- Completed insurance applications, renewal applications and pilot history
  forms
- Dates of birth
- Driver's license numbers, and any copy of a pilot certificate
- FAA medical certificate details (class, date, limitations)
- Pilot logbooks and training records
- Loss runs, claims files, and claim or accident details involving injury
- Signed contracts that contain any restricted item, and closing or escrow
  documents that show account details
- Business tax ID (EIN) and W-9 forms
- Lienholder or lender loan numbers

### Prohibited everywhere in AEROBOOK, with no exceptions

- Social Security numbers and individual taxpayer ID numbers, including
  partial numbers ("last four")
- Passport numbers, and any image of a government ID
- Bank account and routing numbers, wire instructions, and payment card
  numbers or security codes
- Passwords, PINs, two-step codes, security questions, and logins to carrier,
  customer or FAA portals
- Health or medical information beyond what the approved-systems list allows
  in its own system: diagnoses, medications, conditions, special-issuance
  details
- Criminal history, and immigration or citizenship documents
- Any information about a minor beyond their name as a passenger or family
  member
- Anything a customer asked to keep confidential, or that was received under
  an NDA that does not allow storing it here

When an item is not listed, treat it as approved-systems-only and ask the
policy owner. Adding an item to the Permitted list requires the policy owner
to update this document.

## 4. Approved systems for sensitive information

| Information | Approved system | Who has access |
|---|---|---|
| Insurance applications, loss runs, claims, pilot history forms, DOB, license and medical details | _[Agency management system / carrier portal]_ | _[Licensed staff]_ |
| Signed contracts, closing and escrow documents | _[Document vault / escrow agent's portal]_ | _[Roles]_ |
| Banking, wire and payment information | _[Accounting system / bank portal]_. Never in email, chat or AEROBOOK | _[Roles]_ |
| Passwords and portal logins | _[Password manager]_ | Individual |

Only the policy owner can change this table. When no approved system is
listed for something, it is not stored at all: give it back, or ask the
sender to send it directly to the carrier or escrow agent.

## 5. How to handle information by channel

**Quick check before saving anything:** Is it in the Permitted list? Would
it be fine for the whole team to see it, for it to stay in the history
permanently, and for it to show up in someone's morning email? If the answer
to any of these is no, do not save it.

### Email

AEROBOOK does not receive email. Everything from an email is copied in by
hand.

- Write a **summary** as an activity, such as "Sent renewal application;
  waiting on pilot hours." Never paste the whole email or thread.
- Do not save attachments to AEROBOOK until they have been checked against
  section 3. Applications, loss runs and ID copies go to the approved system.
- If a customer emails a prohibited item such as an SSN, bank details or an
  ID photo: do not forward it. Move the item to the approved system if it has
  one, then delete the email from your inbox and from deleted items. Reply
  asking them not to send it by email again, and tell them how to send it
  securely.

### Uploaded documents

- **Open and read every file before uploading it.** Scans and PDFs often hide
  a license or an extra application page in the back.
- Redact restricted items with a proper redaction tool that removes the text.
  Black boxes drawn over text in a PDF editor do not remove it.
- For spreadsheets, check hidden sheets, hidden columns and comments.
- Keep restricted items out of file names. The file name is shown in the
  activity history to everyone and is kept in the change history.
- Use a document category that matches what the document actually is.

### Notes, activities, follow-ups, comments and chat

- **Follow-up and task notes** go out in the assignee's daily email. Keep
  them to the action itself, like "Call about renewal quote."
- **Activity subjects and follow-up notes** appear in the shared activity
  history. Keep anything about a customer's personal situation out of them.
- **Aircraft comments** keep every earlier version, and **chat messages
  cannot be deleted**. Never put customer information in either one if it
  would not be allowed in the record itself. A chat group's whole history is
  visible to anyone added later.
- Do not record health, financial hardship, legal disputes or family
  situations unless they directly affect the deal. If they do, write a
  neutral summary: "Owner wants to close before year end" rather than the
  reason why.
- No opinions about a customer that you would not want them to read.

### Website inquiries

AEROBOOK has no website form connected to it. Inquiries are entered by hand.

- Create or update the contact with the permitted fields only: name, contact
  details, aircraft and what they are asking about.
- Never paste the raw inquiry. If the form collected anything restricted,
  leave it out and handle it as described under Email.
- Log it as an activity on the contact with a subject like "Website inquiry
  – _[form name]_", so the source is recorded.
- _[Website owner]_: website forms must not ask for anything in the
  Approved-systems-only or Prohibited lists. Any form that does needs the
  policy owner's sign-off and must send those answers to the approved system,
  not to an inbox that feeds AEROBOOK.

### Spreadsheet (CSV) imports

- **Delete restricted and prohibited columns before importing.** The importer
  keeps any column it cannot match to a field under the contact's or
  aircraft's custom fields. A "DOB" or "SSN" column will be imported and
  synced to every device.
- Import only lists from sources OptiSurance is allowed to use, such as the
  FAA registry or lists you have rights to.
- Afterwards, check the import under **Import history**. If a restricted
  column got through, follow section 7.

### Phone calls and meetings

Write down the business result, not identifiers. When a customer reads out
an SSN, card number or similar, do not write it in AEROBOOK. Enter it
directly into the approved system, or ask them to send it there.

### Exports and backups

The **Export** buttons under Settings, which anyone can use, produce files
with the full dataset. Store them only
in _[approved location]_, never in personal email or personal cloud storage.
Delete them when they are no longer needed. Restoring an old full export, which only admins can do,
also brings back anything that has since been purged, so check it with the
policy owner first.

## 6. Training

- **Before getting an account:** read this policy, complete a 30-minute
  walkthrough with the policy owner or an admin, and acknowledge it in
  writing (_[form or e-signature]_). The walkthrough covers sections 3 and 5
  using real AEROBOOK screens and shows where text ends up (history, daily
  email, chat). Admins add someone under **Settings → Team** only after
  getting the signed acknowledgment.
- **Every year:** a refresher and a new acknowledgment, in the same month as
  the policy review.
- **When the policy changes:** everyone gets a short summary of what changed
  and must acknowledge it within 14 days.
- **After an incident:** the person involved goes through a one-on-one
  walkthrough of the section they missed. If the same kind of incident keeps
  happening across the team, the whole team is retrained and section 5 is
  updated.
- **Recordkeeping:** the policy owner keeps training dates and
  acknowledgments in _[location]_ for _[retention period, e.g. five years]_.

If someone does not complete the annual refresher within 30 days of its due
date, their AEROBOOK access is turned off until they do.

## 7. When prohibited or restricted information is entered

The aim is to remove it completely and quickly. **Reporting your own mistake
promptly is expected and is not a disciplinary matter.**

### Whoever finds it (same business day)

1. **Do not copy, forward, screenshot or export it**, including to show
   someone.
2. If you have the item and it belongs in an approved system, move it there.
3. Remove it from the record in AEROBOOK: edit the field, note or comment, or
   delete the document. **This only hides it from current screens.** The
   earlier text is still in the change history.
4. Tell the policy owner in person, by phone or in a direct message. Say
   which record, which field, what kind of information it is (for example,
   "an SSN"), and when it was entered. **Do not include the information
   itself.** Do not post about it in a group chat.

### Policy owner (within 1 business day)

5. Ask an admin to complete the **purge procedure** in the appendix: change
   history, activity-history text, comment versions, chat, the document
   trash, and the file in storage.
6. Contain copies outside the server:
   - **Daily email:** if the item was in a follow-up note, recipients delete
     that morning's email.
   - **Exports and backups:** identify and delete any made since the item was
     entered.
   - **Devices:** cached copies refresh by themselves at the next sync once
     the record is fixed. Confirm everyone has opened AEROBOOK since then.
   - **Database host backups:** the hosted database keeps point-in-time
     history for _[N days, per the plan]_. Note the date that history will
     have aged past the incident.
7. **Assess whether it must be reported.** Entering data into an internal
   system that only authorized staff can access is usually not a breach. If
   the information was exported, emailed, shared outside the team, or seen by
   someone not authorized to see it, decide with counsel whether customer,
   carrier or regulator notification is required. Some state insurance data
   security laws have deadlines as short as **72 hours**, so do not wait.
8. **Log it** in the incident log (_[location]_): date, who reported it,
   record ID, type of information (never the value itself), how it got in,
   what was purged, notification decision, and cause.
9. **Fix the cause.** Possible fixes include retraining (section 6), a
   clarification to section 5, or a change to a website form, import source
   or app field.

### Consequences

- Promptly self-reported mistakes lead to retraining, nothing more.
- Repeated mistakes after retraining, or hiding a mistake, are handled under
  _[HR / disciplinary policy]_.
- Deliberately storing prohibited information, or deliberately copying it
  out of AEROBOOK, leads to immediate removal of access and is handled under
  _[HR / disciplinary policy]_.

## 8. Maintaining this policy

The policy owner reviews it at least once a year. A review is also required
when:

- AEROBOOK starts collecting new kinds of information, or connects to
  something new such as an email inbox, website form, e-signature tool or
  carrier integration.
- An incident shows a gap in the policy.
- OptiSurance's lines of business, approved systems, or legal requirements
  change.

The current version is kept in this repository at
`docs/data-handling-policy.md`. Changes are made through the usual review
process, recorded in the revision table below, and announced as described in
section 6.

| Version | Date | Change | Approved by |
|---|---|---|---|
| 1.0 | _[date]_ | First version | _[name]_ |

---

## Appendix: purge procedure (admin with database access)

Use this procedure only when the policy owner asks for it, and list each step
in the incident log. Every step below permanently erases data. Run it inside
a transaction, check the row counts, and commit only when they match what you
expect.

First, make sure the visible record has already been fixed in the app
(section 7, step 3). Then find where the text still exists. `<collection>`
is, for example, `contacts`, `aircraft`, `policies`, `activities`,
`followUps` or `files`, and `<record id>` is the record's ID:

```sql
-- The record's past versions and the history summaries shown to everyone.
select id, at, user_name, action, summary from app_audit
 where collection = '<collection>' and record_id = '<record id>' order by id;

-- Any other record whose past versions contain the text (e.g. it was pasted twice).
select collection, record_id, count(*) from app_audit
 where before::text ilike '%<distinctive fragment>%' group by 1, 2;
select collection, id from app_record where data::text ilike '%<distinctive fragment>%';
```

Search for a short, distinctive part of the text, not the whole value, so the
query itself does not end up storing the full number in a log.

```sql
begin;

-- 1. Remove earlier versions of the record. This also removes the ability to
--    restore those versions, which is intended.
update app_audit set before = null
 where collection = '<collection>' and record_id = '<record id>' and before is not null;

-- 2. Remove the item from the activity-history text everyone can see.
update app_audit set summary = '[removed under data-handling policy]'
 where collection = '<collection>' and record_id = '<record id>'
   and summary ilike '%<distinctive fragment>%';

-- 3. Aircraft comments: the current text, earlier versions, and deleted ones.
update app_aircraft_comment set body = '[removed under data-handling policy]'
 where body ilike '%<distinctive fragment>%';
update app_aircraft_comment_revision set body = '[removed under data-handling policy]'
 where body ilike '%<distinctive fragment>%';

-- 4. Chat messages, which cannot be deleted in the app.
update app_message set body = '[removed under data-handling policy]'
 where body ilike '%<distinctive fragment>%';

commit;
```

**For documents:** after the document record is deleted in the app, its file
waits in `app_file_trash`. Delete the file at that path from the Vercel Blob
store right away instead of waiting the 30 days, then remove the row from the
trash table:

```sql
select path, deleted_at from app_file_trash order by deleted_at desc;
delete from app_file_trash where path = '<path>';
```

Then run the first `select` queries again and confirm they return nothing.
Record in the incident log that the purge is complete, without the value
itself.
