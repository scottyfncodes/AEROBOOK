/**
 * Creating an aircraft. Shared, because the useful place to add one is almost
 * always from the person who owns it — and arriving at a blank owner picker
 * having just come from that person is the kind of small friction that stops
 * a record being created at all.
 */
import { useMemo, useState } from 'react';

import { Banner, SelectField, Sheet, TextField } from './ui';
import { createAircraft, findAircraftByTail, setAircraftOwner } from '../data/store';
import { useDatabase } from '../data/useStore';
import { AIRCRAFT_STATUSES, type Aircraft, type AircraftStatus } from '../data/types';
import { formatTail, normalizeTail } from '../lib/tail';
import { displayName } from '../lib/names';

export function NewAircraftSheet({
  ownerId: fixedOwnerId,
  onClose,
  onCreated,
}: {
  /** Pre-selects the owner when the sheet is opened from a contact. */
  ownerId?: string;
  onClose: () => void;
  onCreated: (aircraft: Aircraft) => void;
}) {
  const db = useDatabase();
  const [tail, setTail] = useState('');
  const [year, setYear] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [baseAirport, setBaseAirport] = useState('');
  const [status, setStatus] = useState<AircraftStatus>(fixedOwnerId ? 'Owned' : 'Unknown');
  const [ownerId, setOwnerId] = useState(fixedOwnerId ?? '');

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
      serial: serial.trim(),
      baseAirport: baseAirport.trim().toUpperCase(),
      status,
    });
    if (ownerId) setAircraftOwner(aircraft.id, ownerId);
    onCreated(aircraft);
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
        <div className="form-grid">
          <TextField label="Model" value={model} onChange={setModel} />
          <TextField label="Serial" value={serial} onChange={setSerial} />
        </div>
        <TextField label="Base airport" value={baseAirport} onChange={setBaseAirport} placeholder="KSBA" />
        <SelectField label="Status" value={status} options={AIRCRAFT_STATUSES} onChange={setStatus} />
        <SelectField label="Owner" value={ownerId} options={owners} onChange={setOwnerId} />
      </div>
    </Sheet>
  );
}
