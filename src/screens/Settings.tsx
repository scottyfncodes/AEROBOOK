import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconDownload, IconMail, IconTools, IconUpload } from '../components/Icons';
import { Banner, ConfirmButton, KeyValue, SelectField, TextField, useToast } from '../components/ui';
import { Mark } from '../components/Brand';
import { useDatabase } from '../data/useStore';
import { eraseEverything, flush, replaceDatabase, updateSettings } from '../data/store';
import { isStoragePersisted } from '../data/db';
import {
  aircraftCsv, contactsCsv, downloadText, exportFilename, fullJson, opportunitiesCsv, parseFullJson,
  policiesCsv,
} from '../lib/export';

export default function Settings() {
  const db = useDatabase();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void isStoragePersisted().then(setPersisted);
  }, []);

  const s = db.settings;

  const exportCsv = (kind: string, text: string) => {
    downloadText(exportFilename(kind, 'csv'), 'text/csv', text);
    toast(`${kind} exported`);
  };

  const exportAll = async () => {
    await flush();
    downloadText(exportFilename('backup', 'json'), 'application/json', fullJson(db));
    toast('Full backup exported');
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    setImportError('');
    try {
      const parsed = parseFullJson(await file.text());
      replaceDatabase(parsed);
      toast(`Restored ${parsed.contacts.length} contacts and ${parsed.aircraft.length} aircraft`);
    } catch (e) {
      setImportError((e as Error).message);
    }
  };

  return (
    <>
      <AppBar title="Settings" back="/" />
      <main className="page stack stack--lg">
        <section className="stack stack--sm">
          <h2 className="section-title">Profile</h2>
          <p className="small muted">These fill in the sender variables in every email template.</p>
          <div className="card stack stack--sm">
            <TextField label="Your name" value={s.senderName} onChange={(v) => updateSettings({ senderName: v })} autoComplete="name" />
            <TextField label="Title" value={s.senderTitle} onChange={(v) => updateSettings({ senderTitle: v })} placeholder="Aircraft Broker · Aviation Insurance" />
            <TextField label="Phone" value={s.senderPhone} onChange={(v) => updateSettings({ senderPhone: v })} type="tel" inputMode="tel" />
            <TextField label="Email" value={s.senderEmail} onChange={(v) => updateSettings({ senderEmail: v })} type="email" inputMode="email" />
          </div>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Company / Workspace</h2>
          <div className="card stack stack--sm">
            <TextField label="Company" value={s.senderCompany} onChange={(v) => updateSettings({ senderCompany: v })} autoComplete="organization" />
          </div>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Preferences</h2>
          <div className="card stack stack--sm">
            <SelectField
              label="Appearance"
              value={s.theme}
              options={[
                { value: 'system', label: 'Match the device' },
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(v) => updateSettings({ theme: v as typeof s.theme })}
            />
            <SelectField
              label="Default owner-name order on import"
              value={s.defaultNameOrder}
              options={[
                { value: 'lastFirst', label: 'Last name first — FAA lists' },
                { value: 'firstLast', label: 'First name first' },
              ]}
              onChange={(v) => updateSettings({ defaultNameOrder: v as typeof s.defaultNameOrder })}
            />
          </div>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Email</h2>
          <Link className="btn btn--block btn--ghost" to="/templates">
            <IconMail /> Email templates ({db.templates.length})
          </Link>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Tools</h2>
          <Link className="btn btn--block btn--ghost" to="/tools">
            <IconTools /> Aviation &amp; insurance calculators
          </Link>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Data / Import &amp; export</h2>
          <div className="card">
            <KeyValue k="Contacts">{db.contacts.length}</KeyValue>
            <KeyValue k="Aircraft">{db.aircraft.length}</KeyValue>
            <KeyValue k="Opportunities">{db.opportunities.length}</KeyValue>
            <KeyValue k="Insurance policies">{db.policies.length}</KeyValue>
            <KeyValue k="Activities">{db.activities.length}</KeyValue>
            <KeyValue k="Follow-ups">{db.followUps.length}</KeyValue>
            <KeyValue k="Files">{db.files.length}</KeyValue>
            <KeyValue k="Imports">{db.imports.length}</KeyValue>
          </div>

          <Link className="btn btn--block btn--ghost" to="/import">
            <IconUpload /> Import a CSV
          </Link>

          <div className="btn-group">
            <button className="btn" onClick={() => exportCsv('contacts', contactsCsv(db))}>
              <IconDownload /> Export contacts
            </button>
            <button className="btn" onClick={() => exportCsv('aircraft', aircraftCsv(db))}>
              <IconDownload /> Export aircraft
            </button>
            <button className="btn" onClick={() => exportCsv('opportunities', opportunitiesCsv(db))}>
              <IconDownload /> Export opportunities
            </button>
            <button className="btn" onClick={() => exportCsv('insurance', policiesCsv(db))}>
              <IconDownload /> Export insurance
            </button>
            <button className="btn btn--primary" onClick={() => void exportAll()}>
              <IconDownload /> Export everything
            </button>
          </div>
          <p className="xsmall muted">
            The JSON backup carries every record and every link between them, and restores into a clean
            AEROBOOK. It lists attached documents but cannot carry the files themselves — those live in
            this browser's storage. Keep originals of anything that matters.
          </p>

          <p className="xsmall muted">
            CSV opens in any spreadsheet. The full export is JSON and can be restored here — it carries every record,
            though not attached file contents.
          </p>

          <button className="btn btn--ghost btn--block" onClick={() => fileInput.current?.click()}>
            <IconUpload /> Restore from a full export
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => { void restore(e.target.files?.[0]); e.target.value = ''; }}
          />
          {importError ? <Banner tone="danger">{importError}</Banner> : null}
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Planned</h2>
          <div className="card small muted">
            Team, notifications and integrations arrive with the multi-user version of AEROBOOK.
          </div>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Storage &amp; backup</h2>
          <Banner tone="info">
            Everything you enter stays on this device, in this browser — there is no cloud sync, no account,
            and nothing is ever uploaded anywhere. That also means it will not show up on your other devices
            or phones, and clearing this browser's data (or switching browsers) deletes it for good. Export a
            backup from time to time so you always have a copy saved outside the browser.
          </Banner>
          {persisted === false ? (
            <Banner tone="warn">
              Some browsers automatically clear old app data to free up space. AEROBOOK has asked this
              browser to protect its data from that, but the browser decides — using the app a little more
              usually settles it. Exporting a backup below is still the surest way to make sure nothing is
              ever lost.
            </Banner>
          ) : null}
          <ConfirmButton
            label="Erase all AEROBOOK data"
            confirmLabel="Tap again — this cannot be undone"
            className="btn btn--danger btn--block"
            onConfirm={() => { void eraseEverything().then(() => toast('Everything erased')); }}
          />
          <div className="card small muted stack stack--sm">
            <div className="row" style={{ gap: 10, color: 'var(--accent)' }}>
              <Mark size={24} />
              <span className="strong" style={{ letterSpacing: '0.18em', fontSize: 13 }}>AEROBOOK</span>
            </div>
            <div>A personal CRM for aircraft brokerage and aviation insurance.</div>
            <div>
              AEROBOOK does not send email. It prepares a message and hands it to your mail client; the activity it
              records says “prepared”, “opened in mail” or “copied”, never “sent”.
            </div>
            <div>
              External links open the authoritative source — the FAA registry and AirNav — rather than a copy that
              could be out of date.
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
