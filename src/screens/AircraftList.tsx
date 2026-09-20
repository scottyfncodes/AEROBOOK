import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconPlane, IconPlus } from '../components/Icons';
import { AircraftRow } from '../components/records';
import { Banner, EmptyState, SelectField, Sheet, TextField, useDebounced, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { createAircraft, findAircraftByTail, setAircraftOwner } from '../data/store';
import { AIRCRAFT_STATUSES, type AircraftStatus } from '../data/types';
import { ownerOf } from '../lib/selectors';
import { policiesFor, policyState } from '../lib/insurance';
import { formatTail, normalizeTail } from '../lib/tail';
import { displayName } from '../lib/names';
import { search } from '../lib/search';

export default function AircraftList() {
  const db = useDatabase();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AircraftStatus | 'All' | 'Renewal due'>('All');
  const debounced = useDebounced(query);
  const navigate = useNavigate();
  const toast = useToast();

  /** Tail → the policy nearest its renewal, so a row can show the countdown. */
  const policyByAircraft = useMemo(() => {
    const map = new Map<string, (typeof db.policies)[number]>();
    for (const a of db.aircraft) {
      const first = policiesFor(db, { aircraftId: a.id })[0];
      if (first) map.set(a.id, first);
    }
    return map;
  }, [db]);

  const filtered = useMemo(() => {
    let list = db.aircraft;
    if (status === 'Renewal due') {
      list = list.filter((a) => {
        const policy = policyByAircraft.get(a.id);
        return policy ? policyState(policy).needsAttention : false;
      });
    } else if (status !== 'All') list = list.filter((a) => a.status === status);
    if (debounced.trim()) {
      const ids = new Set(search(db, debounced, 1000).filter((r) => r.kind === 'aircraft').map((r) => r.id));
      list = list.filter((a) => ids.has(a.id));
    }
    return [...list].sort((a, b) => a.tailNumber.localeCompare(b.tailNumber));
  }, [db, debounced, status, policyByAircraft]);

  return (
    <>
      <AppBar
        title="Aircraft"
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setParams({ new: '1' })} aria-label="New aircraft">
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        <input
          className="input"
          type="search"
          placeholder="Tail, make, model, owner"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter aircraft"
        />

        <div className="filter-bar">
          {(['All', 'Renewal due', ...AIRCRAFT_STATUSES] as const).map((s) => (
            <button
              key={s}
              className={`filter-chip${status === s ? ' is-active' : ''}`}
              onClick={() => setStatus(s as AircraftStatus | 'All' | 'Renewal due')}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="small muted">{filtered.length} of {db.aircraft.length}</div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconPlane />}
            title={db.aircraft.length === 0 ? 'No aircraft yet' : 'No aircraft match'}
            body={
              db.aircraft.length === 0
                ? 'Import an owner list, or add a tail number by hand.'
                : status === 'Renewal due'
                  ? 'No renewals need attention. Add an expiration date to a policy and it shows up here.'
                  : 'Try a different filter.'
            }
            action={
              <button className="btn btn--primary" onClick={() => setParams({ new: '1' })}>
                <IconPlus /> New aircraft
              </button>
            }
          />
        ) : (
          <div className="list">
            {filtered.map((a) => (
              <AircraftRow key={a.id} aircraft={a} owner={ownerOf(db, a)} policy={policyByAircraft.get(a.id)} />
            ))}
          </div>
        )}
      </main>

      {params.get('new') === '1' ? (
        <NewAircraftSheet
          onClose={() => setParams({})}
          onCreated={(id, tail) => {
            toast(`${tail} added`);
            setParams({});
            navigate(`/aircraft/${id}`);
          }}
        />
      ) : null}
    </>
  );
}

function NewAircraftSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string, tail: string) => void;
}) {
  const db = useDatabase();
  const [tail, setTail] = useState('');
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [baseAirport, setBaseAirport] = useState('');
  const [status, setStatus] = useState<AircraftStatus>('Unknown');
  const [ownerId, setOwnerId] = useState('');

  const existing = normalizeTail(tail) ? findAircraftByTail(tail) : undefined;
  const canSave = normalizeTail(tail).length > 0 && !existing;

  const owners = useMemo(
    () => [{ value: '', label: 'No owner yet' }, ...db.contacts
      .map((c) => ({ value: c.id, label: displayName(c) }))
      .sort((a, b) => a.label.localeCompare(b.label))],
    [db.contacts],
  );

  const save = () => {
    if (!canSave) return;
    const aircraft = createAircraft({
      tailNumber: tail,
      year: year.trim(),
      make: make.trim(),
      model: model.trim(),
      baseAirport: baseAirport.trim().toUpperCase(),
      status,
    });
    if (ownerId) setAircraftOwner(aircraft.id, ownerId);
    onCreated(aircraft.id, aircraft.tailNumber);
  };

  return (
    <Sheet
      title="New aircraft"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={!canSave}>Save</button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="Tail number"
          value={tail}
          onChange={setTail}
          placeholder="N917JH"
          hint={normalizeTail(tail) ? `Stored as ${formatTail(tail)}` : 'Required'}
        />
        {existing ? (
          <Banner tone="warn">
            {existing.tailNumber} is already in the book. Open it instead of creating a second record.
          </Banner>
        ) : null}
        <div className="form-grid">
          <TextField label="Year" value={year} onChange={setYear} inputMode="numeric" />
          <TextField label="Make" value={make} onChange={setMake} />
        </div>
        <TextField label="Model" value={model} onChange={setModel} />
        <TextField label="Base airport" value={baseAirport} onChange={setBaseAirport} placeholder="KSBA" />
        <SelectField label="Status" value={status} options={AIRCRAFT_STATUSES} onChange={setStatus} />
        <SelectField label="Owner" value={ownerId} options={owners} onChange={setOwnerId} />
      </div>
    </Sheet>
  );
}
