/**
 * The CSV import wizard: upload → map columns → preview → import → result.
 *
 * Nothing is written until the user has seen the preview and pressed the
 * button, and the preview is produced by exactly the same code that performs
 * the import.
 */
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconAlert, IconCheck, IconPlane, IconUpload, IconUsers } from '../components/Icons';
import { Banner, Chip, EmptyState, Metric, SelectField, useDebounced, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { commitImport } from '../data/store';
import { parseCsv, type CsvTable } from '../lib/csv';
import {
  CONFIDENT_AT, FIELD_DEFS, detectMappings, mappingIsUsable, mappingIssues,
  type ColumnMapping, type TargetField,
} from '../lib/mapping';
import {
  applyImport, buildPreview, summarizePreview, type PreviewRow, type RowAction, type RowStatus,
} from '../lib/importer';
import type { ImportRecord } from '../data/types';
import type { NameOrder } from '../lib/names';

type Step = 'upload' | 'map' | 'preview' | 'done';

const FIELD_OPTIONS = [
  { value: 'custom', label: 'Keep as custom data' },
  { value: 'ignore', label: 'Ignore this column' },
  ...FIELD_DEFS.map((d) => ({ value: d.field, label: `${d.group} · ${d.label}` })),
];

const STATUS_TONE: Record<RowStatus, 'info' | 'success' | 'warn' | 'danger' | undefined> = {
  NEW: 'success',
  EXISTING: 'info',
  REVIEW: 'warn',
  DUPLICATE: undefined,
};

export default function Import() {
  const db = useDatabase();
  const toast = useToast();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('upload');
  const [filename, setFilename] = useState('');
  const [table, setTable] = useState<CsvTable | null>(null);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [nameOrder, setNameOrder] = useState<NameOrder>(db.settings.defaultNameOrder);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [result, setResult] = useState<ImportRecord | null>(null);
  const [error, setError] = useState('');

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > 20 * 1024 * 1024) {
      setError('That file is larger than 20 MB. Split it and import in parts.');
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        setError('AEROBOOK could not find a header row in that file.');
        return;
      }
      setFilename(file.name);
      setTable(parsed);
      setMappings(detectMappings(parsed.headers));
      setStep('map');
    } catch (e) {
      setError(`That file could not be read: ${(e as Error).message}`);
    }
  };

  const goToPreview = () => {
    if (!table) return;
    setRows(buildPreview(table.rows, mappings, db, { nameOrder }));
    setStep('preview');
  };

  const runImport = () => {
    if (!table) return;
    try {
      const applied = applyImport(rows, db, { filename, nameOrder });
      commitImport(applied);
      setResult(applied.record);
      setStep('done');
    } catch (e) {
      toast(`The import failed and nothing was changed: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <>
      <AppBar title="Import CSV" back="/" />
      <main className="page stack stack--lg">
        {step === 'upload' ? (
          <UploadStep error={error} onFile={onFile} />
        ) : null}

        {step === 'map' && table ? (
          <MapStep
            table={table}
            filename={filename}
            mappings={mappings}
            setMappings={setMappings}
            nameOrder={nameOrder}
            setNameOrder={setNameOrder}
            onBack={() => { setStep('upload'); setTable(null); }}
            onNext={goToPreview}
          />
        ) : null}

        {step === 'preview' && table ? (
          <PreviewStep
            rows={rows}
            setRows={setRows}
            filename={filename}
            onBack={() => setStep('map')}
            onImport={runImport}
          />
        ) : null}

        {step === 'done' && result ? (
          <DoneStep
            record={result}
            onAnother={() => {
              setStep('upload');
              setTable(null);
              setRows([]);
              setResult(null);
              setFilename('');
            }}
            onFinish={() => navigate('/prospects')}
          />
        ) : null}
      </main>
    </>
  );
}

// ------------------------------------------------------------------ upload

function UploadStep({ error, onFile }: { error: string; onFile: (f: File | undefined) => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="stack">
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <label
        className="card"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          padding: '36px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          borderStyle: 'dashed',
          borderColor: dragging ? 'var(--accent)' : 'var(--border-strong)',
          background: dragging ? 'var(--accent-dim)' : undefined,
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFile(e.dataTransfer.files?.[0]);
        }}
      >
        <IconUpload style={{ width: 32, height: 32, color: 'var(--accent)' }} />
        <div className="strong">Choose a CSV file</div>
        <div className="small muted">An aircraft-owner list, an export from another system — anything with a header row.</div>
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>

      <div className="card stack stack--sm">
        <div className="section-title">What happens next</div>
        <ol className="small secondary" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>AEROBOOK reads the header row and guesses what each column is.</li>
          <li>You correct anything it got wrong. Unknown columns are kept, never dropped.</li>
          <li>You see every row and what will happen to it before anything is written.</li>
          <li>Contacts and aircraft are created and linked, with duplicates matched rather than repeated.</li>
        </ol>
      </div>

      <Link className="btn btn--ghost btn--block" to="/import/history">Import history</Link>
    </div>
  );
}

// --------------------------------------------------------------------- map

function MapStep({
  table, filename, mappings, setMappings, nameOrder, setNameOrder, onBack, onNext,
}: {
  table: CsvTable;
  filename: string;
  mappings: ColumnMapping[];
  setMappings: (m: ColumnMapping[]) => void;
  nameOrder: NameOrder;
  setNameOrder: (o: NameOrder) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const issues = mappingIssues(mappings);
  const usable = mappingIsUsable(mappings);

  const setField = (index: number, field: TargetField) => {
    setMappings(mappings.map((m) => (m.index === index ? { ...m, field, confidence: 1 } : m)));
  };

  const sample = (index: number) => table.rows.slice(0, 3).map((r) => r[index]).filter(Boolean).join(' · ');

  return (
    <div className="stack">
      <div className="card">
        <div className="row row--between">
          <span className="strong truncate">{filename}</span>
          <Chip>{table.rows.length} rows</Chip>
        </div>
        <div className="small muted">{table.headers.length} columns detected</div>
      </div>

      {table.warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
      {issues.map((i) => <Banner key={i} tone="warn">{i}</Banner>)}
      {!usable ? (
        <Banner tone="danger">
          Nothing in this file can be turned into an aircraft or a contact. Map at least a tail number or an owner name.
        </Banner>
      ) : null}

      <div className="card stack stack--sm">
        <SelectField
          label="Owner name order"
          value={nameOrder}
          options={[
            { value: 'lastFirst', label: 'Last name first — "Heine John Charles"' },
            { value: 'firstLast', label: 'First name first — "John Charles Heine"' },
          ]}
          onChange={(v) => setNameOrder(v as NameOrder)}
          hint="FAA-derived owner lists are last-name-first. A name with a comma is read correctly either way."
        />
      </div>

      <h2 className="section-title">Column mapping</h2>
      <div className="stack stack--sm">
        {mappings.map((m) => (
          <div className="card stack stack--sm" key={m.index}>
            <div className="row row--between">
              <span className="strong truncate">{m.header}</span>
              {m.confidence >= CONFIDENT_AT ? (
                <Chip tone="success">Detected</Chip>
              ) : m.field === 'custom' ? (
                <Chip>Custom data</Chip>
              ) : (
                <Chip tone="warn">Check this</Chip>
              )}
            </div>
            <div className="xsmall muted truncate">{sample(m.index) || 'No values in the first rows'}</div>
            <select
              className="select"
              value={m.field}
              onChange={(e) => setField(m.index, e.target.value as TargetField)}
              aria-label={`Map column ${m.header}`}
            >
              {FIELD_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn--ghost grow" onClick={onBack}>Back</button>
        <button className="btn btn--primary grow" onClick={onNext} disabled={!usable}>Preview {table.rows.length} rows</button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- preview

type PreviewFilter = 'all' | RowStatus | 'MISSING EMAIL';

function PreviewStep({
  rows, setRows, filename, onBack, onImport,
}: {
  rows: PreviewRow[];
  setRows: (r: PreviewRow[]) => void;
  filename: string;
  onBack: () => void;
  onImport: () => void;
}) {
  const [filter, setFilter] = useState<PreviewFilter>('all');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query);
  const summary = summarizePreview(rows);

  const visible = useMemo(() => {
    let list = rows;
    if (filter === 'MISSING EMAIL') list = list.filter((r) => r.flags.includes('MISSING EMAIL'));
    else if (filter !== 'all') list = list.filter((r) => r.status === filter);
    const q = debounced.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.ownerDisplay, r.tailDisplay, r.aircraftDisplay, r.email, r.phone, r.location]
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }
    return list;
  }, [rows, filter, debounced]);

  const patch = (index: number, change: Partial<PreviewRow>) =>
    setRows(rows.map((r) => (r.index === index ? { ...r, ...change } : r)));

  const setAllVisible = (selected: boolean) => {
    const ids = new Set(visible.map((r) => r.index));
    setRows(rows.map((r) => (ids.has(r.index) ? { ...r, selected } : r)));
  };

  const willImport = rows.filter((r) => r.selected && r.action !== 'skip').length;

  return (
    <div className="stack">
      <div className="card">
        <div className="row row--between" style={{ marginBottom: 10 }}>
          <span className="strong truncate">Import preview</span>
          <span className="small muted nowrap">{filename}</span>
        </div>
        <div className="metric-grid">
          <Metric value={summary.total} label="Records" />
          <Metric value={summary.neu} label="New" tone="success" />
          <Metric value={summary.existing} label="Existing" tone="info" />
          <Metric value={summary.review} label="Review" tone={summary.review ? 'warn' : undefined} />
          <Metric value={summary.duplicate} label="Duplicate" />
          <Metric value={summary.missingEmail} label="No email" />
        </div>
      </div>

      <input
        className="input"
        type="search"
        placeholder="Filter these rows"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter preview rows"
      />

      <div className="filter-bar">
        {(['all', 'NEW', 'EXISTING', 'REVIEW', 'DUPLICATE', 'MISSING EMAIL'] as PreviewFilter[]).map((f) => (
          <button key={f} className={`filter-chip${filter === f ? ' is-active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f}
          </button>
        ))}
      </div>

      <div className="row row--between">
        <span className="small muted">{visible.length} shown · {willImport} will be imported</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn--sm btn--ghost" onClick={() => setAllVisible(true)}>Select all</button>
          <button className="btn btn--sm btn--ghost" onClick={() => setAllVisible(false)}>None</button>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No rows match this filter" />
      ) : (
        <div className="list">
          {visible.map((row) => (
            <PreviewRowCard key={row.index} row={row} onChange={(c) => patch(row.index, c)} />
          ))}
        </div>
      )}

      <div className="sticky-actions">
        <button className="btn btn--ghost" onClick={onBack}>Back</button>
        <button className="btn btn--primary" onClick={onImport} disabled={willImport === 0}>
          Import {willImport} {willImport === 1 ? 'record' : 'records'}
        </button>
      </div>
    </div>
  );
}

