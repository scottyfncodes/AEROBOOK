import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconPlane, IconSearch, IconTarget, IconUsers } from '../components/Icons';
import { EmptyState, useDebounced } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { buildIndex, searchIndex, type ResultKind } from '../lib/search';

const ROUTE: Record<ResultKind, string> = {
  contact: '/contacts',
  aircraft: '/aircraft',
  opportunity: '/opportunities',
};

const ICON: Record<ResultKind, typeof IconPlane> = {
  contact: IconUsers,
  aircraft: IconPlane,
  opportunity: IconTarget,
};

export default function SearchScreen() {
  const db = useDatabase();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ResultKind | 'all'>('all');
  const debounced = useDebounced(query);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const index = useMemo(() => buildIndex(db), [db]);
  const results = useMemo(() => searchIndex(index, debounced, 200), [index, debounced]);
  const filtered = kind === 'all' ? results : results.filter((r) => r.kind === kind);

  const counts = {
    contact: results.filter((r) => r.kind === 'contact').length,
    aircraft: results.filter((r) => r.kind === 'aircraft').length,
    opportunity: results.filter((r) => r.kind === 'opportunity').length,
  };

  return (
    <>
      <AppBar title="Search" back showSearch={false} />
      <main className="page stack">
        <input
          ref={inputRef}
          className="input"
          type="search"
          inputMode="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Tail, name, city, email, phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />

        {debounced.trim() === '' ? (
          <EmptyState
            icon={<IconSearch />}
            title="Search everything"
            body="N917JH finds the aircraft and its owner. Heine finds the contact. SR22 finds the fleet. Denver finds everyone there."
          />
        ) : results.length === 0 ? (
          <EmptyState icon={<IconSearch />} title="No matches" body={`Nothing in the book matches “${debounced}”.`} />
        ) : (
          <>
            <div className="filter-bar">
              <button className={`filter-chip${kind === 'all' ? ' is-active' : ''}`} onClick={() => setKind('all')}>
                All {results.length}
              </button>
              {(['aircraft', 'contact', 'opportunity'] as ResultKind[])
                .filter((k) => counts[k] > 0)
                .map((k) => (
                  <button key={k} className={`filter-chip${kind === k ? ' is-active' : ''}`} onClick={() => setKind(k)}>
                    {k === 'aircraft' ? 'Aircraft' : k === 'contact' ? 'Contacts' : 'Opportunities'} {counts[k]}
                  </button>
                ))}
            </div>

            <div className="list">
              {filtered.map((r) => {
                const Icon = ICON[r.kind];
                return (
                  <Link key={`${r.kind}:${r.id}`} className="tile" to={`${ROUTE[r.kind]}/${r.id}`}>
                    <div className="row">
                      <Icon className="muted" style={{ width: 18, height: 18, flex: 'none' }} />
                      <div className="grow">
                        <div className={r.kind === 'aircraft' ? 'tail strong truncate' : 'strong truncate'}>{r.title}</div>
                        {r.subtitle ? <div className="small secondary truncate">{r.subtitle}</div> : null}
                        {r.detail ? <div className="xsmall muted truncate">{r.detail}</div> : null}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </main>
    </>
  );
}
