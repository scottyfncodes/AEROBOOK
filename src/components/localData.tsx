/**
 * The one-time move of what this device held before accounts existed. Shown
 * only while the account has no data of its own, so it cannot be done twice.
 */
import { useEffect, useState } from 'react';

import { IconUpload } from './Icons';
import { Banner, useToast } from './ui';
import { localDataToUpload } from '../data/cloud';
import { useSession } from '../data/session';
import type { Database } from '../data/types';

export function LocalDataBanner() {
  const { cloud } = useSession();
  const toast = useToast();
  const [local, setLocal] = useState<Database | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await localDataToUpload();
      if (!found || !cloud || !(await cloud.isAccountEmpty())) return;
      if (!cancelled) setLocal(found);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [cloud]);

  if (!local || !cloud) return null;

  const upload = async () => {
    setBusy(true);
    setError('');
    try {
      await cloud.uploadLocalData(local);
      toast(`Uploaded ${local.contacts.length} contacts and ${local.aircraft.length} aircraft`);
      setLocal(null);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Banner tone="warn">
      <div className="stack stack--sm">
        <div>
          <strong>This device has AEROBOOK data from before accounts:</strong> {local.contacts.length} contacts,{' '}
          {local.aircraft.length} aircraft, {local.followUps.length} follow-ups. Upload it so everyone on the account
          can see it. Attached documents go up with it.
        </div>
        <button className="btn btn--primary" disabled={busy} onClick={() => void upload()}>
          <IconUpload /> {busy ? 'Uploading…' : 'Upload it to the account'}
        </button>
        {error ? <div className="small">{error}</div> : null}
      </div>
    </Banner>
  );
}
