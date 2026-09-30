import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconClock, IconDownload, IconMail, IconTools, IconUpload } from '../components/Icons';
import { Banner, ConfirmButton, KeyValue, SelectField, TextField, useToast } from '../components/ui';
import { Wordmark } from '../components/Brand';
import { LocalDataBanner } from '../components/localData';
import { NotificationSettings } from '../components/NotificationSettings';
import { AccountSection, TeamSection } from '../components/team';
import { useCurrentUser } from '../data/session';
import { useDatabase } from '../data/useStore';
import { sendDigestNow } from '../data/auth';
import { eraseEverything, flush, replaceDatabase, updateSettings } from '../data/store';
import {
  aircraftCsv, contactsCsv, downloadText, exportFilename, fullJson, opportunitiesCsv, parseFullJson,
  policiesCsv,
} from '../lib/export';

export default function Settings() {
  const db = useDatabase();
  const me = useCurrentUser();
  const isAdmin = me.role === 'admin';
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState('');
  const [sending, setSending] = useState(false);
  const [digestError, setDigestError] = useState('');

  const s = db.settings;

  const sendDigest = async () => {
    setSending(true);
    setDigestError('');
    try {
      toast(`Sent to ${await sendDigestNow()}`);
    } catch (e) {
      setDigestError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

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
        <LocalDataBanner />

        <AccountSection />

        {isAdmin ? <TeamSection /> : null}

        <section className="stack stack--sm">
          <h2 className="section-title">History</h2>
          <Link className="btn btn--block btn--ghost" to="/history">
            <IconClock /> Activity history
          </Link>
        </section>

        <section className="stack stack--sm">
          <h2 className="section-title">Profile</h2>
          <p className="small muted">
            These fill in the sender variables in your emails. They are yours: everyone on the team has their own.
          </p>
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

        <NotificationSettings />

        <section className="stack stack--sm">
          <h2 className="section-title">Daily email</h2>
          <div className="card stack stack--sm">
            <label className="checkbox-row">
              <input
                className="checkbox"
                type="checkbox"
                checked={s.dailyDigest !== false}
                onChange={(e) => updateSettings({ dailyDigest: e.target.checked })}
              />
              <span>Email me each morning with my overdue, today's and this week's follow-ups</span>
            </label>
            <p className="muted">Sent to {me.email}. Nothing is sent on a day with nothing due.</p>
            {digestError ? <Banner tone="danger">{digestError}</Banner> : null}
            <button className="btn btn--ghost btn--block" disabled={sending} onClick={() => void sendDigest()}>
              <IconMail /> {sending ? 'Sending…' : 'Send me today’s email now'}
            </button>
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
            CSV opens in any spreadsheet. The full export is JSON and carries every record and every link between
            them. It lists attached documents but not the files themselves, which stay in AEROBOOK's private
            document storage. Keep originals of anything that matters.
          </p>

          {isAdmin ? (
            <button className="btn btn--ghost btn--block" onClick={() => fileInput.current?.click()}>
              <IconUpload /> Restore from a full export
            </button>
          ) : null}
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
          <h2 className="section-title">About</h2>
          {isAdmin ? (
            <>
              <Banner tone="warn">
                Restoring a backup or erasing replaces the data for <strong>everyone</strong> on the team, not just
                this device. Only admins see these.
              </Banner>
              <ConfirmButton
                label="Erase all AEROBOOK data"
                confirmLabel="Tap again — this erases it for everyone"
                className="btn btn--danger btn--block"
                onConfirm={() => { void eraseEverything().then(() => toast('Everything erased')); }}
              />
            </>
          ) : null}
          <div className="card small muted stack stack--sm">
            <Wordmark />
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
