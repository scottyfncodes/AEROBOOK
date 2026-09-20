/** Small shared UI pieces. Nothing here knows about the domain. */
import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { IconAlert, IconCheck, IconInfo, IconX } from './Icons';

// ------------------------------------------------------------------- toasts

interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'error';
}

const ToastContext = createContext<(message: string, tone?: 'default' | 'error') => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: 'default' | 'error' = 'default') => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3200);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.tone === 'error' ? ' toast--error' : ''}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// -------------------------------------------------------------------- sheet

export function Sheet({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="sheet__header">
          <h2 className="sheet__title" id={titleId}>{title}</h2>
          <button className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {footer ? <div className="sheet__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- forms

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error">{error}</span> : null}
    </div>
  );
}

export function TextField({
  label, value, onChange, placeholder, type = 'text', hint, error, inputMode, autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  error?: string;
  inputMode?: 'text' | 'email' | 'tel' | 'numeric' | 'decimal' | 'url' | 'search';
  autoComplete?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id) => (
        <input
          id={id}
          className="input"
          type={type}
          value={value}
          inputMode={inputMode}
          autoComplete={autoComplete}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function TextArea({
  label, value, onChange, placeholder, rows = 4, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <textarea
          id={id}
          className="textarea"
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function SelectField<T extends string>({
  label, value, options, onChange, hint,
}: {
  label: string;
  value: T;
  options: readonly T[] | { value: string; label: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  const normalized = useMemo(
    () =>
      (options as unknown[]).map((o) =>
        typeof o === 'string' ? { value: o, label: o } : (o as { value: string; label: string }),
      ),
    [options],
  );
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
          {normalized.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function NumberField({
  label, value, onChange, hint, step, suffix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  step?: string;
  suffix?: string;
}) {
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      {(id) => (
        <input
          id={id}
          className="input numeric"
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

// ------------------------------------------------------------------- pieces

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'success';
  children: ReactNode;
}) {
  const Icon = tone === 'success' ? IconCheck : tone === 'info' ? IconInfo : IconAlert;
  return (
    <div className={`banner banner--${tone}`}>
      <Icon />
      <div className="grow">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <div className="empty__title">{title}</div>
      {body ? <p className="empty__body">{body}</p> : null}
      {action}
    </div>
  );
}

export function Metric({ value, label, tone }: { value: ReactNode; label: string; tone?: string }) {
  return (
    <div className="metric">
      <span className="metric__value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</span>
      <span className="metric__label">{label}</span>
    </div>
  );
}

export function KeyValue({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="kv__key">{k}</span>
      <span className="kv__value">{children}</span>
    </div>
  );
}

export function Chip({ tone, children }: { tone?: 'accent' | 'info' | 'success' | 'warn' | 'danger'; children: ReactNode }) {
  return <span className={`chip${tone ? ` chip--${tone}` : ''}`}>{children}</span>;
}

export function ConfirmButton({
  label,
  confirmLabel = 'Tap again to confirm',
  onConfirm,
  className = 'btn btn--danger',
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={className}
      onClick={() => {
        if (armed) {
          onConfirm();
          setArmed(false);
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** Debounced value, so typing in search doesn't re-filter on every keystroke. */
export function useDebounced<T>(value: T, delay = 180): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
