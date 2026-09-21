import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconCalendar, IconEdit, IconMail, IconNote } from '../components/Icons';
import { ActivitySheet, FilesSection, FollowUpList, FollowUpSheet, Timeline } from '../components/detail';
import { InsuranceSection } from '../components/insurance';
import { StageControl } from '../components/opportunity';
import { EmailComposer } from '../components/EmailComposer';
import {
  Chip, ConfirmButton, EmptyState, SelectField, Sheet, TextArea, TextField, useToast,
} from '../components/ui';
import { useDatabase } from '../data/useStore';
import { deleteActivity, deleteOpportunity, updateOpportunity } from '../data/store';
import {
  OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES,
  type Activity, type FollowUp, type OpportunityStatus, type OpportunityType,
} from '../data/types';
import { nextFollowUpFor, timelineFor } from '../lib/selectors';
import { policiesFor } from '../lib/insurance';
import { displayName } from '../lib/names';
import { formatDate, relativeDue } from '../lib/dates';

export default function OpportunityDetail() {
  const { id = '' } = useParams();
  const db = useDatabase();
  const navigate = useNavigate();
  const toast = useToast();

  const opportunity = db.opportunities.find((o) => o.id === id);
  const [sheet, setSheet] = useState<'edit' | 'activity' | 'followUp' | 'email' | null>(null);
  const [editingFollowUp, setEditingFollowUp] = useState<FollowUp | undefined>();
  const [editingActivity, setEditingActivity] = useState<Activity | undefined>();

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
  const policies = policiesFor(db, { opportunityId: opportunity.id });
  const files = db.files.filter((f) => f.opportunityId === opportunity.id);
  const nextFollowUp = nextFollowUpFor(db, { opportunityId: opportunity.id });
  const isInsurance = opportunity.type.includes('Insurance');

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
            {opportunity.estimatedValue ? <Chip>{opportunity.estimatedValue}</Chip> : null}
          </div>
        </section>

        {/* Moving a deal along is one tap, not a trip through the edit form. */}
        <section className="stack stack--sm" aria-label="Pipeline">
          <h2 className="section-title">Stage</h2>
          <StageControl opportunity={opportunity} />
        </section>

        <section className="glance" aria-label="At a glance">
          {contact ? (
            <Link className="glance__cell" to={`/contacts/${contact.id}`}>
              <span className="glance__label">Contact</span>
              <span className="glance__value strong truncate">{displayName(contact)}</span>
              <span className="xsmall muted truncate">{contact.email || contact.phone || '—'}</span>
            </Link>
          ) : (
            <div className="glance__cell">
              <span className="glance__label">Contact</span>
              <span className="glance__value muted">None linked</span>
            </div>
          )}
          {aircraft ? (
            <Link className="glance__cell" to={`/aircraft/${aircraft.id}`}>
              <span className="glance__label">Aircraft</span>
              <span className="glance__value tail strong truncate">{aircraft.tailNumber}</span>
              <span className="xsmall muted truncate">
                {[aircraft.year, aircraft.make, aircraft.model].filter(Boolean).join(' ') || '—'}
              </span>
            </Link>
          ) : (
            <div className="glance__cell">
              <span className="glance__label">Aircraft</span>
              <span className="glance__value muted">None linked</span>
            </div>
          )}
          <div className="glance__cell">
            <span className="glance__label">Next action</span>
            <span className={`glance__value truncate${opportunity.nextAction ? ' strong' : ' muted'}`}>
              {opportunity.nextAction || 'Not set'}
            </span>
            <span className="xsmall muted">
              {nextFollowUp ? `Follow-up ${relativeDue(nextFollowUp.dueDate).toLowerCase()}` : 'No follow-up scheduled'}
            </span>
          </div>
          <div className="glance__cell">
            <span className="glance__label">Opened</span>
            <span className="glance__value">{formatDate(opportunity.openedAt)}</span>
            <span className="xsmall muted">{opportunity.estimatedValue || 'No value estimated'}</span>
          </div>
        </section>

        <section className="btn-group">
          <button className="btn btn--primary" onClick={() => setSheet('email')} disabled={!contact}>
            <IconMail /> Email
          </button>
          <button className="btn" onClick={() => { setEditingActivity(undefined); setSheet('activity'); }}>
            <IconNote /> Log activity
          </button>
          <button className="btn" onClick={() => { setEditingFollowUp(undefined); setSheet('followUp'); }}>
            <IconCalendar /> Follow up
          </button>
        </section>

        {isInsurance || policies.length > 0 ? (
          <InsuranceSection
            policies={policies}
            links={{
              opportunityId: opportunity.id,
              contactId: opportunity.contactId,
              aircraftId: opportunity.aircraftId,
            }}
            emptyBody="No policy attached to this deal yet. Add one and its renewal date drives the countdown everywhere it appears."
            onFollowUp={() => { setEditingFollowUp(undefined); setSheet('followUp'); }}
          />
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
            onEditActivity={(activity) => { setEditingActivity(activity); setSheet('activity'); }}
          />
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Documents</h2>
          <FilesSection
            files={files}
            links={{ opportunityId: opportunity.id }}
            defaultCategory={isInsurance ? 'Insurance' : 'Brokerage'}
          />
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
      {sheet === 'activity' ? (
        <ActivitySheet
          links={{ opportunityId: opportunity.id, contactId: contact?.id ?? null, aircraftId: aircraft?.id ?? null }}
          existing={editingActivity}
          onClose={() => { setSheet(null); setEditingActivity(undefined); }}
        />
      ) : null}
      {sheet === 'followUp' ? (
        <FollowUpSheet
          links={{ opportunityId: opportunity.id, contactId: contact?.id ?? null, aircraftId: aircraft?.id ?? null }}
          existing={editingFollowUp}
          defaultNote={opportunity.nextAction || opportunity.title || `Follow up on this ${opportunity.type.toLowerCase()}`}
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
  const [nextAction, setNextAction] = useState(o.nextAction ?? '');
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
                nextAction: nextAction.trim(), notes,
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
        <TextField
          label="Next action"
          value={nextAction}
          onChange={setNextAction}
          placeholder="Send the renewal comparison"
          hint="Set a follow-up too if it needs a date."
        />
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={5} />
      </div>
    </Sheet>
  );
}
