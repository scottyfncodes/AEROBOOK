/**
 * The pieces every detail screen shares: the timeline, the activity and
 * follow-up sheets, the file list, and the external-link list.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';

import {
  IconAlert, IconCalendar, IconCheck, IconClock, IconDoc, IconEdit, IconExternal, IconMail, IconNote,
  IconPhone, IconPlus, IconTarget, IconTrash, IconUpload,
} from './Icons';
import { Banner, Chip, ColorDot, EmptyState, SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import type {
  Activity, ActivityType, DocumentCategory, FollowUp, FollowUpKind, FollowUpPriority, FileRecord,
} from '../data/types';
import { ACTIVITY_TYPES, DOCUMENT_CATEGORIES } from '../data/types';
import {
  addFile, completeFollowUp, createFollowUp, deleteFollowUp, getFile, logActivity, removeFile, renameFile,
  updateActivity, updateFollowUp,
} from '../data/store';
import { addDays, dateKey, formatDate, relativeDue, todayKey } from '../lib/dates';
import { isTask, TASK_KINDS, taskLabel, taskText } from '../lib/tasks';
import { DOCUMENT_ACCEPT, documentType, DOCUMENT_TYPES_HINT, renamedDocument } from '../lib/documents';
import { useCurrentUser, useTeam } from '../data/session';
import type { ExternalLink } from '../lib/links';
import type { LinkedDocument } from '../lib/selectors';

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
  const [editing, setEditing] = useState<Activity | null>(null);

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
      {editing ? <ActivitySheet links={{}} existing={editing} onClose={() => setEditing(null)} /> : null}
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
                  <div className="small secondary">{taskText(f)}</div>
                  <WhoLine f={f} />
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
                <div className="xsmall muted">
                  {a.type}
                  {a.updatedAt ? ` · edited ${formatDate(a.updatedAt)}` : ''}
                </div>
                {a.notes ? <TimelineNote text={a.notes} /> : null}
                <div className="timeline__actions">
                  <button
                    className="timeline__action"
                    onClick={() => setEditing(a)}
                    aria-label={`Edit "${a.subject || a.type}"`}
                  >
                    <IconEdit />
                  </button>
                  {onDeleteActivity ? (
                    <button
                      className="timeline__action timeline__action--remove"
                      onClick={() => onDeleteActivity(a.id)}
                      aria-label={`Remove "${a.subject || a.type}" from the timeline`}
                    >
                      <IconTrash />
                    </button>
                  ) : null}
                </div>
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
  existing,
  defaultType = 'Note',
  defaultSubject = '',
  title = 'Log activity',
  onClose,
}: {
  links: Links;
  /** An entry already on the timeline, to correct rather than record anew. */
  existing?: Activity;
  defaultType?: ActivityType;
  defaultSubject?: string;
  title?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<ActivityType>(existing?.type ?? defaultType);
  const [subject, setSubject] = useState(existing?.subject ?? defaultSubject);
  // Recorded dates are full timestamps; the field edits the day. An untouched
  // date keeps its time, so saving a text fix does not reorder the timeline.
  const originalDay = existing ? dateKey(existing.date) : undefined;
  const [date, setDate] = useState(originalDay ?? todayKey());
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const save = () => {
    const fields = { type, subject: subject.trim() || type, notes: notes.trim() };
    if (existing) {
      updateActivity(existing.id, date === originalDay ? fields : { ...fields, date });
      toast('Entry updated');
    } else {
      logActivity({ ...links, ...fields, date });
      toast(`${type} recorded`);
    }
    onClose();
  };

  return (
    <Sheet
      title={existing ? 'Edit entry' : title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>{existing ? 'Save' : 'Record'}</button>
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
  assign = false,
  defaultNote = '',
  defaultDueDate,
  onClose,
}: {
  links: Links;
  existing?: FollowUp;
  /** Giving someone else a task, rather than setting a follow-up for yourself. */
  assign?: boolean;
  defaultNote?: string;
  defaultDueDate?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const me = useCurrentUser();
  const { people, nameOf } = useTeam();
  const [dueDate, setDueDate] = useState(existing?.dueDate ?? defaultDueDate ?? addDays(7));
  const [kind, setKind] = useState<FollowUpKind>(existing?.kind ?? 'follow-up');
  const [note, setNote] = useState(existing?.note ?? (assign ? '' : defaultNote));
  const [priority, setPriority] = useState<FollowUpPriority>(existing?.priority ?? 'Normal');
  // A follow-up is your own; a task needs someone picked.
  const [assigneeId, setAssigneeId] = useState(existing?.assigneeId ?? (assign ? '' : me.id));

  // Someone else on the team, by name. People whose access is off cannot be
  // given new work, but whoever already holds this one still shows, so
  // opening the sheet changes nothing.
  const assigneeOptions = [
    ...(assigneeId ? [] : [{ value: '', label: 'Choose someone' }]),
    ...people
      .filter((p) => (p.active && p.id !== me.id) || p.id === assigneeId)
      .map((p) => ({ value: p.id, label: p.id === me.id ? `${p.name} (you)` : p.name })),
  ];

  const save = () => {
    if (assign && !assigneeId) return;
    const fields = assign
      ? { dueDate, kind, note: note.trim(), priority, assigneeId, assignedBy: existing?.assignedBy ?? me.id }
      : { dueDate, note: note.trim(), priority, ...(existing ? {} : { assigneeId: me.id }) };
    if (existing) {
      updateFollowUp(existing.id, { ...fields, completed: false, completedAt: undefined });
      toast(
        assign && existing.assigneeId !== assigneeId
          ? `${taskLabel(kind)} given to ${nameOf(assigneeId)}`
          : assign ? 'Task updated' : 'Follow-up updated',
      );
    } else {
      createFollowUp({ ...links, ...fields });
      toast(
        assign
          ? `${taskLabel(kind)} assigned to ${nameOf(assigneeId)}, due ${formatDate(dueDate)}`
          : `Follow-up set for ${formatDate(dueDate)}`,
      );
    }
    onClose();
  };

  const title = existing ? (assign ? 'Edit task' : 'Edit follow-up') : (assign ? 'Assign a task' : 'Set a follow-up');
  const action = existing ? 'Save' : (assign ? 'Assign' : 'Set follow-up');

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={assign && !assigneeId} onClick={save}>{action}</button>
        </>
      }
    >
      <div className="stack">
        {assign ? (
          <>
            <SelectField
              label="Assign to"
              value={assigneeId}
              options={assigneeOptions}
              onChange={setAssigneeId}
              hint={assigneeId && assigneeId !== me.id ? 'They get a notification on their phone.' : undefined}
            />
            <div className="field">
              <span className="field__label">What to do</span>
              <div className="row row--wrap" style={{ gap: 6 }}>
                {TASK_KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    className={`filter-chip${kind === k.value ? ' is-active' : ''}`}
                    onClick={() => setKind(k.value)}
                    aria-pressed={kind === k.value}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
        <TextArea
          label={assign ? 'Note for them' : 'Note'}
          value={note}
          onChange={setNote}
          rows={3}
          placeholder={assign ? 'Hull and liability, owner wants it by Friday' : 'Check if the aircraft is still available'}
        />
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
        // The next step in the same piece of work stays with the same person.
        assigneeId: followUp.assigneeId ?? null,
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
        <div className="card card--tight small secondary">{taskText(followUp)}</div>
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

/**
 * Who a follow-up is for, when not you, and who gave you a task, when someone
 * did: each name with the dot of the color they picked.
 */
function WhoLine({ f, style }: { f: FollowUp; style?: CSSProperties }) {
  const me = useCurrentUser();
  const { nameOf, colorOf } = useTeam();
  const forSomeoneElse = f.assigneeId !== me.id;
  const fromSomeoneElse = isTask(f) && f.assignedBy !== me.id && !forSomeoneElse;
  if (!forSomeoneElse && !fromSomeoneElse) return null;
  const who = forSomeoneElse ? f.assigneeId : f.assignedBy;
  return (
    <div className="xsmall muted row" style={{ gap: 5, ...style }}>
      <ColorDot color={colorOf(who)} />
      <span>{forSomeoneElse ? 'For' : 'From'} {nameOf(who)}</span>
    </div>
  );
}

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
            <span className="small strong truncate">{taskText(f)}</span>
            <Chip tone={relativeDue(f.dueDate).includes('overdue') ? 'danger' : 'info'}>{relativeDue(f.dueDate)}</Chip>
          </div>
          <WhoLine f={f} style={{ marginTop: 4 }} />
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {/* One tap completes it; the sheet is for when there is more to say. */}
            <button className="btn btn--sm grow" onClick={() => { completeFollowUp(f.id); toast('Follow-up completed'); }}>
              <IconCheck /> Done
            </button>
            <button className="btn btn--sm btn--ghost grow" onClick={() => setCompleting(f)}>Done + note</button>
            <button className="btn btn--sm btn--ghost grow" onClick={() => onEdit(f)}>Edit</button>
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
  documents,
  links,
  defaultCategory = 'Other',
}: {
  documents: LinkedDocument[];
  links: Links;
  defaultCategory?: DocumentCategory;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<DocumentCategory>(defaultCategory);
  const [renaming, setRenaming] = useState<FileRecord | null>(null);

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
        if (!documentType(file.name, file.type)) {
          toast(`${file.name} was skipped: attach a ${DOCUMENT_TYPES_HINT} file`, 'error');
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
      {documents.length === 0 ? (
        <div className="card small muted">No documents attached.</div>
      ) : (
        <div className="list list--flush">
          {documents.map(({ file: f, via }) => (
            <div className="link-row" key={f.id}>
              <IconDoc className="muted" style={{ width: 17, height: 17, flex: 'none' }} />
              <button className="grow truncate" style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => open(f)}>
                <div className="small truncate">{f.name}</div>
                <div className="xsmall muted">
                  {[via ? `On ${via}` : '', f.category ?? 'Other', formatBytes(f.size), formatDate(f.createdAt)].filter(Boolean).join(' · ')}
                </div>
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => setRenaming(f)} aria-label={`Rename ${f.name}`}>
                <IconEdit />
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
        <input type="file" multiple hidden accept={DOCUMENT_ACCEPT} onChange={(e) => { void onPick(e.target.files); e.target.value = ''; }} />
      </label>
      <p className="xsmall muted">
        Documents are stored privately in the cloud: everyone on the team can open them, and only people
        signed in to AEROBOOK. A JSON backup carries the list but not the files.
      </p>
      {renaming ? <RenameFileSheet file={renaming} onClose={() => setRenaming(null)} /> : null}
    </div>
  );
}

function RenameFileSheet({ file, onClose }: { file: FileRecord; onClose: () => void }) {
  const toast = useToast();
  const ext = /\.[a-z0-9]+$/i.exec(file.name)?.[0] ?? '';
  const [name, setName] = useState(ext ? file.name.slice(0, -ext.length) : file.name);
  const next = renamedDocument(file.name, name);

  const save = () => {
    if (!next) return;
    if (next !== file.name) {
      renameFile(file.id, next);
      toast(`Renamed to ${next}`);
    }
    onClose();
  };

  return (
    <Sheet
      title="Rename document"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!next} onClick={save}>Save</button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label="File name"
          value={name}
          onChange={setName}
          autoComplete="off"
          hint={ext ? `Saved as ${next ?? `…${ext}`}` : undefined}
        />
      </div>
    </Sheet>
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