function PreviewRowCard({ row, onChange }: { row: PreviewRow; onChange: (c: Partial<PreviewRow>) => void }) {
  const [open, setOpen] = useState(false);
  const changes = [...row.aircraftChanges, ...row.contactChanges];
  const conflicts = changes.filter((c) => !c.isNewInformation);

  return (
    <div className="card stack stack--sm">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          className="checkbox"
          checked={row.selected}
          onChange={(e) => onChange({ selected: e.target.checked })}
          aria-label={`Include ${row.ownerDisplay}`}
          style={{ marginTop: 2 }}
        />
        <div className="grow">
          <div className="row row--between">
            <span className="strong truncate">{row.ownerDisplay}</span>
            <Chip tone={STATUS_TONE[row.status]}>{row.status}</Chip>
          </div>
          <div className="small secondary truncate">
            <span className="tail">{row.tailDisplay || '—'}</span>
            {row.aircraftDisplay !== '—' ? ` · ${row.aircraftDisplay}` : ''}
          </div>
          <div className="xsmall muted truncate">
            {[row.email, row.phone, row.location].filter(Boolean).join(' · ') || 'No contact details in this row'}
          </div>
        </div>
      </div>

      {row.flags.length > 0 ? (
        <div className="row row--wrap" style={{ gap: 6 }}>
          {row.flags.map((f) => (
            <Chip key={f} tone={f === 'MISSING EMAIL' ? undefined : 'warn'}>{f}</Chip>
          ))}
        </div>
      ) : null}

      {row.duplicateOfRow !== null ? (
        <div className="small muted">Same aircraft as row {row.duplicateOfRow + 1} in this file.</div>
      ) : null}
      {row.sameOwnerAsRow !== null ? (
        <div className="small muted">Same owner as row {row.sameOwnerAsRow + 1} — one contact, two aircraft.</div>
      ) : null}
      {row.matchedContactId ? (
        <div className="small muted">Matched an existing contact on {row.matchedContactReason.replace('+', ' + ')}.</div>
      ) : null}

      {row.status === 'EXISTING' || row.status === 'REVIEW' ? (
        <>
          {changes.length > 0 ? (
            <button className="btn btn--sm btn--ghost" onClick={() => setOpen((v) => !v)}>
              {open ? 'Hide' : 'Show'} {changes.length} {changes.length === 1 ? 'difference' : 'differences'}
              {conflicts.length > 0 ? ` (${conflicts.length} conflicting)` : ''}
            </button>
          ) : null}

          {open ? (
            <div className="card card--tight stack stack--sm">
              {changes.map((c) => (
                <div key={c.field} className="small">
                  <div className="xsmall muted">{c.label}</div>
                  {c.isNewInformation ? (
                    <div><span className="muted">was blank →</span> <span className="strong">{c.incoming}</span></div>
                  ) : (
                    <div>
                      <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)' }}>{c.existing}</span>
                      {' → '}
                      <span className="strong" style={{ color: 'var(--warn)' }}>{c.incoming}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <div className="row" style={{ gap: 6 }}>
            {(['update', 'skip'] as RowAction[]).map((a) => (
              <button
                key={a}
                className={`filter-chip${row.action === a ? ' is-active' : ''}`}
                onClick={() => onChange({ action: a, selected: true })}
                disabled={a === 'update' && changes.length === 0}
              >
                {a === 'update' ? 'Update' : 'Skip'}
              </button>
            ))}
          </div>
          {conflicts.length > 0 && row.action === 'update' ? (
            <div className="small" style={{ color: 'var(--warn)' }}>
              <IconAlert style={{ width: 13, height: 13, verticalAlign: '-2px' }} /> This will replace values that are
              already on the record.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- done

function DoneStep({
  record, onAnother, onFinish,
}: {
  record: ImportRecord;
  onAnother: () => void;
  onFinish: () => void;
}) {
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <IconCheck style={{ width: 22, height: 22, color: 'var(--success)' }} />
          <span className="strong">Import complete</span>
        </div>
        <div className="small muted">{record.filename}</div>
        <div className="metric-grid">
          <Metric value={record.recordsProcessed} label="Processed" />
          <Metric value={record.contactsCreated} label="New contacts" tone="success" />
          <Metric value={record.contactsMatched} label="Existing contacts" />
          <Metric value={record.aircraftCreated} label="New aircraft" tone="success" />
          <Metric value={record.aircraftUpdated} label="Updated aircraft" />
          <Metric value={record.duplicatesSkipped} label="Duplicates skipped" />
          <Metric value={record.recordsNeedingReview} label="Needed review" tone={record.recordsNeedingReview ? 'warn' : undefined} />
          <Metric value={record.recordsMissingEmail} label="No email" />
        </div>
      </div>

      {record.recordsMissingEmail > 0 ? (
        <Banner tone="info">
          {record.recordsMissingEmail} {record.recordsMissingEmail === 1 ? 'record has' : 'records have'} no email
          address. They are still in the book — filter the prospect list to find them and work them by phone.
        </Banner>
      ) : null}

      <div className="btn-group">
        <Link className="btn btn--primary" to="/prospects" onClick={onFinish}>
          <IconUsers /> Work the prospects
        </Link>
        <Link className="btn" to="/aircraft">
          <IconPlane /> See the aircraft
        </Link>
        <button className="btn btn--ghost" onClick={onAnother}>Import another file</button>
        <Link className="btn btn--ghost" to="/import/history">Import history</Link>
      </div>
    </div>
  );
}
