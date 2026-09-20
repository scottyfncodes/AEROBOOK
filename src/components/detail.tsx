/**
 * The pieces every detail screen shares: the timeline, the activity and
 * follow-up sheets, the file list, and the external-link list.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  IconAlert, IconCalendar, IconCheck, IconClock, IconDoc, IconExternal, IconMail, IconNote,
  IconPhone, IconPlus, IconTarget, IconTrash, IconUpload,
} from './Icons';
import { Banner, Chip, EmptyState, SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import type {
  Activity, ActivityType, DocumentCategory, FollowUp, FollowUpPriority, FileRecord,
} from '../data/types';
import { ACTIVITY_TYPES, DOCUMENT_CATEGORIES } from '../data/types';
import {
  addFile, completeFollowUp, createFollowUp, deleteFollowUp, getFile, logActivity, removeFile,
  updateFollowUp,
} from '../data/store';
import { addDays, formatDate, relativeDue, todayKey } from '../lib/dates';
import type { ExternalLink } from '../lib/links';

type Links = {
  contactId?: string | null;
  aircraftId?: string | null;
  opportunityId?: string | null;
  insurancePolicyId?: string | null;
};

// ----------------------------------------------------------------- timeline

const ACTIVITY_ICON: Record<string, typeof IconNote> = {
  Email: IconMail,
  Call: IconPhone,
  Text: IconPhone,
  Meeting: IconCalendar,
  Note: IconNote,
  Quote: IconDoc,
  'Status Change': IconTarget,
  Renewal: IconClock,
  Document: IconDoc,
  Import: IconUpload,
  'Follow-Up': IconClock,
  Other: IconNote,
};

export function Timeline({
  activities,
  followUps,
  onDeleteActivity,
}: {
  activities: Activity[];
  followUps: FollowUp[];
  onDeleteActivity?: (id: string) => void;
}) {
  type Entry =
    | { kind: 'activity'; at: string; activity: Activity }
    | { kind: 'followUp'; at: string; followUp: FollowUp };

  const entries: Entry[] = [
    ...activities.map((a) => ({ kind: 'activity' as const, at: a.date, activity: a })),
    ...followUps.filter((f) => !f.completed).map((f) => ({ kind: 'followUp' as const, at: f.dueDate, followUp: f })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (entries.length === 0) {
    return <div className="card small muted">Nothing recorded yet. Log a call, a note or an email and it lands here.</div>;
  }

  return (
    <div className="card">
      <div className="timeline">
        {entries.map((entry) => {
          if (entry.kind === 'followUp') {
            const f = entry.followUp;
            return (
              <div className="timeline__item" key={`f${f.id}`}>
                <div className="timeline__dot" style={{ color: 'var(--accent)' }}><IconClock /></div>
                <div className="grow">
                  <div className="row row--between">
                    <span className="strong small">Follow-up due</span>
                    <span className="xsmall muted nowrap">{relativeDue(f.dueDate)}</span>
                  </div>
                  <div className="small secondary">{f.note || 'Follow up'}</div>
                </div>
              </div>
            );
          }
          const a = entry.activity;
          const Icon = ACTIVITY_ICON[a.type] ?? IconNote;
          return (
            <div className="timeline__item" key={`a${a.id}`}>
              <div className="timeline__dot"><Icon /></div>
              <div className="grow">
                <div className="row row--between">
                  <span className="strong small truncate">{a.subject || a.type}</span>
                  <span className="xsmall muted nowrap">{formatDate(a.date)}</span>
                </div>
                <div className="xsmall muted">{a.type}</div>
                {a.notes ? <TimelineNote text={a.notes} /> : null}
                {onDeleteActivity ? (
                  <button
                    className="timeline__remove"
                    onClick={() => onDeleteActivity(a.id)}
                    aria-label={`Remove "${a.subject || a.type}" from the timeline`}
                  >
                    <IconTrash />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A recorded email carries its whole body, which is the point — it is the
 * record of what was said. It should not bury the rest of the timeline, so
 * anything long is clamped until asked for.
 */
