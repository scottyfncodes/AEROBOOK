/**
 * What a follow-up asks someone to do. Missing is a plain follow-up: every
 * one recorded before there was a choice. server/tasks.ts keeps the same
 * labels for the daily email and push notifications.
 */
import type { FollowUp, FollowUpKind } from '../data/types';

export const TASK_KINDS: { value: FollowUpKind; label: string }[] = [
  { value: 'follow-up', label: 'Follow up' },
  { value: 'call', label: 'Call' },
  { value: 'quote', label: 'Send quote' },
  { value: 'contract', label: 'Send contract' },
  { value: 'other', label: 'Other' },
];

export function taskLabel(kind: FollowUpKind | undefined): string {
  return TASK_KINDS.find((k) => k.value === kind)?.label ?? 'Follow up';
}

/** One line for a list: "Send quote — check the hangar fee", or just the note, or what to do. */
export function taskText(f: Pick<FollowUp, 'kind' | 'note'>): string {
  const note = f.note.trim();
  const kind = f.kind && f.kind !== 'follow-up' && f.kind !== 'other' ? taskLabel(f.kind) : '';
  if (kind && note) return `${kind} — ${note}`;
  return kind || note || taskLabel(f.kind);
}
