/**
 * Settings → Notifications: turning push on or off for this device, and
 * saying plainly why it cannot be turned on when it cannot.
 */
import { useEffect, useState } from 'react';
import { IconBell } from './Icons';
import { Banner, useToast } from './ui';
import { disablePush, enablePush, pushState, type PushState } from '../data/push';
import { sendTestPush } from '../data/messaging';

const EXPLAIN: Record<PushState, string> = {
  unsupported: 'This browser cannot show notifications from AEROBOOK. New messages and comments still show in the app.',
  'install-first': 'On iPhone and iPad, notifications only work once AEROBOOK is on the Home Screen: tap Share, then “Add to Home Screen”, then open AEROBOOK from there and come back here.',
  'server-off': 'Notifications need push keys on the server before they can be turned on. An admin adds them to the deployment.',
  denied: 'Notifications are turned off for AEROBOOK in this device’s settings. On iPhone: Settings → Notifications → AEROBOOK. In a desktop browser: the site settings beside the address.',
  off: 'Get a notification on this device for new messages, and for new comments on aircraft you are watching, when AEROBOOK is not open.',
  on: 'This device gets a notification for new messages, and for new comments on aircraft you are watching, when AEROBOOK is not open. It says who, and where — never what was written.',
};

export function NotificationSettings() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pushState().then(setState, () => setState('off'));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const next = await enablePush();
      setState(next);
      if (next === 'on') toast('Notifications are on for this device');
    } catch (e) {
      toast(`Could not turn notifications on. ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await disablePush();
      setState('off');
      toast('Notifications are off for this device');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await sendTestPush();
      toast(r.sent ? 'Sent. It may take a few seconds, and only shows with AEROBOOK in the background on some devices.' : 'No device took it. Try turning notifications off and on again.', r.sent ? 'default' : 'error');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack stack--sm" id="notifications">
      <h2 className="section-title">Notifications</h2>
      <div className="card stack stack--sm">
        {state === null ? <p className="muted">Checking this device…</p> : (
          <>
            {state === 'denied' || state === 'server-off' || state === 'unsupported' || state === 'install-first'
              ? <Banner tone={state === 'install-first' ? 'info' : 'warn'}>{EXPLAIN[state]}</Banner>
              : <p className="muted">{EXPLAIN[state]}</p>}
            {state === 'off' ? (
              <button className="btn btn--primary btn--block" disabled={busy} onClick={() => void enable()}>
                <IconBell /> Turn on notifications
              </button>
            ) : null}
            {state === 'on' ? (
              <div className="btn-group">
                <button className="btn btn--ghost" disabled={busy} onClick={() => void test()}>Send a test notification</button>
                <button className="btn btn--ghost" disabled={busy} onClick={() => void disable()}>Turn off on this device</button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
