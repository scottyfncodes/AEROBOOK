/**
 * The words for what a follow-up asks someone to do, for the daily email
 * and push notifications. The app keeps the same labels in src/lib/tasks.ts.
 */
const LABELS: Record<string, string> = {
  'follow-up': 'Follow up',
  call: 'Call',
  quote: 'Send quote',
  contract: 'Send contract',
  other: 'Other',
};

export function taskLabel(kind: unknown): string {
  return (typeof kind === 'string' && LABELS[kind]) || 'Follow up';
}

/** "Send quote — hull and liability", or just the note; as the app's taskText. */
export function taskText(kind: unknown, note: string): string {
  const trimmed = note.trim();
  const what = kind && kind !== 'follow-up' && kind !== 'other' ? taskLabel(kind) : '';
  return what && trimmed ? `${what} — ${trimmed}` : what || trimmed;
}
