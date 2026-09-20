/**
 * Layover guide.
 *
 * AEROBOOK does not ship a restaurant list. A hard-coded list of businesses is
 * wrong the day a place closes, and a broker recommending a closed restaurant
 * to a client is worse than no recommendation at all. Instead each category
 * opens a live search against a source that is current — the Michelin Guide's
 * own site, maps, the web — and the user keeps their own list of places they
 * have actually been.
 */
import { useMemo, useState } from 'react';

import { AppBar } from '../components/AppBar';
import { IconExternal, IconMap, IconPlus, IconTrash } from '../components/Icons';
import { Banner, Chip, EmptyState, SelectField, Sheet, TextArea, TextField, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { deleteLayoverSpot, saveLayoverSpot } from '../data/store';
import { LAYOVER_CATEGORIES, airportLinks, layoverLink } from '../lib/links';

const SPOT_CATEGORIES = [
  'Restaurant', 'Michelin', 'Coffee', 'Brewery', 'Bar', 'Breakfast', 'Steak', 'Seafood',
  'Outdoors', 'Attraction', 'Gear', 'Hotel', 'Other',
];

const FOOD_KEYS = ['michelin', 'dinner', 'datenight', 'steak', 'seafood', 'local', 'fastgood', 'breakfast', 'interesting', 'airportfood'];

export default function Layover() {
  const db = useDatabase();
  const toast = useToast();
  const [place, setPlace] = useState('');
  const [tab, setTab] = useState<'food' | 'drink' | 'city' | 'airport'>('food');
  const [adding, setAdding] = useState(false);

  const trimmed = place.trim();
  const saved = useMemo(
    () => db.layoverSpots.filter((s) => !trimmed || s.place.toLowerCase().includes(trimmed.toLowerCase())),
    [db.layoverSpots, trimmed],
  );

  const categories = useMemo(() => {
    if (tab === 'food') return LAYOVER_CATEGORIES.filter((c) => FOOD_KEYS.includes(c.key));
    if (tab === 'drink') return LAYOVER_CATEGORIES.filter((c) => ['coffee', 'brewery', 'bars'].includes(c.key));
    if (tab === 'city') return LAYOVER_CATEGORIES.filter((c) => ['outdoors', 'attractions', 'gear'].includes(c.key));
    return LAYOVER_CATEGORIES.filter((c) => ['transport', 'fbo', 'airportfood'].includes(c.key));
  }, [tab]);

  const airport = /^[A-Za-z0-9]{3,4}$/.test(trimmed) ? airportLinks(trimmed) : [];

  return (
    <>
      <AppBar title="Layover" back="/tools" />
      <main className="page stack stack--lg">
        <TextField
          label="Where are you?"
          value={place}
          onChange={setPlace}
          placeholder="Santa Barbara, or KSBA"
          hint="A city, a neighbourhood or an airport identifier."
        />

        {!trimmed ? (
          <EmptyState
            icon={<IconMap />}
            title="Where are you tonight?"
            body="Type a city or airport and AEROBOOK opens the current listings — Michelin, maps, the web — rather than a list that goes stale."
          />
        ) : (
          <>
            <div className="filter-bar">
              {([
                ['food', 'Food'],
                ['drink', 'Coffee & drinks'],
                ['city', 'Out and about'],
                ['airport', 'Airport'],
              ] as const).map(([key, label]) => (
                <button key={key} className={`filter-chip${tab === key ? ' is-active' : ''}`} onClick={() => setTab(key)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="list list--flush">
              {categories.map((c) => {
                const link = layoverLink(c, trimmed);
                return (
                  <a className="link-row" key={c.key} href={link.url} target="_blank" rel="noopener noreferrer">
                    <div className="grow">
                      <div className="small strong">{c.label}</div>
                      <div className="xsmall muted">{c.hint || link.note || 'Opens a live search'}</div>
                    </div>
                    <IconExternal className="muted" style={{ width: 16, height: 16, flex: 'none' }} />
                  </a>
                );
              })}
            </div>

            {airport.length > 0 ? (
              <section className="stack stack--sm">
                <h2 className="section-title">{trimmed.toUpperCase()} airport</h2>
                <div className="list list--flush">
                  {airport.map((l) => (
                    <a className="link-row" key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
                      <div className="grow">
                        <div className="small">{l.label}</div>
                        <div className="xsmall muted">{l.note}</div>
                      </div>
                      <IconExternal className="muted" style={{ width: 16, height: 16, flex: 'none' }} />
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            <Banner tone="info">
              These open current listings in a new tab. AEROBOOK does not keep its own directory, so it will never send
              you to a place that closed last year — but do check the hours before you go.
            </Banner>
          </>
        )}

        <section className="stack stack--sm">
          <div className="row row--between">
            <h2 className="section-title">Places you have been</h2>
            <button className="btn btn--sm btn--ghost" onClick={() => setAdding(true)}>
              <IconPlus /> Add
            </button>
          </div>
          {saved.length === 0 ? (
            <div className="card small muted">
              {db.layoverSpots.length === 0
                ? 'Nothing saved yet. When somewhere is worth going back to, put it here — this list is yours and it never goes stale.'
                : `Nothing saved for “${trimmed}”.`}
            </div>
          ) : (
            <div className="list">
              {saved.map((s) => (
                <div className="card stack stack--sm" key={s.id}>
                  <div className="row row--between">
                    <span className="strong truncate">{s.name}</span>
                    <Chip>{s.category}</Chip>
                  </div>
                  <div className="small muted">{s.place}{s.rating ? ` · ${'★'.repeat(s.rating)}` : ''}</div>
                  {s.notes ? <div className="small secondary" style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</div> : null}
                  <div className="row" style={{ gap: 6 }}>
                    {s.url ? (
                      <a className="btn btn--sm btn--ghost grow" href={s.url} target="_blank" rel="noopener noreferrer">
                        <IconExternal /> Open
                      </a>
                    ) : null}
                    <a
                      className="btn btn--sm btn--ghost grow"
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name} ${s.place}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <IconMap /> Map
                    </a>
                    <button
                      className="btn btn--sm btn--ghost"
                      onClick={() => { deleteLayoverSpot(s.id); toast('Removed'); }}
                      aria-label={`Remove ${s.name}`}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {adding ? <AddSpotSheet defaultPlace={trimmed} onClose={() => setAdding(false)} /> : null}
    </>
  );
}

function AddSpotSheet({ defaultPlace, onClose }: { defaultPlace: string; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [place, setPlace] = useState(defaultPlace);
  const [category, setCategory] = useState('Restaurant');
  const [rating, setRating] = useState('');
  const [url, setUrl] = useState('');
  const [notes, setNotes] = useState('');

  const badUrl = url.trim() !== '' && !/^https?:\/\//i.test(url.trim());
  const canSave = name.trim() !== '' && place.trim() !== '' && !badUrl;

  return (
    <Sheet
      title="Save a place"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            disabled={!canSave}
            onClick={() => {
              saveLayoverSpot({
                name: name.trim(),
                place: place.trim(),
                category,
                notes: notes.trim(),
                url: url.trim() || undefined,
                rating: rating ? Number(rating) : undefined,
              });
              toast('Saved');
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} placeholder="The place" />
        <TextField label="City or airport" value={place} onChange={setPlace} />
        <SelectField label="Category" value={category} options={SPOT_CATEGORIES} onChange={setCategory} />
        <SelectField
          label="Rating"
          value={rating}
          options={[{ value: '', label: 'No rating' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: '★'.repeat(n) }))]}
          onChange={setRating}
        />
        <TextField
          label="Link"
          value={url}
          onChange={setUrl}
          inputMode="url"
          error={badUrl ? 'Links must start with http:// or https://' : undefined}
        />
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={4} placeholder="What to order, when to go, who to ask for" />
      </div>
    </Sheet>
  );
}
