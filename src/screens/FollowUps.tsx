/**
 * The working list. Overdue first, then today, then the week, then the rest,
 * because that is the order a person actually works them in.
 *
 * Mine is the default: your own follow-ups and the unassigned ones anyone
 * can take. All is the whole team's; Overdue is the whole team's that have
 * slipped, whoever they belong to.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconBell, IconCheck, IconPlus, IconTrash } from '../components/Icons';
import { CompleteFollowUpSheet, FollowUpSheet } from '../components/detail';
import { Chip, EmptyState, Metric, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { completeFollowUp, deleteFollowUp } from '../data/store';
import {
  bucketFollowUps, FOLLOW_UP_VIEWS, followUpsInView, followUpSubject, isMine, type FollowUpView,
} from '../lib/selectors';
import { useCurrentUser, useTeam } from '../data/session';
import { formatDate, relativeDue } from '../lib/dates';
import type { FollowUp } from '../data/types';

export default function FollowUps() {
  const db = useDatabase();
  const toast = useToast();
  const me = useCurrentUser();
  const { nameOf } = useTeam();
  const [params, setParams] = useSearchParams();
  const view = (FOLLOW_UP_VIEWS.some((v) => v.value === params.get('view')) ? params.get('view') : 'mine') as FollowUpView;
  const viewParams = (next: FollowUpView): Record<string, string> => (next === 'mine' ? {} : { view: next });
  const setView = (next: FollowUpView) => setParams(viewParams(next));
  const [showCompleted, setShowCompleted] = useState(false);
  const [editing, setEditing] = useState<FollowUp | undefined>();
  const [completing, setCompleting] = useState<FollowUp | undefined>();
  const creatingGeneral = params.get('new') === '1';

  const buckets = useMemo(() => bucketFollowUps(followUpsInView(db, view, me.id)), [db, view, me.id]);
  const counts = useMemo(
    () => Object.fromEntries(FOLLOW_UP_VIEWS.map((v) => [v.value, followUpsInView(db, v.value, me.id).length])),
    [db, me.id],
  );
  const completed = useMemo(
    () => db.followUps
      .filter((f) => f.completed && (view !== 'mine' || isMine(f, me.id)))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
    [db.followUps, view, me.id],
  );

  const total = buckets.overdue.length + buckets.today.length + buckets.upcoming.length + buckets.later.length;

  const Group = ({ title, items, tone }: { title: string; items: FollowUp[]; tone?: 'danger' | 'warn' | 'info' }) => {
    if (items.length === 0) return null;
    return (
      <section className="stack stack--sm">
        <h2 className="section-title">{title} · {items.length}</h2>
        <div className="list">
          {items.map((f) => {
            const contact = f.contactId ? db.contacts.find((c) => c.id === f.contactId) : undefined;
            const aircraft = f.aircraftId ? db.aircraft.find((a) => a.id === f.aircraftId) : undefined;
            const opportunity = f.opportunityId ? db.opportunities.find((o) => o.id === f.opportunityId) : undefined;
            // Deepest link wins — the opportunity says most about why this exists.
            const to = opportunity
              ? `/opportunities/${opportunity.id}`
              : aircraft
                ? `/aircraft/${aircraft.id}`
                : contact
                  ? `/contacts/${contact.id}`
                  : '/follow-ups';
            return (
              <div className="card stack stack--sm" key={f.id}>
                <div className="row row--between">
                  <Link className="strong truncate" to={to} style={{ color: 'inherit' }}>
                    {followUpSubject(db, f)}
                  </Link>
                  <div className="row" style={{ gap: 4 }}>
                    {f.assigneeId !== me.id ? <Chip>{nameOf(f.assigneeId)}</Chip> : null}
                    {f.priority === 'High' ? <Chip tone="danger">High</Chip> : null}
                    <Chip tone={tone}>{relativeDue(f.dueDate)}</Chip>
                  </div>
                </div>
                <div className="small secondary">{f.note || 'Follow up'}</div>
                <div className="xsmall muted">
                  {[
                    `Due ${formatDate(f.dueDate)}`,
                    opportunity ? `${opportunity.type} · ${opportunity.status}` : '',
                  ].filter(Boolean).join(' · ')}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="btn btn--sm grow"
                    onClick={() => { completeFollowUp(f.id); toast('Follow-up completed'); }}
                  >
                    <IconCheck /> Done
                  </button>
                  <button className="btn btn--sm btn--ghost grow" onClick={() => setCompleting(f)}>Done + note</button>
                  <button className="btn btn--sm btn--ghost grow" onClick={() => setEditing(f)}>Edit</button>
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
      <AppBar
        title="Follow-ups"
        actions={
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => setParams({ ...viewParams(view), new: '1' })}
            aria-label="New follow-up"
          >
            <IconPlus />
          </button>
        }
      />
      <main className="page stack stack--lg">
        <div className="filter-bar" role="tablist" aria-label="Whose follow-ups">
          {FOLLOW_UP_VIEWS.map((v) => (
            <button
              key={v.value}
              role="tab"
              aria-selected={view === v.value}
              className={`filter-chip${view === v.value ? ' is-active' : ''}`}
              onClick={() => setView(v.value)}
            >
              {v.label} · {counts[v.value]}
            </button>
          ))}
        </div>

        <div className="card">
          <div className="metric-grid metric-grid--quad">
            <Metric value={buckets.overdue.length} label="Overdue" tone={buckets.overdue.length ? 'danger' : undefined} />
            <Metric value={buckets.today.length} label="Today" tone={buckets.today.length ? 'warn' : undefined} />
            <Metric value={buckets.upcoming.length} label="This week" />
            <Metric value={buckets.later.length} label="Later" />
          </div>
        </div>

        {total === 0 ? (
          view === 'overdue' ? (
            <EmptyState icon={<IconCheck />} title="Nothing overdue" body="Nobody on the team has a follow-up past its date." />
          ) : (
            <EmptyState
              icon={<IconBell />}
              title={view === 'mine' ? 'Nothing on your list' : 'Nothing due'}
              body={
                view === 'mine' && counts.all > 0
                  ? 'Everything open belongs to someone else on the team. See All for the whole list.'
                  : 'Set a follow-up from any contact, aircraft or opportunity and it shows up here and on the home screen.'
              }
              action={<Link className="btn btn--primary" to="/prospects">Work the prospect list</Link>}
            />
          )
        ) : null}

        <Group title="Overdue" items={buckets.overdue} tone="danger" />
        <Group title="Today" items={buckets.today} tone="warn" />
        <Group title="This week" items={buckets.upcoming} tone="info" />
        <Group title="Later" items={buckets.later} />

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
                      <div className="xsmall muted truncate">{f.outcome || f.note}</div>
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
      {completing ? (
        <CompleteFollowUpSheet followUp={completing} onClose={() => setCompleting(undefined)} />
      ) : null}
      {creatingGeneral ? (
        <FollowUpSheet
          links={{}}
          onClose={() => setView(view)}
        />
      ) : null}
    </>
  );
}
