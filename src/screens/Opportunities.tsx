import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconPlus, IconTarget } from '../components/Icons';
import { OpportunityRow } from '../components/records';
import { EmptyState, Metric } from '../components/ui';
import { NewOpportunitySheet } from '../components/opportunity';
import { useDatabase } from '../data/useStore';
import { isOpen, openOpportunities, pipeline } from '../lib/selectors';
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

  const pipe = useMemo(() => pipeline(db), [db]);
  const openCount = db.opportunities.filter(isOpen).length;

  return (
    <>
      <AppBar
        title="Opportunities"
        back="/"
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setParams({ new: '1' })} aria-label="New opportunity">
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        {openCount > 0 ? (
          <div className="card">
            <div className="metric-grid">
              {pipe.stages.map((stage) => (
                <Metric key={stage.status} value={stage.count} label={stage.status} tone={stage.count ? 'accent' : undefined} />
              ))}
            </div>
          </div>
        ) : null}

        <div className="filter-bar">
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
        <div className="filter-bar">
          {(['Open only', ...OPPORTUNITY_STATUSES] as const).map((s) => (
            <button
              key={s}
              className={`filter-chip${status === s ? ' is-active' : ''}`}
              onClick={() => setStatus(s as OpportunityStatus | 'Open only')}
            >
              {s}
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
