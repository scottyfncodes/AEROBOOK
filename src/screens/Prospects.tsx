import { useMemo, useState } from 'react';

import { AppBar } from '../components/AppBar';
import { IconTarget } from '../components/Icons';
import { ProspectRow } from '../components/records';
import { EmptyState, useDebounced } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { updateContact } from '../data/store';
import { PROSPECT_STATUSES, type ProspectStatus } from '../data/types';
import { aircraftOf, nextFollowUpFor } from '../lib/selectors';
import { displayName } from '../lib/names';
import { search } from '../lib/search';

type Sort = 'name' | 'oldest contact' | 'next follow-up' | 'newest';

export default function Prospects() {
  const db = useDatabase();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ProspectStatus | 'All' | 'Needs contact'>('All');
  const [sort, setSort] = useState<Sort>('name');
  const debounced = useDebounced(query);

  const rows = useMemo(() => {
    let list = db.contacts;

    if (status === 'Needs contact') list = list.filter((c) => !c.lastContactedAt);
    else if (status !== 'All') list = list.filter((c) => c.prospectStatus === status);

    if (debounced.trim()) {
      const ids = new Set(search(db, debounced, 1000).filter((r) => r.kind === 'contact').map((r) => r.id));
      list = list.filter((c) => ids.has(c.id));
    }

    const enriched = list.map((c) => ({
      contact: c,
      aircraft: aircraftOf(db, c.id)[0],
      followUp: nextFollowUpFor(db, { contactId: c.id }),
    }));

    switch (sort) {
      case 'oldest contact':
        return enriched.sort((a, b) => (a.contact.lastContactedAt ?? '').localeCompare(b.contact.lastContactedAt ?? ''));
      case 'next follow-up':
        return enriched.sort((a, b) => (a.followUp?.dueDate ?? '9999').localeCompare(b.followUp?.dueDate ?? '9999'));
      case 'newest':
        return enriched.sort((a, b) => b.contact.createdAt.localeCompare(a.contact.createdAt));
      default:
        return enriched.sort((a, b) => displayName(a.contact).localeCompare(displayName(b.contact)));
    }
  }, [db, debounced, status, sort]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of db.contacts) map.set(c.prospectStatus, (map.get(c.prospectStatus) ?? 0) + 1);
    return map;
  }, [db.contacts]);

  return (
    <>
      <AppBar title="Prospects" />
      <main className="page stack">
        <input
          className="input"
          type="search"
          placeholder="Name, tail, city, email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter prospects"
        />

        <div className="filter-bar">
          <button className={`filter-chip${status === 'All' ? ' is-active' : ''}`} onClick={() => setStatus('All')}>
            All {db.contacts.length}
          </button>
          <button
            className={`filter-chip${status === 'Needs contact' ? ' is-active' : ''}`}
            onClick={() => setStatus('Needs contact')}
          >
            Never contacted
          </button>
          {PROSPECT_STATUSES.map((s) => (
            <button key={s} className={`filter-chip${status === s ? ' is-active' : ''}`} onClick={() => setStatus(s)}>
              {s} {counts.get(s) ?? 0}
            </button>
          ))}
        </div>

        <div className="row row--between">
          <span className="small muted">{rows.length} shown</span>
          <select
            className="select"
            style={{ width: 'auto', minHeight: 34, fontSize: 13, padding: '4px 30px 4px 10px' }}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort prospects"
          >
            <option value="name">Sort: name</option>
            <option value="oldest contact">Sort: least recently contacted</option>
            <option value="next follow-up">Sort: next follow-up</option>
            <option value="newest">Sort: newest</option>
          </select>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<IconTarget />}
            title={db.contacts.length === 0 ? 'No prospects yet' : 'Nothing matches'}
            body={
              db.contacts.length === 0
                ? 'Import an aircraft-owner list and every owner becomes a prospect you can work.'
                : 'Try another status or clear the search.'
            }
          />
        ) : (
          <div className="list">
            {rows.map(({ contact, aircraft, followUp }) => (
              <ProspectRow
                key={contact.id}
                contact={contact}
                aircraft={aircraft}
                followUp={followUp}
                onStatusChange={(next) => updateContact(contact.id, { prospectStatus: next })}
              />
            ))}
          </div>
        )}
      </main>
    </>
  );
}
