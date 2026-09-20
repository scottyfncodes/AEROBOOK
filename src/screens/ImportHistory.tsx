import { Link } from 'react-router-dom';

import { AppBar } from '../components/AppBar';
import { IconUpload } from '../components/Icons';
import { EmptyState, KeyValue } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { formatDateTime } from '../lib/dates';

export default function ImportHistory() {
  const db = useDatabase();

  return (
    <>
      <AppBar title="Import history" back="/import" />
      <main className="page stack">
        {db.imports.length === 0 ? (
          <EmptyState
            icon={<IconUpload />}
            title="No imports yet"
            body="Every import is recorded here with what it created, matched and skipped."
            action={<Link className="btn btn--primary" to="/import">Import a CSV</Link>}
          />
        ) : (
          db.imports.map((i) => (
            <div className="card stack stack--sm" key={i.id}>
              <div className="row row--between">
                <span className="strong truncate">{i.filename}</span>
                <span className="xsmall muted nowrap">{formatDateTime(i.date)}</span>
              </div>
              <div>
                <KeyValue k="Processed">{i.recordsProcessed}</KeyValue>
                <KeyValue k="Contacts created">{i.contactsCreated}</KeyValue>
                <KeyValue k="Contacts matched">{i.contactsMatched}</KeyValue>
                <KeyValue k="Aircraft created">{i.aircraftCreated}</KeyValue>
                <KeyValue k="Aircraft updated">{i.aircraftUpdated}</KeyValue>
                <KeyValue k="Duplicates skipped">{i.duplicatesSkipped}</KeyValue>
                <KeyValue k="Needed review">{i.recordsNeedingReview}</KeyValue>
                <KeyValue k="Missing email">{i.recordsMissingEmail}</KeyValue>
              </div>
            </div>
          ))
        )}
      </main>
    </>
  );
}
