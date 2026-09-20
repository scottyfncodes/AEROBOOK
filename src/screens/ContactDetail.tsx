import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import {
  IconCalendar, IconEdit, IconMail, IconNote, IconPhone, IconPlane, IconPlus, IconTarget,
} from '../components/Icons';
import {
  ActivitySheet, ExternalLinkList, FilesSection, FollowUpList, FollowUpSheet, NeedsReviewBanner, Timeline,
} from '../components/detail';
import { EmailComposer } from '../components/EmailComposer';
import { AircraftRow, OpportunityRow } from '../components/records';
import {
  Chip, ConfirmButton, EmptyState, KeyValue, SelectField, Sheet, TextArea, TextField, useToast,
} from '../components/ui';
import { NewOpportunitySheet } from '../components/opportunity';
import { InsuranceSection } from '../components/insurance';
import { useDatabase } from '../data/useStore';
import { deleteActivity, deleteContact, updateContact } from '../data/store';
import {
  CONTACT_STATUSES, CONTACT_TYPES, INTENT_LEVELS, PROSPECT_STATUSES, emptyIntent, hasIntent,
  type ContactIntent, type ContactStatus, type ContactType, type FollowUp, type IntentLevel,
  type ProspectStatus,
} from '../data/types';
import { aircraftOf, nextMove, opportunitiesFor, timelineFor } from '../lib/selectors';
import { policiesFor } from '../lib/insurance';
import { displayName } from '../lib/names';
import { formatPhone, formatZip } from '../lib/phone';
import { formatDate, relativeDue } from '../lib/dates';
import { mapsLink, smsLink, telLink, type ExternalLink } from '../lib/links';

