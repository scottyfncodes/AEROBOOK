import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconBell, IconCheck, IconTrash } from '../components/Icons';
import { FollowUpSheet } from '../components/detail';
import { Chip, EmptyState, Metric, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { completeFollowUp, deleteFollowUp } from '../data/store';
import { bucketFollowUps, followUpSubject, openFollowUps } from '../lib/selectors';
import { formatDate, relativeDue } from '../lib/dates';
import type { FollowUp } from '../data/types';

export default function FollowUps() {
  const db = useDatabase();
  const toast = useToast();
  const [showCompleted, setShowCompleted] = useState(false);
  const [editing, setEditing] = useState<FollowUp | undefined>();

  const buckets = useMemo(() => bucketFollowUps(openFollowUps(db)), [db]);
  const completed = useMemo(
    () => db.followUps.filter((f) => f.completed).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    [db.followUps],
  );

  const total = buckets.overdue.length + buckets.today.length + buckets.upcoming.length;

  const Group = ({ title, items, tone }: { title: string; items: FollowUp[]; tone?: 'danger' | 'warn' | 'info' }) => {
    if (items.length === 0) return null;
    return (
      <section className="stack stack--sm">
        <h2 className="section-title">{title}</h2>
        <div className="list">
          {items.map((f) => {
            const contact = f.contactId ? db.contacts.find((c) => c.id === f.contactId) : undefined;
            const aircraft = f.aircraftId ? db.aircraft.find((a) => a.id === f.aircraftId) : undefined;
            const to = aircraft ? `/aircraft/${aircraft.id}` : contact ? `/contacts/${contact.id}` : '/follow-ups';
            return (
              <div className="card stack stack--sm" key={f.id}>
                <div className="row row--between">
                  <Link className="strong truncate" to={to} style={{ color: 'inherit' }}>
                    {followUpSubject(db, f)}
                  </Link>
                  <Chip tone={tone}>{relativeDue(f.dueDate)}</Chip>
                </div>
                <div className="small secondary">{f.note || 'Follow up'}</div>
                <div className="xsmall muted">Due {formatDate(f.dueDate)}</div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn btn--sm grow"
                    onClick={() => { completeFollowUp(f.id); toast('Follow-up completed'); }}
                  >
                    <IconCheck /> Done
                  </button>
                  <button className="btn btn--sm btn--ghost grow" onClick={() => setEditing(f)}>Reschedule</button>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => { deleteFollowUp(f.id); toast('Follow-up removed'); }}
                    aria-label="Delete follow-up"
                  >
                    <IconTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <>
      <AppBar title="Follow-ups" />
      <main className="page stack stack--lg">
        <div className="card">
          <div className="metric-grid">
            <Metric value={buckets.overdue.length} label="Overdue" tone={buckets.overdue.length ? 'danger' : undefined} />
            <Metric value={buckets.today.length} label="Today" tone={buckets.today.length ? 'warn' : undefined} />
            <Metric value={buckets.upcoming.length} label="Upcoming" />
          </div>
        </div>

        {total === 0 ? (
          <EmptyState
            icon={<IconBell />}
            title="Nothing due"
            body="Set a follow-up from any contact, aircraft or opportunity and it shows up here and on the dashboard."
            action={<Link className="btn btn--primary" to="/prospects">Work the prospect list</Link>}
          />
        ) : null}

        <Group title="Overdue" items={buckets.overdue} tone="danger" />
        <Group title="Today" items={buckets.today} tone="warn" />
        <Group title="Upcoming" items={buckets.upcoming} tone="info" />

        {completed.length > 0 ? (
          <section className="stack stack--sm">
            <button className="btn btn--sm btn--ghost" onClick={() => setShowCompleted((v) => !v)}>
              {showCompleted ? 'Hide' : 'Show'} completed ({completed.length})
            </button>
            {showCompleted ? (
              <div className="list list--flush">
                {completed.map((f) => (
                  <div className="link-row" key={f.id}>
                    <div className="grow">
                      <div className="small truncate">{followUpSubject(db, f)}</div>
                      <div className="xsmall muted truncate">{f.note}</div>
                    </div>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => { completeFollowUp(f.id, false); toast('Reopened'); }}
                    >
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </main>

      {editing ? (
        <FollowUpSheet
          links={{ contactId: editing.contactId, aircraftId: editing.aircraftId, opportunityId: editing.opportunityId }}
          existing={editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </>
  );
}
