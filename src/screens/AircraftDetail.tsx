import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import {
  IconCalendar, IconEdit, IconMail, IconNote, IconPhone, IconPlus, IconShield, IconTarget,
} from '../components/Icons';
import {
  ActivitySheet, ExternalLinkList, FilesSection, FollowUpList, FollowUpSheet, Timeline,
} from '../components/detail';
import { InsuranceSection } from '../components/insurance';
import { NewOpportunitySheet } from '../components/opportunity';
import { EmailComposer } from '../components/EmailComposer';
import {
  Banner, Chip, ConfirmButton, EmptyState, KeyValue, SelectField, Sheet, TextArea, TextField, useToast,
} from '../components/ui';
import { useDatabase } from '../data/useStore';
import { deleteActivity, deleteAircraft, setAircraftOwner, updateAircraft } from '../data/store';
import { AIRCRAFT_STATUSES, type AircraftStatus, type FollowUp, type InsurancePolicy } from '../data/types';
import { isOpen, nextMove, opportunitiesFor, ownerOf, previousOwners, timelineFor } from '../lib/selectors';
import { policiesFor, policyState } from '../lib/insurance';
import { displayName } from '../lib/names';
import { formatPhone } from '../lib/phone';
import { formatDate, relativeDue } from '../lib/dates';
import { faaRegistryLink, marketLinks, telLink, webSearchLink, type ExternalLink } from '../lib/links';
import { OpportunityRow } from '../components/records';

