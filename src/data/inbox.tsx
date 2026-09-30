/**
 * The live side of chat and comments while the app is open.
 *
 * Every few seconds (see pollDelay) it asks the server for unread counts and
 * anything new, and tells it where the person is looking, so no push is
 * sent about what is already on screen. New messages and comments elsewhere
 * pop up at the top of the screen; the one in front of them just appears.
 * A push arriving while the app is open, or the app coming back to the
 * front, checks at once. In the background it does nothing at all.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { alertsFor, IDLE_MS, pollDelay, viewFor } from '../lib/inbox';
import { fetchInbox, leavePresence, type Inbox, type InboxEvent } from './messaging';
import { refreshPush, registerServiceWorker } from './push';
import { AlertHost, type Alert } from '../components/Alerts';

interface InboxValue {
  chatUnread: number;
  aircraftUnread: Record<string, number>;
  /** Conversation id → the newest message in it, so an open one knows to fetch. */
  latest: Record<string, number>;
  /** Ask now rather than at the next tick: after sending, or on a push. */
  refresh(): void;
}

const InboxContext = createContext<InboxValue>({
  chatUnread: 0, aircraftUnread: {}, latest: {}, refresh: () => undefined,
});

const DEVICE_KEY = 'aerobook:device';

function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known && /^[A-Za-z0-9_-]{8,64}$/.test(known)) return known;
    const made = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    return `d${Math.random().toString(36).slice(2, 14)}`;
  }
}

/** The running inbox's off switch, for signing out. */
let stopActive: (() => Promise<void>) | null = null;

/**
 * Called just before signing out, while the session still works: stops
 * asking the server, and tells it this device is no longer looking.
 */
export async function stopInbox(): Promise<void> {
  await stopActive?.();
}

/** The app icon's number, where the device shows one (iPhone Home Screen apps do). */
function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (count > 0) nav.setAppBadge?.(count).catch(() => undefined);
  else nav.clearAppBadge?.().catch(() => undefined);
}

export function InboxProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<Pick<Inbox, 'chatUnread' | 'aircraftUnread'> & { latest: Record<string, number> }>({
    chatUnread: 0, aircraftUnread: {}, latest: {},
  });
  const [alerts, setAlerts] = useState<Alert[]>([]);

  const view = viewFor(location.pathname);
  const viewRef = useRef(view);
  viewRef.current = view;
  const device = useMemo(deviceId, []);
  const cursor = useRef<number | null>(null);
  const shown = useRef(new Set<number>());
  const lastTouch = useRef(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const stopped = useRef(false);

  const showAlerts = useCallback((events: InboxEvent[]) => {
    const fresh = alertsFor(events, viewRef.current, shown.current);
    if (!fresh.length) return;
    setAlerts((current) => [...current, ...fresh.map((e) => ({ id: e.id, text: e.text, url: e.url }))].slice(-3));
  }, []);

  const tick = useCallback(async () => {
    if (stopped.current) return;
    if (timer.current) clearTimeout(timer.current);
    if (busy.current) {
      again.current = true;
      return;
    }
    const hidden = document.visibilityState === 'hidden';
    if (hidden) return; // picked up again when the app is back in front
    busy.current = true;
    // Open but untouched for a while is not "looking": pushes go through.
    const active = Date.now() - lastTouch.current <= IDLE_MS;
    try {
      const inbox = await fetchInbox({ deviceId: device, view: active ? viewRef.current : null, since: cursor.current });
      if (stopped.current) return;
      cursor.current = inbox.cursor;
      setState({
        chatUnread: inbox.chatUnread,
        aircraftUnread: inbox.aircraftUnread,
        latest: Object.fromEntries(inbox.conversations.map((c) => [c.id, c.latestMessageId])),
      });
      setAppBadge(inbox.chatUnread);
      showAlerts(inbox.events);
    } catch {
      // Offline, or signed out underneath: the next tick tries again, and
      // the data sync handles an expired sign-in.
    } finally {
      busy.current = false;
    }
    if (stopped.current) return;
    if (again.current) {
      again.current = false;
      void tick();
      return;
    }
    const delay = pollDelay({ hidden: document.visibilityState === 'hidden', view: viewRef.current, idleFor: Date.now() - lastTouch.current });
    if (delay !== null) timer.current = setTimeout(() => void tick(), delay);
  }, [device, showAlerts]);

  const refresh = useCallback(() => void tick(), [tick]);

  useEffect(() => {
    stopped.current = false;
    stopActive = () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      setAppBadge(0);
      return leavePresence(device);
    };
    registerServiceWorker();
    void refreshPush().catch(() => undefined);
    void tick();

    const touched = () => {
      const wasIdle = Date.now() - lastTouch.current > 60_000;
      lastTouch.current = Date.now();
      if (wasIdle) void tick();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer.current) clearTimeout(timer.current);
        void leavePresence(device);
      } else {
        lastTouch.current = Date.now();
        void tick();
      }
    };
    const onWorker = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === 'aerobook:push') void tick();
      if (data?.type === 'aerobook:open' && typeof data.url === 'string' && data.url.startsWith('/')) navigate(data.url);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, touched, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onWorker);
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, touched));
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onWorker);
      stopActive = null;
    };
  }, [tick, device, navigate]);

  // A new place on screen is told to the server straight away.
  useEffect(() => {
    void tick();
  }, [view, tick]);

  const value = useMemo<InboxValue>(() => ({ ...state, refresh }), [state, refresh]);

  return (
    <InboxContext.Provider value={value}>
      {children}
      <AlertHost
        alerts={alerts}
        onOpen={(alert) => {
          setAlerts((current) => current.filter((a) => a.id !== alert.id));
          navigate(alert.url);
        }}
        onDismiss={(id) => setAlerts((current) => current.filter((a) => a.id !== id))}
      />
    </InboxContext.Provider>
  );
}

export function useInbox(): InboxValue {
  return useContext(InboxContext);
}
