/**
 * The in-app pop-up for a new message or comment somewhere else in the app.
 * It sits at the top, clear of the tab bar and the message composer, goes by
 * itself after a few seconds, and never blocks what is underneath.
 */
import { useEffect, useRef } from 'react';
import { IconChat, IconX } from './Icons';

export interface Alert {
  id: number;
  text: string;
  url: string;
}

const SHOW_MS = 6000;

function AlertCard({ alert, onOpen, onDismiss }: { alert: Alert; onOpen: () => void; onDismiss: () => void }) {
  // The latest handler, without restarting the clock every time the app re-renders.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const t = setTimeout(() => dismiss.current(), SHOW_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="alert">
      <button className="alert__open" onClick={onOpen}>
        <IconChat aria-hidden />
        <span className="grow">{alert.text}</span>
        <span className="alert__cta">Open</span>
      </button>
      <button className="alert__close" onClick={onDismiss} aria-label="Dismiss">
        <IconX />
      </button>
    </div>
  );
}

export function AlertHost({
  alerts,
  onOpen,
  onDismiss,
}: {
  alerts: Alert[];
  onOpen: (alert: Alert) => void;
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="alert-host" role="status" aria-live="polite">
      {alerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} onOpen={() => onOpen(alert)} onDismiss={() => onDismiss(alert.id)} />
      ))}
    </div>
  );
}