export default function AircraftDetail() {
  const { id = '' } = useParams();
  const db = useDatabase();
  const navigate = useNavigate();
  const toast = useToast();

  const aircraft = db.aircraft.find((a) => a.id === id);
  const owner = ownerOf(db, aircraft);

  const [sheet, setSheet] = useState<'email' | 'activity' | 'followUp' | 'edit' | 'opportunity' | null>(null);
  const [editingFollowUp, setEditingFollowUp] = useState<FollowUp | undefined>();
  const [followUpNote, setFollowUpNote] = useState('');
  const [followUpPolicyId, setFollowUpPolicyId] = useState<string | null>(null);

  const timeline = useMemo(
    () => (aircraft ? timelineFor(db, { aircraftId: aircraft.id }) : { activities: [], followUps: [] }),
    [db, aircraft],
  );

  const links = useMemo<ExternalLink[]>(() => {
    if (!aircraft) return [];
    const out: ExternalLink[] = [];
    const faa = faaRegistryLink(aircraft.tailNumber);
    if (faa) out.push(faa);
    out.push(...marketLinks(aircraft.make, aircraft.model, aircraft.tailNumber));
    const value = webSearchLink(
      [aircraft.year, aircraft.make, aircraft.model, 'market value'].filter(Boolean).join(' '),
      'Market value research',
    );
    if (value) out.push(value);
    if (aircraft.listingUrl) out.push({ label: 'Listing', url: aircraft.listingUrl, isSearch: false, note: 'Saved on this aircraft' });
    return out;
  }, [aircraft]);

  if (!aircraft) {
    return (
      <>
        <AppBar title="Aircraft" back />
        <main className="page">
          <EmptyState title="That aircraft is not in the book" action={<Link className="btn" to="/aircraft">All aircraft</Link>} />
        </main>
      </>
    );
  }

  const opportunities = opportunitiesFor(db, { aircraftId: aircraft.id });
  const openOpportunity = opportunities.find(isOpen);
  const policies = policiesFor(db, { aircraftId: aircraft.id });
  const primaryPolicy = policies[0];
  const move = nextMove(db, { aircraftId: aircraft.id });
  const files = db.files.filter((f) => f.aircraftId === aircraft.id);
  const history = previousOwners(db, aircraft);
  const description = [aircraft.year, aircraft.make, aircraft.model].filter(Boolean).join(' ');

  const openFollowUp = (note: string, policy?: InsurancePolicy) => {
    setEditingFollowUp(undefined);
    setFollowUpNote(note);
    setFollowUpPolicyId(policy?.id ?? null);
    setSheet('followUp');
  };

  const renewalNote = primaryPolicy
    ? `Insurance renewal — ${aircraft.tailNumber}${primaryPolicy.carrier ? ` (${primaryPolicy.carrier})` : ''}`
    : '';

  return (
    <>
      <AppBar
        title={aircraft.tailNumber}
        back
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setSheet('edit')} aria-label="Edit aircraft">
            <IconEdit />
          </button>
        }
      />
      <main className="page stack stack--lg">
        <section className="stack stack--sm">
          <h1 className="tail" style={{ fontSize: 30, letterSpacing: '0.06em' }}>{aircraft.tailNumber}</h1>
          <div className="secondary">{description || 'Aircraft details unknown'}</div>
          <div className="row row--wrap" style={{ gap: 6 }}>
            <Chip tone={aircraft.status === 'For Sale' ? 'accent' : undefined}>{aircraft.status}</Chip>
            {aircraft.baseAirport ? <Chip>Based {aircraft.baseAirport}</Chip> : null}
            {aircraft.serial ? <Chip>S/N {aircraft.serial}</Chip> : null}
          </div>
        </section>

        {/* Who owns it, what is happening with it, what is the next move. */}
        <section className="glance" aria-label="At a glance">
          {owner ? (
            <Link className="glance__cell" to={`/contacts/${owner.id}`}>
              <span className="glance__label">Owner</span>
              <span className="glance__value strong truncate">{displayName(owner)}</span>
              <span className="xsmall muted truncate">
                {[formatPhone(owner.phone), owner.email].filter(Boolean).join(' · ') || 'No contact details'}
              </span>
            </Link>
          ) : (
            <div className="glance__cell">
              <span className="glance__label">Owner</span>
              <span className="glance__value muted">Not on record</span>
            </div>
          )}

          <div className="glance__cell">
            <span className="glance__label">Insurance</span>
            {primaryPolicy ? (
              <>
                <span className="glance__value strong truncate">
                  {policyState(primaryPolicy).countdown || policyState(primaryPolicy).status}
                </span>
                <span className="xsmall muted truncate">
                  {[primaryPolicy.carrier, primaryPolicy.hullValue ? `Hull ${primaryPolicy.hullValue}` : '']
                    .filter(Boolean)
                    .join(' · ') || 'No carrier recorded'}
                </span>
              </>
            ) : (
              <span className="glance__value muted">Nothing on record</span>
            )}
          </div>

          <div className="glance__cell">
            <span className="glance__label">Brokerage</span>
            <span className="glance__value truncate">
              {aircraft.status === 'For Sale'
                ? aircraft.askingPrice || 'For sale — no asking price'
                : aircraft.status === 'Purchase Prospect'
                  ? 'Purchase prospect'
                  : openOpportunity
                    ? openOpportunity.type
                    : 'No active listing'}
            </span>
            <span className="xsmall muted truncate">
              {openOpportunity ? `${openOpportunity.status} · ${openOpportunity.title || openOpportunity.type}` : '—'}
            </span>
          </div>

          <div className="glance__cell">
            <span className="glance__label">Next move</span>
            {move ? (
              <>
                <span className="glance__value strong truncate">{move.text}</span>
                <span className="xsmall muted">{move.dueDate ? relativeDue(move.dueDate) : 'No date set'}</span>
              </>
            ) : (
              <>
                <span className="glance__value muted">Nothing scheduled</span>
                <button
                  className="xsmall"
                  style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => openFollowUp(`Follow up on ${aircraft.tailNumber}`)}
                >
                  Set a follow-up
                </button>
              </>
            )}
          </div>
        </section>

        <section className="btn-group">
          <button className="btn btn--primary" onClick={() => setSheet('email')} disabled={!owner}>
            <IconMail /> Email owner
          </button>
          <a
            className="btn"
            href={owner?.phone ? telLink(owner.phone) : undefined}
            aria-disabled={!owner?.phone}
            style={!owner?.phone ? { pointerEvents: 'none', opacity: 0.45 } : undefined}
          >
            <IconPhone /> Call
          </a>
          <button className="btn" onClick={() => setSheet('activity')}>
            <IconNote /> Add note
          </button>
          <button className="btn" onClick={() => openFollowUp(`Follow up on ${aircraft.tailNumber}`)}>
            <IconCalendar /> Follow up
          </button>
          <button className="btn" onClick={() => setSheet('opportunity')}>
            <IconTarget /> Add opportunity
          </button>
          {primaryPolicy ? (
            <button className="btn" onClick={() => openFollowUp(renewalNote, primaryPolicy)}>
              <IconShield /> Renewal task
            </button>
          ) : null}
        </section>

        <InsuranceSection
          policies={policies}
          links={{ aircraftId: aircraft.id, contactId: owner?.id ?? null }}
          emptyBody="No insurance on record for this aircraft. Add the carrier and the expiration date and AEROBOOK will count the renewal down for you."
          onFollowUp={(policy) =>
            openFollowUp(
              `Insurance renewal — ${aircraft.tailNumber}${policy.carrier ? ` (${policy.carrier})` : ''}`,
              policy,
            )
          }
        />

        <section className="stack stack--sm">
          <h2 className="section-title">Owner</h2>
          {owner ? (
            <Link className="tile" to={`/contacts/${owner.id}`}>
              <div className="strong">{displayName(owner)}</div>
              <div className="small muted">
                {[owner.company, [owner.city, owner.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="small secondary" style={{ marginTop: 4 }}>
                {[owner.email, formatPhone(owner.phone)].filter(Boolean).join(' · ') || 'No contact details'}
              </div>
            </Link>
          ) : (
            <div className="card stack stack--sm">
              <div className="small muted">No owner on record for this aircraft.</div>
              <OwnerPicker aircraftId={aircraft.id} />
            </div>
          )}
          {history.length > 0 ? (
            <div className="card">
              <div className="section-title">Previous owners</div>
              {history.map(({ contact, endedAt }) => (
                <KeyValue key={contact.id + (endedAt ?? '')} k={endedAt ? `Until ${formatDate(endedAt)}` : 'Previously'}>
                  <Link to={`/contacts/${contact.id}`}>{displayName(contact)}</Link>
                </KeyValue>
              ))}
            </div>
          ) : null}
        </section>

        <section className="stack stack--sm">
          <div className="row row--between">
            <h2 className="section-title">Opportunities</h2>
            <button className="btn btn--sm btn--ghost" onClick={() => setSheet('opportunity')}>
              <IconPlus /> New
            </button>
          </div>
          {opportunities.length === 0 ? (
            <div className="card small muted">No opportunities against this aircraft yet.</div>
          ) : (
            <div className="list">
              {opportunities.map((o) => (
                <OpportunityRow
                  key={o.id}
                  opportunity={o}
                  contact={o.contactId ? db.contacts.find((c) => c.id === o.contactId) : undefined}
                  aircraft={aircraft}
                />
              ))}
            </div>
          )}
        </section>

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

        <section className="stack stack--sm">
          <h2 className="section-title">Aircraft record</h2>
          <div className="card">
            <KeyValue k="Tail">{aircraft.tailNumber}</KeyValue>
            {aircraft.year ? <KeyValue k="Year">{aircraft.year}</KeyValue> : null}
            {aircraft.make ? <KeyValue k="Make">{aircraft.make}</KeyValue> : null}
            {aircraft.model ? <KeyValue k="Model">{aircraft.model}</KeyValue> : null}
            {aircraft.serial ? <KeyValue k="Serial">{aircraft.serial}</KeyValue> : null}
            {aircraft.baseAirport ? <KeyValue k="Base airport">{aircraft.baseAirport}</KeyValue> : null}
            {aircraft.askingPrice ? <KeyValue k="Asking price">{aircraft.askingPrice}</KeyValue> : null}
            {aircraft.targetPrice ? <KeyValue k="Target price">{aircraft.targetPrice}</KeyValue> : null}
            {aircraft.listingStatus ? <KeyValue k="Listing">{aircraft.listingStatus}</KeyValue> : null}
            {aircraft.source ? <KeyValue k="Source">{aircraft.source}</KeyValue> : null}
            <KeyValue k="Added">{formatDate(aircraft.createdAt)}</KeyValue>
            <KeyValue k="Updated">{formatDate(aircraft.updatedAt)}</KeyValue>
            {Object.entries(aircraft.custom).map(([k, v]) => (
              <KeyValue key={k} k={k}>{v}</KeyValue>
            ))}
          </div>
          {aircraft.notes ? (
            <div className="card">
              <div className="section-title">Notes</div>
              <div className="small secondary" style={{ whiteSpace: 'pre-wrap' }}>{aircraft.notes}</div>
            </div>
          ) : null}
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Documents</h2>
          <FilesSection files={files} links={{ aircraftId: aircraft.id }} defaultCategory="Aircraft" />
        </section>

        <ExternalLinkList links={links} title="Links" />

        <section>
          <ConfirmButton
            label="Delete this aircraft"
            confirmLabel="Tap again to delete permanently"
            className="btn btn--danger btn--block"
            onConfirm={() => {
              deleteAircraft(aircraft.id);
              toast(`${aircraft.tailNumber} deleted`);
              navigate('/aircraft');
            }}
          />
        </section>
      </main>

      {sheet === 'email' ? (
        <EmailComposer contact={owner ?? null} aircraft={aircraft} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'activity' ? (
        <ActivitySheet
          links={{ aircraftId: aircraft.id, contactId: owner?.id ?? null }}
          defaultSubject={aircraft.tailNumber}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'followUp' ? (
        <FollowUpSheet
          links={{
            aircraftId: aircraft.id,
            contactId: owner?.id ?? null,
            opportunityId: openOpportunity?.id ?? null,
            insurancePolicyId: followUpPolicyId,
          }}
          existing={editingFollowUp}
          defaultNote={followUpNote || `Follow up on ${aircraft.tailNumber}`}
          onClose={() => { setSheet(null); setEditingFollowUp(undefined); setFollowUpPolicyId(null); }}
        />
      ) : null}
      {sheet === 'edit' ? <EditAircraftSheet id={aircraft.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'opportunity' ? (
        <NewOpportunitySheet
          aircraftId={aircraft.id}
          contactId={owner?.id ?? null}
          defaultTitle={`${aircraft.tailNumber}${description ? ` — ${description}` : ''}`}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

function OwnerPicker({ aircraftId }: { aircraftId: string }) {
  const db = useDatabase();
  const toast = useToast();
  const [value, setValue] = useState('');
  const options = useMemo(
    () => [{ value: '', label: 'Choose a contact…' }, ...db.contacts
      .map((c) => ({ value: c.id, label: displayName(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))],
    [db.contacts],
  );
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="grow">
        <SelectField label="Set owner" value={value} options={options} onChange={setValue} />
      </div>
      <button
        className="btn"
        disabled={!value}
        onClick={() => { setAircraftOwner(aircraftId, value); toast('Owner linked'); }}
      >
        Link
      </button>
    </div>
  );
}

function EditAircraftSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const aircraft = db.aircraft.find((a) => a.id === id)!;
  const currentOwnerId = ownerOf(db, aircraft)?.id ?? '';

  const [tailNumber, setTailNumber] = useState(aircraft.tailNumber);
  const [year, setYear] = useState(aircraft.year);
  const [make, setMake] = useState(aircraft.make);
  const [model, setModel] = useState(aircraft.model);
  const [serial, setSerial] = useState(aircraft.serial ?? '');
  const [baseAirport, setBaseAirport] = useState(aircraft.baseAirport ?? '');
  const [status, setStatus] = useState<AircraftStatus>(aircraft.status);
  const [notes, setNotes] = useState(aircraft.notes);
  const [askingPrice, setAskingPrice] = useState(aircraft.askingPrice ?? '');
  const [targetPrice, setTargetPrice] = useState(aircraft.targetPrice ?? '');
  const [listingStatus, setListingStatus] = useState(aircraft.listingStatus ?? '');
  const [listingUrl, setListingUrl] = useState(aircraft.listingUrl ?? '');
  const [ownerId, setOwnerId] = useState(currentOwnerId);

  const owners = useMemo(
    () => [{ value: '', label: 'No owner' }, ...db.contacts
      .map((c) => ({ value: c.id, label: displayName(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))],
    [db.contacts],
  );

  const badUrl = listingUrl.trim() !== '' && !/^https?:\/\//i.test(listingUrl.trim());

  const save = () => {
    updateAircraft(id, {
      tailNumber, year: year.trim(), make: make.trim(), model: model.trim(), serial: serial.trim(),
      baseAirport: baseAirport.trim().toUpperCase(),
      status, notes, askingPrice: askingPrice.trim(), targetPrice: targetPrice.trim(),
      listingStatus: listingStatus.trim(), listingUrl: badUrl ? '' : listingUrl.trim(),
    });
    if (ownerId !== currentOwnerId) setAircraftOwner(id, ownerId || null);
    toast('Aircraft updated');
    onClose();
  };

  return (
    <Sheet
      title="Edit aircraft"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Tail number" value={tailNumber} onChange={setTailNumber} />
        <div className="form-grid">
          <TextField label="Year" value={year} onChange={setYear} inputMode="numeric" />
          <TextField label="Make" value={make} onChange={setMake} />
        </div>
        <div className="form-grid">
          <TextField label="Model" value={model} onChange={setModel} />
          <TextField label="Serial" value={serial} onChange={setSerial} />
        </div>
        <TextField label="Base airport" value={baseAirport} onChange={setBaseAirport} placeholder="KSBA" hint="Identifier, not a city." />
        <SelectField label="Status" value={status} options={AIRCRAFT_STATUSES} onChange={setStatus} />
        <SelectField label="Owner" value={ownerId} options={owners} onChange={setOwnerId} />
        {ownerId !== currentOwnerId && currentOwnerId ? (
          <Banner tone="info">The current owner stays on the record as a previous owner.</Banner>
        ) : null}

        <div className="divider" />
        <div className="section-title">Brokerage</div>
        <div className="form-grid">
          <TextField label="Asking price" value={askingPrice} onChange={setAskingPrice} inputMode="text" />
          <TextField label="Target price" value={targetPrice} onChange={setTargetPrice} inputMode="text" />
        </div>
        <TextField label="Listing status" value={listingStatus} onChange={setListingStatus} placeholder="Researching, listed, under contract…" />
        <TextField
          label="Listing link"
          value={listingUrl}
          onChange={setListingUrl}
          inputMode="url"
          error={badUrl ? 'Links must start with http:// or https://' : undefined}
        />

        <TextArea label="Notes" value={notes} onChange={setNotes} rows={5} />
      </div>
    </Sheet>
  );
}
