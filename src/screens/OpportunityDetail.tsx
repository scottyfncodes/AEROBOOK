import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconCalendar, IconEdit, IconMail, IconNote, IconShield } from '../components/Icons';
import { ActivitySheet, FilesSection, FollowUpList, FollowUpSheet, Timeline } from '../components/detail';
import { EmailComposer } from '../components/EmailComposer';
import {
  Chip, ConfirmButton, EmptyState, KeyValue, SelectField, Sheet, TextArea, TextField, useToast,
} from '../components/ui';
import { useDatabase } from '../data/useStore';
import { deleteActivity, deleteOpportunity, updateOpportunity } from '../data/store';
import {
  OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES,
  type FollowUp, type OpportunityStatus, type OpportunityType,
} from '../data/types';
import { timelineFor } from '../lib/selectors';
import { displayName } from '../lib/names';
import { formatDate } from '../lib/dates';

export default function OpportunityDetail() {
  const { id = '' } = useParams();
  const db = useDatabase();
  const navigate = useNavigate();
  const toast = useToast();

  const opportunity = db.opportunities.find((o) => o.id === id);
  const [sheet, setSheet] = useState<'edit' | 'insurance' | 'activity' | 'followUp' | 'email' | null>(null);
  const [editingFollowUp, setEditingFollowUp] = useState<FollowUp | undefined>();

  const timeline = useMemo(
    () => (opportunity ? timelineFor(db, { opportunityId: opportunity.id }) : { activities: [], followUps: [] }),
    [db, opportunity],
  );

  if (!opportunity) {
    return (
      <>
        <AppBar title="Opportunity" back />
        <main className="page">
          <EmptyState title="That opportunity is not in the book" action={<Link className="btn" to="/opportunities">All opportunities</Link>} />
        </main>
      </>
    );
  }

  const contact = opportunity.contactId ? db.contacts.find((c) => c.id === opportunity.contactId) : undefined;
  const aircraft = opportunity.aircraftId ? db.aircraft.find((a) => a.id === opportunity.aircraftId) : undefined;
  const files = db.files.filter((f) => f.opportunityId === opportunity.id);
  const ins = opportunity.insurance;
  const hasInsuranceDetail = ins && Object.values(ins).some(Boolean);

  return (
    <>
      <AppBar
        title={opportunity.title || opportunity.type}
        back
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setSheet('edit')} aria-label="Edit opportunity">
            <IconEdit />
          </button>
        }
      />
      <main className="page stack stack--lg">
        <section className="stack stack--sm">
          <h1 style={{ fontSize: 24 }}>{opportunity.title || `${opportunity.type} opportunity`}</h1>
          <div className="row row--wrap" style={{ gap: 6 }}>
            <Chip tone="accent">{opportunity.type}</Chip>
            <Chip tone={opportunity.status === 'Won' ? 'success' : opportunity.status === 'Lost' ? 'danger' : undefined}>
              {opportunity.status}
            </Chip>
          </div>
        </section>

        <section className="btn-group">
          <button className="btn btn--primary" onClick={() => setSheet('email')} disabled={!contact}>
            <IconMail /> Email
          </button>
          <button className="btn" onClick={() => setSheet('activity')}>
            <IconNote /> Log activity
          </button>
          <button className="btn" onClick={() => { setEditingFollowUp(undefined); setSheet('followUp'); }}>
            <IconCalendar /> Follow up
          </button>
          <button className="btn" onClick={() => setSheet('insurance')}>
            <IconShield /> Insurance detail
          </button>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Linked to</h2>
          <div className="card">
            <KeyValue k="Contact">
              {contact ? <Link to={`/contacts/${contact.id}`}>{displayName(contact)}</Link> : <span className="muted">None</span>}
            </KeyValue>
            <KeyValue k="Aircraft">
              {aircraft ? <Link className="tail" to={`/aircraft/${aircraft.id}`}>{aircraft.tailNumber}</Link> : <span className="muted">None</span>}
            </KeyValue>
            <KeyValue k="Opened">{formatDate(opportunity.openedAt)}</KeyValue>
            {opportunity.estimatedValue ? <KeyValue k="Estimated value">{opportunity.estimatedValue}</KeyValue> : null}
            {opportunity.followUpDate ? <KeyValue k="Follow-up">{formatDate(opportunity.followUpDate)}</KeyValue> : null}
          </div>
        </section>

        {hasInsuranceDetail ? (
          <section className="stack stack--sm">
            <h2 className="section-title">Insurance</h2>
            <div className="card">
              {ins?.currentInsurer ? <KeyValue k="Current insurer">{ins.currentInsurer}</KeyValue> : null}
              {ins?.carrier ? <KeyValue k="Quoting carrier">{ins.carrier}</KeyValue> : null}
              {ins?.policyNumber ? <KeyValue k="Policy number">{ins.policyNumber}</KeyValue> : null}
              {ins?.policyStatus ? <KeyValue k="Policy status">{ins.policyStatus}</KeyValue> : null}
              {ins?.renewalDate ? <KeyValue k="Renewal">{formatDate(ins.renewalDate)}</KeyValue> : null}
              {ins?.hullValue ? <KeyValue k="Hull value">{ins.hullValue}</KeyValue> : null}
              {ins?.premium ? <KeyValue k="Premium">{ins.premium}</KeyValue> : null}
              {ins?.deductible ? <KeyValue k="Deductible">{ins.deductible}</KeyValue> : null}
              {ins?.liabilityLimit ? <KeyValue k="Liability limit">{ins.liabilityLimit}</KeyValue> : null}
              {ins?.coverageNotes ? <KeyValue k="Coverage notes">{ins.coverageNotes}</KeyValue> : null}
            </div>
          </section>
        ) : null}

        {opportunity.notes ? (
          <section className="stack stack--sm">
            <h2 className="section-title">Notes</h2>
            <div className="card small secondary" style={{ whiteSpace: 'pre-wrap' }}>{opportunity.notes}</div>
          </section>
        ) : null}

        {timeline.followUps.some((f) => !f.completed) ? (
          <section className="stack stack--sm">
            <h2 className="section-title">Follow-ups</h2>
            <FollowUpList followUps={timeline.followUps} onEdit={(f) => { setEditingFollowUp(f); setSheet('followUp'); }} />
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
          <h2 className="section-title">Files</h2>
          <FilesSection files={files} links={{ opportunityId: opportunity.id }} />
        </section>

        <section>
          <ConfirmButton
            label="Delete this opportunity"
            confirmLabel="Tap again to delete permanently"
            className="btn btn--danger btn--block"
            onConfirm={() => { deleteOpportunity(opportunity.id); toast('Opportunity deleted'); navigate('/opportunities'); }}
          />
        </section>
      </main>

      {sheet === 'edit' ? <EditOpportunitySheet id={opportunity.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'insurance' ? <InsuranceSheet id={opportunity.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'activity' ? (
        <ActivitySheet
          links={{ opportunityId: opportunity.id, contactId: contact?.id ?? null, aircraftId: aircraft?.id ?? null }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'followUp' ? (
        <FollowUpSheet
          links={{ opportunityId: opportunity.id, contactId: contact?.id ?? null, aircraftId: aircraft?.id ?? null }}
          existing={editingFollowUp}
          defaultNote={opportunity.title || `Follow up on this ${opportunity.type.toLowerCase()}`}
          onClose={() => { setSheet(null); setEditingFollowUp(undefined); }}
        />
      ) : null}
      {sheet === 'email' ? (
        <EmailComposer
          contact={contact ?? null}
          aircraft={aircraft ?? null}
          opportunityId={opportunity.id}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </>
  );
}

function EditOpportunitySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const o = db.opportunities.find((x) => x.id === id)!;

  const [title, setTitle] = useState(o.title);
  const [type, setType] = useState<OpportunityType>(o.type);
  const [status, setStatus] = useState<OpportunityStatus>(o.status);
  const [estimatedValue, setEstimatedValue] = useState(o.estimatedValue ?? '');
  const [followUpDate, setFollowUpDate] = useState(o.followUpDate ?? '');
  const [notes, setNotes] = useState(o.notes);
  const [contactId, setContactId] = useState(o.contactId ?? '');
  const [aircraftId, setAircraftId] = useState(o.aircraftId ?? '');

  const contacts = useMemo(
    () => [{ value: '', label: 'No contact' }, ...db.contacts.map((c) => ({ value: c.id, label: displayName(c) })).sort((a, b) => a.label.localeCompare(b.label))],
    [db.contacts],
  );
  const aircraft = useMemo(
    () => [{ value: '', label: 'No aircraft' }, ...db.aircraft.map((a) => ({ value: a.id, label: a.tailNumber })).sort((a, b) => a.label.localeCompare(b.label))],
    [db.aircraft],
  );

  return (
    <Sheet
      title="Edit opportunity"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => {
              updateOpportunity(id, {
                title: title.trim(), type, status, estimatedValue: estimatedValue.trim(),
                followUpDate: followUpDate || undefined, notes,
                contactId: contactId || null, aircraftId: aircraftId || null,
              });
              toast('Opportunity updated');
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Title" value={title} onChange={setTitle} />
        <SelectField label="Type" value={type} options={OPPORTUNITY_TYPES} onChange={setType} />
        <SelectField label="Status" value={status} options={OPPORTUNITY_STATUSES} onChange={setStatus} />
        <SelectField label="Contact" value={contactId} options={contacts} onChange={setContactId} />
        <SelectField label="Aircraft" value={aircraftId} options={aircraft} onChange={setAircraftId} />
        <TextField label="Estimated value" value={estimatedValue} onChange={setEstimatedValue} />
        <TextField label="Follow-up date" value={followUpDate} onChange={setFollowUpDate} type="date" />
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={5} />
      </div>
    </Sheet>
  );
}

function InsuranceSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const o = db.opportunities.find((x) => x.id === id)!;
  const ins = o.insurance ?? {};

  const [currentInsurer, setCurrentInsurer] = useState(ins.currentInsurer ?? '');
  const [carrier, setCarrier] = useState(ins.carrier ?? '');
  const [policyNumber, setPolicyNumber] = useState(ins.policyNumber ?? '');
  const [policyStatus, setPolicyStatus] = useState(ins.policyStatus ?? '');
  const [renewalDate, setRenewalDate] = useState(ins.renewalDate ?? '');
  const [hullValue, setHullValue] = useState(ins.hullValue ?? '');
  const [premium, setPremium] = useState(ins.premium ?? '');
  const [deductible, setDeductible] = useState(ins.deductible ?? '');
  const [liabilityLimit, setLiabilityLimit] = useState(ins.liabilityLimit ?? '');
  const [coverageNotes, setCoverageNotes] = useState(ins.coverageNotes ?? '');

  return (
    <Sheet
      title="Insurance detail"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => {
              updateOpportunity(id, {
                insurance: {
                  currentInsurer: currentInsurer.trim(), carrier: carrier.trim(),
                  policyNumber: policyNumber.trim(), policyStatus: policyStatus.trim(),
                  renewalDate: renewalDate || undefined, hullValue: hullValue.trim(),
                  premium: premium.trim(), deductible: deductible.trim(),
                  liabilityLimit: liabilityLimit.trim(), coverageNotes: coverageNotes.trim(),
                },
              });
              toast('Insurance detail saved');
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">Every field is optional. Fill in what you know.</p>
        <TextField label="Current insurer" value={currentInsurer} onChange={setCurrentInsurer} />
        <TextField label="Quoting carrier" value={carrier} onChange={setCarrier} />
        <TextField label="Policy number" value={policyNumber} onChange={setPolicyNumber} />
        <TextField label="Policy status" value={policyStatus} onChange={setPolicyStatus} placeholder="In force, lapsed, quoted…" />
        <TextField label="Renewal date" value={renewalDate} onChange={setRenewalDate} type="date" />
        <div className="form-grid">
          <TextField label="Hull value" value={hullValue} onChange={setHullValue} />
          <TextField label="Premium" value={premium} onChange={setPremium} />
        </div>
        <div className="form-grid">
          <TextField label="Deductible" value={deductible} onChange={setDeductible} />
          <TextField label="Liability limit" value={liabilityLimit} onChange={setLiabilityLimit} />
        </div>
        <TextArea label="Coverage notes" value={coverageNotes} onChange={setCoverageNotes} rows={4} />
      </div>
    </Sheet>
  );
}