export default function ContactDetail() {
  const { id = '' } = useParams();
  const db = useDatabase();
  const navigate = useNavigate();
  const toast = useToast();

  const contact = db.contacts.find((c) => c.id === id);
  const [sheet, setSheet] = useState<
    'email' | 'activity' | 'followUp' | 'edit' | 'opportunity' | 'intent' | null
  >(null);
  const [editingFollowUp, setEditingFollowUp] = useState<FollowUp | undefined>();

  const timeline = useMemo(
    () => (contact ? timelineFor(db, { contactId: contact.id }) : { activities: [], followUps: [] }),
    [db, contact],
  );

  if (!contact) {
    return (
      <>
        <AppBar title="Contact" back />
        <main className="page">
          <EmptyState title="That contact is not in the book" action={<Link className="btn" to="/contacts">All contacts</Link>} />
        </main>
      </>
    );
  }

  const owned = aircraftOf(db, contact.id);
  const opportunities = opportunitiesFor(db, { contactId: contact.id });
  const policies = policiesFor(db, { contactId: contact.id });
  const files = db.files.filter((f) => f.contactId === contact.id);
  const primaryAircraft = owned[0] ?? null;
  const move = nextMove(db, { contactId: contact.id });
  const intent = contact.intent;
  const address = [contact.address, contact.address2, contact.city, contact.state, formatZip(contact.zip)]
    .filter(Boolean)
    .join(', ');

  const links: ExternalLink[] = [];
  const map = mapsLink([contact.address, contact.city, contact.state, contact.zip], 'Map this address');
  if (map) links.push(map);

  return (
    <>
      <AppBar
        title={displayName(contact)}
        back
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setSheet('edit')} aria-label="Edit contact">
            <IconEdit />
          </button>
        }
      />
      <main className="page stack stack--lg">
        <section className="stack stack--sm">
          <h1 style={{ fontSize: 26 }}>{displayName(contact)}</h1>
          {contact.company && (contact.firstName || contact.lastName) ? (
            <div className="secondary">{contact.company}</div>
          ) : null}
          <div className="row row--wrap" style={{ gap: 6 }}>
            <Chip tone={contact.status === 'Active Client' ? 'success' : undefined}>{contact.status}</Chip>
            <Chip>{contact.prospectStatus}</Chip>
            {contact.role ? <Chip>{contact.role}</Chip> : null}
            {contact.contactTypes.map((t) => <Chip key={t}>{t}</Chip>)}
          </div>
        </section>

        {contact.needsReview ? (
          <NeedsReviewBanner>
            The owner name <strong>“{contact.rawName}”</strong> could not be split into a first and last name with
            confidence. Edit the contact to set it, or leave it as it is — the original is never changed.
          </NeedsReviewBanner>
        ) : null}

        <section className="btn-group">
          <button className="btn btn--primary" onClick={() => setSheet('email')}>
            <IconMail /> Email
          </button>
          <a
            className="btn"
            href={contact.phone ? telLink(contact.phone) : undefined}
            aria-disabled={!contact.phone}
            style={!contact.phone ? { pointerEvents: 'none', opacity: 0.45 } : undefined}
          >
            <IconPhone /> Call
          </a>
          <a
            className="btn"
            href={contact.phone ? smsLink(contact.phone) : undefined}
            aria-disabled={!contact.phone}
            style={!contact.phone ? { pointerEvents: 'none', opacity: 0.45 } : undefined}
          >
            <IconNote /> Text
          </a>
          <button className="btn" onClick={() => setSheet('activity')}>
            <IconNote /> Log activity
          </button>
          <button className="btn" onClick={() => { setEditingFollowUp(undefined); setSheet('followUp'); }}>
            <IconCalendar /> Follow up
          </button>
          <button className="btn" onClick={() => setSheet('opportunity')}>
            <IconTarget /> Add opportunity
          </button>
          <button className="btn" onClick={() => setSheet('intent')}>
            <IconTarget /> What they want
          </button>
        </section>

        {/* What they have, what they want, and what happens next. */}
        <section className="glance" aria-label="At a glance">
          <div className="glance__cell">
            <span className="glance__label">Aircraft</span>
            <span className="glance__value strong truncate">
              {owned.length === 0
                ? 'None on record'
                : owned.map((a) => a.tailNumber).join(', ')}
            </span>
            <span className="xsmall muted truncate">
              {owned.length > 1 ? `${owned.length} aircraft` : owned[0]
                ? [owned[0].year, owned[0].make, owned[0].model].filter(Boolean).join(' ')
                : '—'}
            </span>
          </div>
          <div className="glance__cell">
            <span className="glance__label">Wants</span>
            <span className="glance__value truncate">{wantsSummary(intent)}</span>
            <span className="xsmall muted truncate">{intent?.timeline || '—'}</span>
          </div>
          <div className="glance__cell">
            <span className="glance__label">Insurance</span>
            <span className="glance__value truncate">
              {policies.length === 0 ? 'Nothing on record' : `${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}`}
            </span>
            <span className="xsmall muted truncate">{policies[0]?.carrier || intent?.insuranceNotes || '—'}</span>
          </div>
          <div className="glance__cell">
            <span className="glance__label">Next move</span>
            <span className={`glance__value truncate${move ? ' strong' : ' muted'}`}>
              {move ? move.text : 'Nothing scheduled'}
            </span>
            <span className="xsmall muted">{move?.dueDate ? relativeDue(move.dueDate) : '—'}</span>
          </div>
        </section>

        <section className="stack stack--sm">
          <div className="row row--between">
            <h2 className="section-title">What they want</h2>
            <button className="btn btn--sm btn--ghost" onClick={() => setSheet('intent')}>
              <IconEdit /> Edit
            </button>
          </div>
          {hasIntent(intent) ? (
            <div className="card">
              <KeyValue k="May sell">{intent?.selling ?? 'Unknown'}</KeyValue>
              {intent?.sellingNotes ? <KeyValue k="Selling notes">{intent.sellingNotes}</KeyValue> : null}
              <KeyValue k="Looking to buy">{intent?.buying ?? 'Unknown'}</KeyValue>
              {intent?.wantedAircraft ? <KeyValue k="Wants">{intent.wantedAircraft}</KeyValue> : null}
              {intent?.budget ? <KeyValue k="Budget">{intent.budget}</KeyValue> : null}
              {intent?.mission ? <KeyValue k="Mission">{intent.mission}</KeyValue> : null}
              {intent?.timeline ? <KeyValue k="Timeline">{intent.timeline}</KeyValue> : null}
              <KeyValue k="Insurance">{intent?.insurance ?? 'Unknown'}</KeyValue>
              {intent?.insuranceNotes ? <KeyValue k="Insurance notes">{intent.insuranceNotes}</KeyValue> : null}
            </div>
          ) : (
            <button className="card small muted" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setSheet('intent')}>
              Nothing recorded yet. What they want is usually more useful than what they have — tap to
              note whether they may sell, what they are looking for, and where insurance stands.
            </button>
          )}
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Contact</h2>
          <div className="card">
            {contact.email ? (
              <KeyValue k="Email"><a href={`mailto:${contact.email}`}>{contact.email}</a></KeyValue>
            ) : (
              <KeyValue k="Email"><span className="muted">None on record</span></KeyValue>
            )}
            {contact.phone ? (
              <KeyValue k="Phone"><a href={telLink(contact.phone)}>{formatPhone(contact.phone)}</a></KeyValue>
            ) : null}
            {address ? <KeyValue k="Address">{address}</KeyValue> : null}
            {contact.company ? <KeyValue k="Company">{contact.company}</KeyValue> : null}
            {contact.rawName && contact.rawName !== displayName(contact) ? (
              <KeyValue k="As imported">{contact.rawName}</KeyValue>
            ) : null}
            {contact.lastContactedAt ? <KeyValue k="Last contacted">{formatDate(contact.lastContactedAt)}</KeyValue> : null}
            {contact.source ? <KeyValue k="Source">{contact.source}</KeyValue> : null}
            <KeyValue k="Added">{formatDate(contact.createdAt)}</KeyValue>
            {Object.entries(contact.custom).map(([k, v]) => <KeyValue key={k} k={k}>{v}</KeyValue>)}
          </div>
        </section>

        <section className="stack stack--sm">
          <div className="row row--between">
            <h2 className="section-title">Aircraft</h2>
            <Link className="btn btn--sm btn--ghost" to="/aircraft?new=1">
              <IconPlus /> New
            </Link>
          </div>
          {owned.length === 0 ? (
            <div className="card small muted">
              <IconPlane style={{ width: 16, height: 16, verticalAlign: '-3px', marginRight: 6 }} />
              No aircraft linked to this contact.
            </div>
          ) : (
            <div className="list">
              {owned.map((a) => <AircraftRow key={a.id} aircraft={a} owner={contact} />)}
            </div>
          )}
        </section>

        <section className="stack stack--sm">
          <div className="row row--between">
            <h2 className="section-title">Opportunities</h2>
            <button className="btn btn--sm btn--ghost" onClick={() => setSheet('opportunity')}>
              <IconPlus /> New
            </button>
          </div>
          {opportunities.length === 0 ? (
            <div className="card small muted">No opportunities yet. One person can hold several at once.</div>
          ) : (
            <div className="list">
              {opportunities.map((o) => (
                <OpportunityRow
                  key={o.id}
                  opportunity={o}
                  contact={contact}
                  aircraft={o.aircraftId ? db.aircraft.find((a) => a.id === o.aircraftId) : undefined}
                />
              ))}
            </div>
          )}
        </section>

        <InsuranceSection
          policies={policies}
          links={{ contactId: contact.id, aircraftId: primaryAircraft?.id ?? null }}
          emptyBody="No insurance on record for this person. Add a policy and the renewal shows up here, on the aircraft and on the home screen."
          onFollowUp={(policy) => {
            setEditingFollowUp(undefined);
            setSheet('followUp');
            void policy;
          }}
        />

        {timeline.followUps.some((f) => !f.completed) ? (
          <section className="stack stack--sm">
            <h2 className="section-title">Follow-ups</h2>
            <FollowUpList
              followUps={timeline.followUps}
              onEdit={(f) => { setEditingFollowUp(f); setSheet('followUp'); }}
            />
          </section>
        ) : null}

        <section className="stack stack--sm">
          <h2 className="section-title">Timeline</h2>
          <Timeline
            activities={timeline.activities}
            followUps={timeline.followUps}
            onDeleteActivity={(activityId) => { deleteActivity(activityId); toast('Removed from the timeline'); }}
          />
        </section>

        {contact.notes ? (
          <section className="stack stack--sm">
            <h2 className="section-title">Notes</h2>
            <div className="card small secondary" style={{ whiteSpace: 'pre-wrap' }}>{contact.notes}</div>
          </section>
        ) : null}

        <section className="stack stack--sm">
          <h2 className="section-title">Documents</h2>
          <FilesSection files={files} links={{ contactId: contact.id }} />
        </section>

        <ExternalLinkList links={links} title="Links" />

        <section>
          <ConfirmButton
            label="Delete this contact"
            confirmLabel="Tap again to delete permanently"
            className="btn btn--danger btn--block"
            onConfirm={() => {
              deleteContact(contact.id);
              toast('Contact deleted');
              navigate('/contacts');
            }}
          />
        </section>
      </main>

      {sheet === 'email' ? (
        <EmailComposer contact={contact} aircraft={primaryAircraft} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'activity' ? (
        <ActivitySheet
          links={{ contactId: contact.id, aircraftId: primaryAircraft?.id ?? null }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'followUp' ? (
        <FollowUpSheet
          links={{ contactId: contact.id, aircraftId: primaryAircraft?.id ?? null }}
          existing={editingFollowUp}
          defaultNote={`Follow up with ${displayName(contact)}`}
          onClose={() => { setSheet(null); setEditingFollowUp(undefined); }}
        />
      ) : null}
      {sheet === 'edit' ? <EditContactSheet id={contact.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'intent' ? <IntentSheet id={contact.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'opportunity' ? (
        <NewOpportunitySheet
          contactId={contact.id}
          aircraftId={primaryAircraft?.id ?? null}
          defaultTitle={primaryAircraft ? `${primaryAircraft.tailNumber} — ${displayName(contact)}` : displayName(contact)}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

function EditContactSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const contact = db.contacts.find((c) => c.id === id)!;

  const [firstName, setFirstName] = useState(contact.firstName);
  const [lastName, setLastName] = useState(contact.lastName);
  const [company, setCompany] = useState(contact.company);
  const [email, setEmail] = useState(contact.email);
  const [phone, setPhone] = useState(contact.phone);
  const [address, setAddress] = useState(contact.address);
  const [address2, setAddress2] = useState(contact.address2 ?? '');
  const [city, setCity] = useState(contact.city);
  const [state, setState] = useState(contact.state);
  const [zip, setZip] = useState(contact.zip);
  const [status, setStatus] = useState<ContactStatus>(contact.status);
  const [prospectStatus, setProspectStatus] = useState<ProspectStatus>(contact.prospectStatus);
  const [types, setTypes] = useState<ContactType[]>(contact.contactTypes);
  const [notes, setNotes] = useState(contact.notes);

  const toggleType = (t: ContactType) =>
    setTypes((current) => (current.includes(t) ? current.filter((x) => x !== t) : [...current, t]));

  const save = () => {
    updateContact(id, {
      firstName: firstName.trim(), lastName: lastName.trim(), company: company.trim(),
      email: email.trim(), phone: phone.trim(), address: address.trim(), address2: address2.trim(),
      city: city.trim(), state: state.trim().toUpperCase(), zip: zip.trim(),
      status, prospectStatus, contactTypes: types, notes,
      needsReview: false,
    });
    toast('Contact updated');
    onClose();
  };

  return (
    <Sheet
      title="Edit contact"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="stack">
        {contact.rawName ? (
          <div className="card card--tight small muted">
            As imported: <span className="secondary">{contact.rawName}</span>
          </div>
        ) : null}
        <div className="form-grid">
          <TextField label="First name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <TextField label="Last name" value={lastName} onChange={setLastName} autoComplete="family-name" />
        </div>
        <TextField label="Company" value={company} onChange={setCompany} autoComplete="organization" />
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" />
        <TextField label="Phone" value={phone} onChange={setPhone} type="tel" inputMode="tel" autoComplete="tel" />
        <TextField label="Address" value={address} onChange={setAddress} autoComplete="address-line1" />
        <TextField label="Address line 2" value={address2} onChange={setAddress2} autoComplete="address-line2" />
        <div className="form-grid">
          <TextField label="City" value={city} onChange={setCity} autoComplete="address-level2" />
          <TextField label="State" value={state} onChange={setState} autoComplete="address-level1" />
          <TextField label="ZIP" value={zip} onChange={setZip} inputMode="numeric" autoComplete="postal-code" />
        </div>
        <SelectField label="Status" value={status} options={CONTACT_STATUSES} onChange={setStatus} />
        <SelectField label="Prospect status" value={prospectStatus} options={PROSPECT_STATUSES} onChange={setProspectStatus} />

        <div className="field">
          <span className="field__label">Relationships</span>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {CONTACT_TYPES.map((t) => (
              <button
                key={t}
                className={`filter-chip${types.includes(t) ? ' is-active' : ''}`}
                onClick={() => toggleType(t)}
                type="button"
              >
                {t}
              </button>
            ))}
          </div>
          <span className="field__hint">A person can be an owner, an insurance client and a buyer at the same time.</span>
        </div>

        <TextArea label="Notes" value={notes} onChange={setNotes} rows={5} />
      </div>
    </Sheet>
  );
}

/** One line for the glance panel. Says nothing rather than guessing. */
function wantsSummary(intent: ContactIntent | undefined): string {
  if (!intent) return 'Not recorded';
  const parts: string[] = [];
  if (intent.buying !== 'Unknown' && intent.buying !== 'Not now') {
    parts.push(intent.wantedAircraft ? `Buying: ${intent.wantedAircraft}` : `Buying: ${intent.buying}`);
  }
  if (intent.selling !== 'Unknown' && intent.selling !== 'Not now') parts.push(`Selling: ${intent.selling}`);
  if (intent.insurance !== 'Unknown' && intent.insurance !== 'Not now') parts.push(`Insurance: ${intent.insurance}`);
  return parts.join(' · ') || 'Not recorded';
}

function IntentSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const contact = db.contacts.find((c) => c.id === id)!;
  const current = contact.intent ?? emptyIntent();

  const [selling, setSelling] = useState<IntentLevel>(current.selling);
  const [sellingNotes, setSellingNotes] = useState(current.sellingNotes ?? '');
  const [buying, setBuying] = useState<IntentLevel>(current.buying);
  const [wantedAircraft, setWantedAircraft] = useState(current.wantedAircraft ?? '');
  const [budget, setBudget] = useState(current.budget ?? '');
  const [mission, setMission] = useState(current.mission ?? '');
  const [timeline, setTimeline] = useState(current.timeline ?? '');
  const [insurance, setInsurance] = useState<IntentLevel>(current.insurance);
  const [insuranceNotes, setInsuranceNotes] = useState(current.insuranceNotes ?? '');

  const save = () => {
    updateContact(id, {
      intent: {
        selling,
        sellingNotes: sellingNotes.trim(),
        buying,
        wantedAircraft: wantedAircraft.trim(),
        budget: budget.trim(),
        mission: mission.trim(),
        timeline: timeline.trim(),
        insurance,
        insuranceNotes: insuranceNotes.trim(),
      },
    });
    toast('Saved what they want');
    onClose();
  };

  return (
    <Sheet
      title="What they want"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          Everything here is optional. It exists so that three months from now you still know why this
          person is worth a call.
        </p>

        <SelectField label="May sell an aircraft" value={selling} options={INTENT_LEVELS} onChange={setSelling} />
        <TextField
          label="Selling notes"
          value={sellingNotes}
          onChange={setSellingNotes}
          placeholder="Wants 2.1M, would move by spring"
        />

        <div className="divider" />
        <SelectField label="Looking to buy" value={buying} options={INTENT_LEVELS} onChange={setBuying} />
        <TextField label="What they want" value={wantedAircraft} onChange={setWantedAircraft} placeholder="Pressurised single, PC-12 or TBM" />
        <div className="form-grid">
          <TextField label="Budget" value={budget} onChange={setBudget} placeholder="$3–4M" />
          <TextField label="Timeline" value={timeline} onChange={setTimeline} placeholder="Next 6 months" />
        </div>
        <TextField label="Mission" value={mission} onChange={setMission} placeholder="Family trips, 700nm legs, short strip at home" />

        <div className="divider" />
        <SelectField label="Insurance conversation" value={insurance} options={INTENT_LEVELS} onChange={setInsurance} />
        <TextArea
          label="Insurance notes"
          value={insuranceNotes}
          onChange={setInsuranceNotes}
          rows={3}
          placeholder="Unhappy with the hull value on the current policy. Renews in November."
        />
      </div>
    </Sheet>
  );
}
