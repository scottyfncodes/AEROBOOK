import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconPlus, IconUsers } from '../components/Icons';
import { ContactRow } from '../components/records';
import { EmptyState, Sheet, TextField, SelectField, useDebounced, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { createContact } from '../data/store';
import { CONTACT_STATUSES, type ContactStatus } from '../data/types';
import { aircraftOf } from '../lib/selectors';
import { displayName } from '../lib/names';
import { search } from '../lib/search';

export default function Contacts() {
  const db = useDatabase();
  const [params, setParams] = useSearchParams();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ContactStatus | 'All'>('All');
  const debounced = useDebounced(query);
  const showNew = params.get('new') === '1';

  const filtered = useMemo(() => {
    let list = db.contacts;
    if (status !== 'All') list = list.filter((c) => c.status === status);
    if (debounced.trim()) {
      const ids = new Set(search(db, debounced, 500).filter((r) => r.kind === 'contact').map((r) => r.id));
      list = list.filter((c) => ids.has(c.id));
    }
    return [...list].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [db, debounced, status]);

  return (
    <>
      <AppBar
        title="Contacts"
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setParams({ new: '1' })} aria-label="New contact">
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        <input
          className="input"
          type="search"
          placeholder="Filter contacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter contacts"
        />

        <div className="filter-bar">
          {(['All', ...CONTACT_STATUSES] as const).map((s) => (
            <button
              key={s}
              className={`filter-chip${status === s ? ' is-active' : ''}`}
              onClick={() => setStatus(s as ContactStatus | 'All')}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="row row--between">
          <Link className="small" to="/prospects">Work the prospect list →</Link>
        </div>

        <div className="small muted">{filtered.length} of {db.contacts.length}</div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<IconUsers />}
            title={db.contacts.length === 0 ? 'No contacts yet' : 'No contacts match'}
            body={db.contacts.length === 0 ? 'Import an owner list, or add someone by hand.' : 'Try a different filter.'}
            action={
              <button className="btn btn--primary" onClick={() => setParams({ new: '1' })}>
                <IconPlus /> New contact
              </button>
            }
          />
        ) : (
          <div className="list">
            {filtered.map((c) => (
              <ContactRow key={c.id} contact={c} aircraft={aircraftOf(db, c.id)} />
            ))}
          </div>
        )}
      </main>

      {showNew ? (
        <NewContactSheet
          onClose={() => setParams({})}
          onCreated={(name) => {
            toast(`${name} added`);
            setParams({});
          }}
        />
      ) : null}
    </>
  );
}

function NewContactSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [status, setStatus] = useState<ContactStatus>('Prospect');

  const canSave = Boolean(firstName.trim() || lastName.trim() || company.trim() || email.trim());

  const save = () => {
    if (!canSave) return;
    const contact = createContact({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      company: company.trim(),
      email: email.trim(),
      phone: phone.trim(),
      city: city.trim(),
      state: state.trim().toUpperCase(),
      status,
    });
    onCreated(displayName(contact));
  };

  return (
    <Sheet
      title="New contact"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={!canSave}>Save</button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <TextField label="First name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
          <TextField label="Last name" value={lastName} onChange={setLastName} autoComplete="family-name" />
        </div>
        <TextField label="Company" value={company} onChange={setCompany} autoComplete="organization" />
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="email" />
        <TextField label="Phone" value={phone} onChange={setPhone} type="tel" inputMode="tel" autoComplete="tel" />
        <div className="form-grid">
          <TextField label="City" value={city} onChange={setCity} autoComplete="address-level2" />
          <TextField label="State" value={state} onChange={setState} autoComplete="address-level1" />
        </div>
        <SelectField label="Status" value={status} options={CONTACT_STATUSES} onChange={setStatus} />
      </div>
    </Sheet>
  );
}
