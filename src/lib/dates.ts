/**
 * Dates are stored as ISO strings. Follow-up buckets are computed against the
 * user's local day, not UTC — a follow-up due "today" must read as today at
 * 11pm in Santa Barbara.
 */

export function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local-midnight Date for a "YYYY-MM-DD" or full ISO string. */
export function toLocalDate(value: string): Date | null {
  if (!value) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

export function dateKey(value: string): string {
  const d = toLocalDate(value);
  return d ? todayKey(d) : '';
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

export function dueBucket(dueDate: string, now: Date = new Date()): DueBucket {
  const due = toLocalDate(dueDate);
  if (!due) return 'none';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (due.getTime() < today.getTime()) return 'overdue';
  if (due.getTime() === today.getTime()) return 'today';
  return 'upcoming';
}

export function addDays(days: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return todayKey(d);
}

export function daysBetween(dueDate: string, now: Date = new Date()): number {
  const due = toLocalDate(dueDate);
  if (!due) return 0;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(value: string): string {
  const d = toLocalDate(value);
  if (!d) return '';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${thisYear ? '' : `, ${d.getFullYear()}`}`;
}

export function formatDateTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${formatDate(value)} · ${time}`;
}

export function relativeDue(dueDate: string, now: Date = new Date()): string {
  const days = daysBetween(dueDate, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return '1 day overdue';
  if (days < 0) return `${Math.abs(days)} days overdue`;
  if (days < 7) return `In ${days} days`;
  if (days < 14) return 'Next week';
  return formatDate(dueDate);
}
