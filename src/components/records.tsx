/** Record-shaped UI: the rows and cards that show contacts, aircraft and tasks. */
import { Link } from 'react-router-dom';
import type { Aircraft, Contact, FollowUp, Opportunity, ProspectStatus } from '../data/types';
import { displayName } from '../lib/names';
import { formatPhone } from '../lib/phone';
import { dueBucket, relativeDue } from '../lib/dates';
import { IconChevronRight, IconPlane } from './Icons';
import { Chip } from './ui';

export function statusTone(status: ProspectStatus): 'accent' | 'info' | 'success' | 'warn' | 'danger' | undefined {
  switch (status) {
    case 'New': return 'info';
    case 'Contacted': return undefined;
    case 'Follow-Up': return 'warn';
    case 'Engaged': return 'accent';
    case 'Quote': return 'accent';
    case 'Client': return 'success';
    case 'Not Interested': return 'danger';
    default: return undefined;
  }
}

export function aircraftLabel(a: Pick<Aircraft, 'year' | 'make' | 'model'>): string {
  return [a.year, a.make, a.model].filter(Boolean).join(' ');
}

export function ContactRow({ contact, aircraft }: { contact: Contact; aircraft?: Aircraft[] }) {
  const tails = (aircraft ?? []).map((a) => a.tailNumber);
  const location = [contact.city, contact.state].filter(Boolean).join(', ');
  return (
    <Link className="tile" to={`/contacts/${contact.id}`}>
      <div className="row">
        <div className="grow">
          <div className="row row--between">
            <span className="strong truncate">{displayName(contact)}</span>
            {contact.needsReview ? <Chip tone="warn">Review</Chip> : null}
          </div>
          <div className="small muted truncate">
            {[contact.company, location].filter(Boolean).join(' · ') || contact.email || formatPhone(contact.phone) || 'No details yet'}
          </div>
          {tails.length > 0 ? (
            <div className="row row--wrap" style={{ marginTop: 6, gap: 6 }}>
              {tails.slice(0, 3).map((t) => <Chip key={t}>{t}</Chip>)}
              {tails.length > 3 ? <Chip>+{tails.length - 3}</Chip> : null}
            </div>
          ) : null}
        </div>
        <IconChevronRight className="muted" style={{ width: 18, height: 18, flex: 'none' }} />
      </div>
    </Link>
  );
}

export function AircraftRow({ aircraft, owner }: { aircraft: Aircraft; owner?: Contact }) {
  return (
    <Link className="tile" to={`/aircraft/${aircraft.id}`}>
      <div className="row">
        <div className="grow">
          <div className="row row--between">
            <span className="tail strong">{aircraft.tailNumber}</span>
            {aircraft.status !== 'Unknown' ? <Chip>{aircraft.status}</Chip> : null}
          </div>
          <div className="small secondary truncate">{aircraftLabel(aircraft) || 'Aircraft details unknown'}</div>
          <div className="small muted truncate">{owner ? displayName(owner) : 'No owner on record'}</div>
        </div>
        <IconChevronRight className="muted" style={{ width: 18, height: 18, flex: 'none' }} />
      </div>
    </Link>
  );
}

export function ProspectRow({
  contact,
  aircraft,
  followUp,
  onStatusChange,
}: {
  contact: Contact;
  aircraft?: Aircraft;
  followUp?: FollowUp;
  onStatusChange: (status: ProspectStatus) => void;
}) {
  const location = [contact.city, contact.state].filter(Boolean).join(', ');
  return (
    <div className="card stack stack--sm">
      <div className="row">
        <Link className="grow" to={`/contacts/${contact.id}`} style={{ color: 'inherit' }}>
          <div className="strong truncate">{displayName(contact)}</div>
          <div className="small muted truncate">{location || contact.email || 'No location'}</div>
        </Link>
        {aircraft ? (
          <Link to={`/aircraft/${aircraft.id}`} className="row" style={{ gap: 6, color: 'var(--text-secondary)' }}>
            <IconPlane style={{ width: 16, height: 16 }} />
            <span className="tail small">{aircraft.tailNumber}</span>
          </Link>
        ) : null}
      </div>

      <div className="small muted truncate">
        {[aircraft ? aircraftLabel(aircraft) : '', contact.email, formatPhone(contact.phone)].filter(Boolean).join(' · ') || '—'}
      </div>

      <div className="row row--wrap" style={{ gap: 6 }}>
        <span className="xsmall muted">
          {contact.lastContactedAt ? `Last contact ${relativeDue(contact.lastContactedAt)}` : 'Never contacted'}
        </span>
        {followUp ? (
          <Chip tone={dueBucket(followUp.dueDate) === 'overdue' ? 'danger' : dueBucket(followUp.dueDate) === 'today' ? 'warn' : 'info'}>
            {relativeDue(followUp.dueDate)}
          </Chip>
        ) : null}
      </div>

      <select
        className="select"
        value={contact.prospectStatus}
        onChange={(e) => onStatusChange(e.target.value as ProspectStatus)}
        aria-label={`Prospect status for ${displayName(contact)}`}
      >
        {(['New', 'Contacted', 'Follow-Up', 'Engaged', 'Quote', 'Client', 'Closed', 'Not Interested'] as ProspectStatus[]).map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
    </div>
  );
}

export function OpportunityRow({
  opportunity, contact, aircraft,
}: {
  opportunity: Opportunity;
  contact?: Contact;
  aircraft?: Aircraft;
}) {
  return (
    <Link className="tile" to={`/opportunities/${opportunity.id}`}>
      <div className="row">
        <div className="grow">
          <div className="row row--between">
            <span className="strong truncate">{opportunity.title || `${opportunity.type} opportunity`}</span>
            <Chip tone={opportunity.status === 'Won' ? 'success' : opportunity.status === 'Lost' ? 'danger' : 'accent'}>
              {opportunity.status}
            </Chip>
          </div>
          <div className="small muted truncate">
            {[opportunity.type, contact ? displayName(contact) : '', aircraft?.tailNumber].filter(Boolean).join(' · ')}
          </div>
        </div>
        <IconChevronRight className="muted" style={{ width: 18, height: 18, flex: 'none' }} />
      </div>
    </Link>
  );
}
