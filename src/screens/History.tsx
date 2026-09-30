/**
 * What the team has done, newest first. Read-only: the history is what the
 * server recorded as changes were saved, and nothing here can change it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconClock } from '../components/Icons';
import { Banner, EmptyState } from '../components/ui';
import { fetchHistory } from '../data/auth';
import { useDatabase } from '../data/useStore';
import {
  byDay, groupHistory, locate, noun, timeOf, verb, type HistoryEntry, type HistoryLine,
} from '../lib/history';

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);

  const load = useCallback(async (before?: number) => {
    try {
      const page = await fetchHistory(before);
      setEntries((current) => (before ? [...current, ...page.entries] : page.entries));
      setMore(page.more);
      setStatus('ready');
      setError('');
    } catch (e) {
      setError((e as Error).message);
      if (!before) setStatus('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const older = async () => {
    setLoadingOlder(true);
    await load(entries[entries.length - 1]?.id);
    setLoadingOlder(false);
  };

  const days = byDay(groupHistory(entries));

  return (
    <>
      <AppBar title="Activity history" back="/settings" />
      <main className="page stack stack--lg">
        <p className="small muted">
          Every change anyone on the team saves, newest first. This is a record — it cannot be edited.
        </p>

        {status === 'loading' ? <div className="card small muted">Loading the history…</div> : null}

        {status === 'error' ? (
          <div className="stack stack--sm">
            <Banner tone="danger">Could not load the history. {error}</Banner>
            <button className="btn btn--block" onClick={() => { setStatus('loading'); void load(); }}>Try again</button>
          </div>
        ) : null}

        {status === 'ready' && entries.length === 0 ? (
          <EmptyState
            icon={<IconClock />}
            title="Nothing recorded yet"
            body="When anyone on the team adds, edits or deletes something, it shows up here."
          />
        ) : null}

        {days.map((day) => (
          <section className="stack stack--sm" key={day.label} aria-label={day.label}>
            <h2 className="section-title">{day.label}</h2>
            <div className="card history">
              {day.lines.map((line) => <Line key={line.key} line={line} />)}
            </div>
          </section>
        ))}

        {status === 'ready' && more ? (
          <button className="btn btn--ghost btn--block" disabled={loadingOlder} onClick={() => void older()}>
            {loadingOlder ? 'Loading…' : 'Show older'}
          </button>
        ) : null}
        {status === 'ready' && error ? <Banner tone="danger">{error}</Banner> : null}
      </main>
    </>
  );
}

function Line({ line }: { line: HistoryLine }) {
  const db = useDatabase();
  const [open, setOpen] = useState(false);
  const count = line.entries.length;
  const first = line.entries[0];

  return (
    <div className="history__item">
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div className="small grow">
          <span className="strong">{line.userName}</span>{' '}
          {verb(line.action, line.collection)}{' '}
          {count === 1 ? (
            <>
              {noun(line.collection)} <Record entry={first} db={db} />
            </>
          ) : (
            <>{count} {noun(line.collection, count)}</>
          )}
        </div>
        <span className="xsmall muted nowrap">{timeOf(line.at)}</span>
      </div>
      {count > 1 ? (
        <>
          <button className="timeline__more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide' : `Show all ${count}`}
          </button>
          {open ? (
            <ul className="history__list">
              {line.entries.map((e) => (
                <li key={e.id} className="small"><Record entry={e} db={db} /></li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The record's name, linked when it still exists, with what it was on. */
function Record({ entry, db }: { entry: HistoryEntry; db: ReturnType<typeof useDatabase> }) {
  const place = entry.action === 'delete' ? {} : locate(db, entry.collection, entry.recordId);
  const name = entry.summary ? `“${entry.summary}”` : '(untitled)';
  return (
    <>
      {place.to ? <Link to={place.to}>{name}</Link> : <span className="strong">{name}</span>}
      {place.context ? <span className="muted"> on {place.context}</span> : null}
    </>
  );
}
