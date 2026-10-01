/**
 * Settings → Data export, for admins: the whole company's AEROBOOK data in
 * one ZIP, for backup, migration or business continuity.
 */
import { useState } from 'react';
import { IconDownload } from './Icons';
import { Banner, Sheet, useToast } from './ui';
import { exportCompanyData, saveBlob, type ExportStep } from '../data/companyExport';

const STEP: Record<ExportStep, string> = {
  starting: 'Starting…',
  records: 'Collecting records…',
  audit: 'Collecting the audit log…',
  documents: 'Downloading documents',
  packing: 'Packing the ZIP…',
};

export function CompanyExportSection() {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setError('');
    setProgress(STEP.starting);
    try {
      const result = await exportCompanyData((step, detail) => setProgress(detail ? `${STEP[step]} ${detail}` : STEP[step]));
      saveBlob(result.blob, result.filename);
      setConfirming(false);
      toast(
        result.documentsMissing
          ? `Exported. ${result.documentsMissing} of ${result.documents} documents could not be included; documents.csv says why.`
          : 'Company data exported',
        result.documentsMissing ? 'error' : undefined,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="stack stack--sm">
      <h2 className="section-title">Data export</h2>
      <div className="card stack stack--sm">
        <p className="small">Export your company’s AEROBOOK data for backup, migration, or business continuity.</p>
        <p className="xsmall muted">
          One ZIP file with every contact, aircraft, opportunity, insurance policy, note, timeline entry, task and
          comment as spreadsheets (CSV), the original uploaded documents, the list of users and the audit log, plus a
          README explaining how the files fit together. It opens without AEROBOOK. Passwords and other sign-in secrets
          are never included. Each export is recorded in the audit log.
        </p>
        <button className="btn btn--primary btn--block" onClick={() => setConfirming(true)}>
          <IconDownload /> Export Company Data
        </button>
      </div>
      {confirming ? (
        <Sheet
          title="Export all company data?"
          onClose={() => { if (!progress) setConfirming(false); }}
          footer={
            <>
              <button className="btn btn--ghost" disabled={Boolean(progress)} onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn btn--primary" disabled={Boolean(progress)} onClick={() => void run()}>
                {progress ? 'Exporting…' : 'Export'}
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="small">
              This downloads everyone’s customer, contact, note, task and document data, the list of users and the audit
              log to this device. Keep the file somewhere safe: it is the whole company’s data.
            </p>
            <p className="small muted">The export is recorded in the audit log under your name.</p>
            {progress ? <Banner tone="info">{progress}</Banner> : null}
            {error ? <Banner tone="danger">{error}</Banner> : null}
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}