function TimelineNote({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 180 || text.split('\n').length > 4;
  return (
    <div style={{ marginTop: 4 }}>
      <div
        className="small secondary"
        style={
          expanded || !isLong
            ? { whiteSpace: 'pre-wrap' }
            : {
                whiteSpace: 'pre-wrap',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {text}
      </div>
      {isLong ? (
        <button className="timeline__more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Show full message'}
        </button>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------- activity sheet

export function ActivitySheet({
  links,
  defaultType = 'Note',
  defaultSubject = '',
  title = 'Log activity',
  onClose,
}: {
  links: Links;
  defaultType?: ActivityType;
  defaultSubject?: string;
  title?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<ActivityType>(defaultType);
  const [subject, setSubject] = useState(defaultSubject);
  const [date, setDate] = useState(todayKey());
  const [notes, setNotes] = useState('');

  const save = () => {
    logActivity({ ...links, type, subject: subject.trim() || type, notes: notes.trim(), date });
    toast(`${type} recorded`);
    onClose();
  };

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Record</button>
        </>
      }
    >
      <div className="stack">
        <SelectField label="Type" value={type} options={ACTIVITY_TYPES} onChange={setType} />
        <TextField label="Subject" value={subject} onChange={setSubject} placeholder="RE: N917JH" />
        <TextField label="Date" value={date} onChange={setDate} type="date" />
        <TextArea label="Notes" value={notes} onChange={setNotes} placeholder="What was said, what happens next" />
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------- follow-up sheet

const PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

export function FollowUpSheet({
  links,
  existing,
  defaultNote = '',
  defaultDueDate,
  onClose,
}: {
  links: Links;
  existing?: FollowUp;
  defaultNote?: string;
  defaultDueDate?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? defaultDueDate ?? addDays(7));
  const [note, setNote] = useState(existing?.note ?? defaultNote);
  const [priority, setPriority] = useState<FollowUpPriority>(existing?.priority ?? 'Normal');

  const save = () => {
    if (existing) {
      updateFollowUp(existing.id, {
        dueDate, note: note.trim(), priority, completed: false, completedAt: undefined,
      });
      toast('Follow-up updated');
    } else {
      createFollowUp({ ...links, dueDate, note: note.trim(), priority });
      toast(`Follow-up set for ${formatDate(dueDate)}`);
    }
    onClose();
  };

  return (
    <Sheet
      title={existing ? 'Edit follow-up' : 'Set a follow-up'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>{existing ? 'Save' : 'Set follow-up'}</button>
        </>
      }
    >
      <div className="stack">
        <div className="filter-bar">
          {PRESETS.map((p) => (
            <button
              key={p.days}
              className={`filter-chip${dueDate === addDays(p.days) ? ' is-active' : ''}`}
              onClick={() => setDueDate(addDays(p.days))}
            >
              {p.label}
            </button>
          ))}
        </div>
        <TextField label="Due date" value={dueDate} onChange={setDueDate} type="date" hint={relativeDue(dueDate)} />
        <TextArea
          label="Why — what is this follow-up for?"
          value={note}
          onChange={setNote}
          rows={3}
          placeholder="Check if the aircraft is still available"
        />
        <div className="field">
          <span className="field__label">Priority</span>
          <div className="row" style={{ gap: 6 }}>
            {(['Normal', 'High'] as FollowUpPriority[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`filter-chip${priority === p ? ' is-active' : ''}`}
                onClick={() => setPriority(p)}
                aria-pressed={priority === p}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Completing a follow-up is the one moment the user definitely knows what
 * happened. Asking then costs a sentence; asking later costs the record. The
 * outcome and the next follow-up are both optional — one tap on Done still
 * works.
 */
export function CompleteFollowUpSheet({
  followUp,
  onClose,
}: {
  followUp: FollowUp;
  onClose: () => void;
}) {
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [scheduleNext, setScheduleNext] = useState(false);
  const [nextDate, setNextDate] = useState(addDays(7));
  const [nextNote, setNextNote] = useState(followUp.note);

  const finish = () => {
    completeFollowUp(followUp.id, true, outcome);
    if (scheduleNext && nextNote.trim()) {
      createFollowUp({
        contactId: followUp.contactId,
        aircraftId: followUp.aircraftId,
        opportunityId: followUp.opportunityId,
        insurancePolicyId: followUp.insurancePolicyId,
        dueDate: nextDate,
        note: nextNote.trim(),
        priority: followUp.priority,
      });
      toast(`Done — next one set for ${formatDate(nextDate)}`);
    } else {
      toast('Follow-up completed');
    }
    onClose();
  };

  return (
    <Sheet
      title="Complete follow-up"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={finish}>
            <IconCheck /> Complete
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="card card--tight small secondary">{followUp.note || 'Follow up'}</div>
        <TextArea
          label="What happened?"
          value={outcome}
          onChange={setOutcome}
          rows={3}
          placeholder="Left a voicemail. Wants a call back after the 15th."
          hint="Optional. Anything here lands on the timeline."
        />
        <label className="checkbox">
          <input type="checkbox" checked={scheduleNext} onChange={(e) => setScheduleNext(e.target.checked)} />
          <span>Schedule the next follow-up</span>
        </label>
        {scheduleNext ? (
          <>
            <div className="filter-bar">
              {PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  className={`filter-chip${nextDate === addDays(p.days) ? ' is-active' : ''}`}
                  onClick={() => setNextDate(addDays(p.days))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <TextField label="Due date" value={nextDate} onChange={setNextDate} type="date" hint={relativeDue(nextDate)} />
            <TextArea label="Why" value={nextNote} onChange={setNextNote} rows={2} />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------- follow-ups

export function FollowUpList({ followUps, onEdit }: { followUps: FollowUp[]; onEdit: (f: FollowUp) => void }) {
  const toast = useToast();
  const [completing, setCompleting] = useState<FollowUp | null>(null);
  const open = followUps.filter((f) => !f.completed);
  if (open.length === 0) return null;
  return (
    <div className="list">
      {open.map((f) => (
        <div className="card card--tight" key={f.id}>
          <div className="row row--between">
            <span className="small strong truncate">{f.note || 'Follow up'}</span>
            <Chip tone={relativeDue(f.dueDate).includes('overdue') ? 'danger' : 'info'}>{relativeDue(f.dueDate)}</Chip>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {/* One tap completes it; the sheet is for when there is more to say. */}
            <button className="btn btn--sm grow" onClick={() => { completeFollowUp(f.id); toast('Follow-up completed'); }}>
              <IconCheck /> Done
            </button>
            <button className="btn btn--sm btn--ghost grow" onClick={() => setCompleting(f)}>Done + note</button>
            <button className="btn btn--sm btn--ghost grow" onClick={() => onEdit(f)}>Reschedule</button>
            <button className="btn btn--sm btn--ghost" onClick={() => { deleteFollowUp(f.id); toast('Follow-up removed'); }} aria-label="Delete follow-up">
              <IconTrash />
            </button>
          </div>
        </div>
      ))}
      {completing ? <CompleteFollowUpSheet followUp={completing} onClose={() => setCompleting(null)} /> : null}
    </div>
  );
}

// ----------------------------------------------------------------- files

export function FilesSection({
  files,
  links,
  defaultCategory = 'Other',
}: {
  files: FileRecord[];
  links: Links;
  defaultCategory?: DocumentCategory;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<DocumentCategory>(defaultCategory);

  const onPick = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setBusy(true);
    let attached = 0;
    try {
      for (const file of Array.from(fileList)) {
        if (file.size > 25 * 1024 * 1024) {
          toast(`${file.name} is larger than 25 MB and was skipped`, 'error');
          continue;
        }
        await addFile(file, links, category);
        attached += 1;
      }
      if (attached > 0) toast(attached === 1 ? 'Document attached' : `${attached} documents attached`);
    } catch (error) {
      // The blob write failed, so no row was created — say so rather than
      // leaving the user thinking the file is safe here.
      toast(`Could not store the document: ${(error as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = async (file: FileRecord) => {
    try {
      const blob = await getFile(file.id);
      if (!blob) {
        toast('That file is no longer stored on this device', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };

  return (
    <div className="stack stack--sm">
      {files.length === 0 ? (
        <div className="card small muted">No documents attached.</div>
      ) : (
        <div className="list list--flush">
          {files.map((f) => (
            <div className="link-row" key={f.id}>
              <IconDoc className="muted" style={{ width: 17, height: 17, flex: 'none' }} />
              <button className="grow truncate" style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => open(f)}>
                <div className="small truncate">{f.name}</div>
                <div className="xsmall muted">
                  {[f.category ?? 'Other', formatBytes(f.size), formatDate(f.createdAt)].join(' · ')}
                </div>
              </button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => { void removeFile(f.id).then(() => toast('File removed')); }}
                aria-label={`Remove ${f.name}`}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
      <SelectField label="Category for the next attachment" value={category} options={DOCUMENT_CATEGORIES} onChange={setCategory} />
      <label className="btn btn--ghost btn--block" style={{ cursor: 'pointer' }}>
        <IconUpload /> {busy ? 'Attaching…' : 'Attach a document'}
        <input type="file" multiple hidden onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }} />
      </label>
      <p className="xsmall muted">
        Documents are stored on this device only, inside the browser. Clearing this site's data removes
        them, and a JSON backup carries the list but not the files themselves.
      </p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------- external links

export function ExternalLinkList({ links, title }: { links: ExternalLink[]; title?: string }) {
  if (links.length === 0) return null;
  return (
    <div className="stack stack--sm">
      {title ? <h2 className="section-title">{title}</h2> : null}
      <div className="list list--flush">
        {links.map((l) => (
          <a className="link-row" key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
            <div className="grow">
              <div className="small truncate">{l.label}</div>
              <div className="xsmall muted truncate">{l.note ?? (l.isSearch ? 'Opens a search — results are not verified' : '')}</div>
            </div>
            <IconExternal className="muted" style={{ width: 16, height: 16, flex: 'none' }} />
          </a>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ misc pieces

export function NeedsReviewBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="banner banner--warn">
      <IconAlert />
      <div className="grow">{children}</div>
    </div>
  );
}

export function ActionGrid({ children }: { children: React.ReactNode }) {
  return <div className="btn-group">{children}</div>;
}

export function OpportunityLink({ id, label }: { id: string; label: string }) {
  return (
    <Link className="btn btn--sm btn--ghost" to={`/opportunities/${id}`}>
      <IconTarget /> {label}
    </Link>
  );
}

export function NewButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button className="btn btn--sm btn--ghost" onClick={onClick}>
      <IconPlus /> {label}
    </button>
  );
}

/** Copies text, and tells the user whether it worked rather than assuming. */
export function useCopy(): (text: string, label?: string) => void {
  const toast = useToast();
  return (text: string, label = 'Copied') => {
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      toast(ok ? label : 'Could not copy — select the text and copy it by hand', ok ? 'default' : 'error');
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => toast(label), fallback);
    } else {
      fallback();
    }
  };
}

export function EmptyTimeline() {
  return <EmptyState title="Nothing here yet" />;
}

/** Keeps a draft in state but resets when the underlying record changes. */
export function useDraft<T>(value: T, deps: unknown[]): [T, (next: T) => void] {
  const [draft, setDraft] = useState(value);
  const key = useMemo(() => JSON.stringify(deps), [deps]);
  useEffect(() => {
    setDraft(value);
    // The draft intentionally follows the record identity, not every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [draft, setDraft];
}

export { Banner };
