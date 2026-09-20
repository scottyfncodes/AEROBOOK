import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconPlus, IconTarget } from '../components/Icons';
import { OpportunityRow } from '../components/records';
import { EmptyState } from '../components/ui';
import { NewOpportunitySheet } from '../components/opportunity';
import { useDatabase } from '../data/useStore';
import { isOpen, openOpportunities } from '../lib/selectors';
import { OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES, type OpportunityStatus, type OpportunityType } from '../data/types';

export default function Opportunities() {
  const db = useDatabase();
  const [params, setParams] = useSearchParams();
  const [type, setType] = useState<OpportunityType | 'All'>('All');
  const [status, setStatus] = useState<OpportunityStatus | 'Open only'>('Open only');

  const filtered = useMemo(() => {
    // "Open only" keeps the working pipeline order — nearest a decision first.
    let list = status === 'Open only' ? openOpportunities(db) : db.opportunities.filter((o) => o.status === status);
    if (type !== 'All') list = list.filter((o) => o.type === type);
    return status === 'Open only' ? list : [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [db, type, status]);

  /**
   * The stage counts and the stage filter were the same list twice over. One
   * row does both: it says where the work is and selects it in one tap.
   */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const o of db.opportunities) map.set(o.status, (map.get(o.status) ?? 0) + 1);
    return map;
  }, [db.opportunities]);

  const openCount = db.opportunities.filter(isOpen).length;

  return (
    <>
      <AppBar
        title="Pipeline"
        back="/"
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setParams({ new: '1' })} aria-label="New opportunity">
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        <div className="filter-bar" role="group" aria-label="Stage">
          <button
            className={`filter-chip${status === 'Open only' ? ' is-active' : ''}`}
            onClick={() => setStatus('Open only')}
          >
            Open {openCount}
          </button>
          {OPPORTUNITY_STATUSES.map((s) => (
            <button
              key={s}
              className={`filter-chip${status === s ? ' is-active' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s} {counts.get(s) ?? 0}
            </button>
          ))}
        </div>

        <div className="filter-bar" role="group" aria-label="Type">
          {(['All', ...OPPORTUNITY_TYPES] as const).map((t) => (
            <button
              key={t}
              className={`filter-chip${type === t ? ' is-active' : ''}`}
              onClick={() => setType(t as OpportunityType | 'All')}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="small muted">{filtered.length} of {db.opportunities.length}</div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconTarget />}
            title={db.opportunities.length === 0 ? 'No opportunities yet' : 'Nothing matches'}
            body="An opportunity is a deal in motion — an insurance quote, a purchase, a listing. One client can have several."
            action={
              <button className="btn btn--primary" onClick={() => setParams({ new: '1' })}>
                <IconPlus /> New opportunity
              </button>
            }
          />
        ) : (
          <div className="list">
            {filtered.map((o) => (
              <OpportunityRow
                key={o.id}
                opportunity={o}
                contact={o.contactId ? db.contacts.find((c) => c.id === o.contactId) : undefined}
                aircraft={o.aircraftId ? db.aircraft.find((a) => a.id === o.aircraftId) : undefined}
              />
            ))}
          </div>
        )}
      </main>

      {params.get('new') === '1' ? (
        <NewOpportunitySheet contactId={null} aircraftId={null} onClose={() => setParams({})} />
      ) : null}
    </>
  );
}
