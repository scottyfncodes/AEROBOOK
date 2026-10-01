/**
 * Email preview and composer.
 *
 * Without attachments, AEROBOOK does not send the message itself and never
 * claims it did. The user can copy the message or hand it to their mail
 * client, and the activity that gets recorded says exactly which of those
 * happened.
 *
 * On a customer's profile, documents stored there can be attached. A mailto
 * link cannot carry a file, so an email with attachments is sent by AEROBOOK
 * (POST /api/email/send): only when Send is pressed, only to the address on
 * the customer's record, with the server reading the files from private
 * storage and recording what went on the customer's timeline.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { IconCheck, IconCopy, IconDoc, IconExternal, IconMail, IconPlus, IconSend, IconX } from './Icons';
import { Banner, Chip, SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import { useCopy } from './detail';
import { useDatabase } from '../data/useStore';
import { logActivity } from '../data/store';
import { useSession } from '../data/session';
import { emailConfig, sendCustomerEmail, Unreachable, type EmailConfig } from '../data/auth';
import { buildMailto, renderEmail, TEMPLATE_VARIABLES } from '../lib/email';
import { Link } from 'react-router-dom';
import { isValidEmail } from '../lib/phone';
import { policiesFor, policyState } from '../lib/insurance';
import { nextFollowUpFor, type LinkedDocument } from '../lib/selectors';
import { attachmentProblem, attachmentsProblem } from '../lib/documents';
import { newId } from '../lib/id';
import type { Aircraft, Contact } from '../data/types';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "a, b and c" — a warning reads better than a comma-separated list. */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function EmailComposer({
  contact,
  aircraft,
  opportunityId,
  documents,
  initialAttachments,
  onClose,
  onRecorded,
}: {
  contact: Contact | null;
  aircraft: Aircraft | null;
  opportunityId?: string | null;
  /** The documents on the customer's profile, which may be attached. Without it, nothing can be. */
  documents?: LinkedDocument[];
  /** Documents chosen before the composer opened. Nothing is sent until Send is pressed. */
  initialAttachments?: string[];
  onClose: () => void;
  onRecorded?: () => void;
}) {
  const db = useDatabase();
  const toast = useToast();
  const copy = useCopy();
  const { cloud } = useSession();

  const opportunity = opportunityId ? db.opportunities.find((o) => o.id === opportunityId) ?? null : null;

  /**
   * The message is almost always about the thing that is happening: a renewal
   * inside the window, or the deal it was opened from. Picking that template
   * first saves a tap and, more importantly, saves sending the wrong one.
   */
  const policy = useMemo(() => {
    const candidates = [
      ...(aircraft ? policiesFor(db, { aircraftId: aircraft.id }) : []),
      ...(contact ? policiesFor(db, { contactId: contact.id }) : []),
      ...(opportunityId ? policiesFor(db, { opportunityId }) : []),
    ];
    return candidates[0] ?? null;
  }, [db, aircraft, contact, opportunityId]);

  const followUpDate = useMemo(() => {
    const match = opportunityId
      ? { opportunityId }
      : aircraft
        ? { aircraftId: aircraft.id }
        : contact
          ? { contactId: contact.id }
          : {};
    return nextFollowUpFor(db, match)?.dueDate ?? null;
  }, [db, aircraft, contact, opportunityId]);

  const suggestedId = useMemo(() => {
    if (policy && policyState(policy).needsAttention) return 'tpl_renewal_followup';
    if (opportunity?.type.includes('Insurance')) return 'tpl_insurance_outreach';
    if (opportunity?.type.includes('Sale')) return 'tpl_brokerage_outreach';
    if (opportunity?.type.includes('Purchase')) return 'tpl_purchase_inquiry';
    return db.templates[0]?.id ?? '';
  }, [policy, opportunity, db.templates]);

  const [templateId, setTemplateId] = useState(
    () => (db.templates.some((t) => t.id === suggestedId) ? suggestedId : db.templates[0]?.id ?? ''),
  );
  const template = db.templates.find((t) => t.id === templateId) ?? db.templates[0];

  const rendered = useMemo(
    () =>
      template
        ? renderEmail(template, { contact, aircraft, opportunity, policy, followUpDate, settings: db.settings })
        : null,
    [template, contact, aircraft, opportunity, policy, followUpDate, db.settings],
  );

  // ----------------------------------------------------------- attachments
  const canAttach = Boolean(documents && contact);
  const [attached, setAttached] = useState<string[]>(
    () => (initialAttachments ?? []).filter((id) => documents?.some((d) => d.file.id === id)),
  );
  const [choosing, setChoosing] = useState(false);
  const [config, setConfig] = useState<EmailConfig | null | 'unavailable'>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // One id per email: a retry after a lost connection cannot send it twice.
  const sendId = useRef(newId('snd'));

  useEffect(() => {
    if (!canAttach) return;
    let live = true;
    emailConfig().then(
      (c) => { if (live) setConfig(c); },
      () => { if (live) setConfig('unavailable'); },
    );
    return () => { live = false; };
  }, [canAttach]);

  const limits = config && config !== 'unavailable' ? config : null;
  const maxFileBytes = limits?.maxFileBytes ?? 25 * 1024 * 1024;
  const attachedDocs = attached
    .map((id) => documents?.find((d) => d.file.id === id)?.file)
    .filter((f): f is NonNullable<typeof f> => Boolean(f));
  const withAttachments = attachedDocs.length > 0;
  const fileProblems = attachedDocs.some((f) => attachmentProblem(f, maxFileBytes));
  const groupProblem = limits ? attachmentsProblem(attachedDocs, limits) : null;
  const totalBytes = attachedDocs.reduce((sum, f) => sum + (f.size || 0), 0);

  const toggleAttached = (id: string, on: boolean) => {
    setSendError(null);
    setAttached((ids) => (on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)));
  };

  const [editing, setEditing] = useState(false);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  // The rendered template is the source of truth until the user edits it.
  const finalTo = editing ? to : (rendered?.to ?? '');
  const finalSubject = editing ? subject : (rendered?.subject ?? '');
  const finalBody = editing ? body : (rendered?.body ?? '');

  const startEditing = () => {
    setTo(finalTo);
    setSubject(finalSubject);
    setBody(finalBody);
    setEditing(true);
  };

  const changeTemplate = (id: string) => {
    setTemplateId(id);
    setEditing(false);
  };

  const record = (how: 'Prepared' | 'Opened in Mail' | 'Copied' | 'Marked sent by you') => {
    // AEROBOOK has no mail integration, so the record always says who knows
    // what — "marked sent by you" is the user's assertion, not the app's.
    const qualifier =
      how === 'Marked sent by you'
        ? 'You marked this as sent. AEROBOOK did not send it and cannot confirm delivery.'
        : 'Not a confirmed delivery.';
    logActivity({
      contactId: contact?.id ?? null,
      aircraftId: aircraft?.id ?? null,
      opportunityId: opportunityId ?? null,
      type: 'Email',
      subject: finalSubject,
      notes: `${how} — ${qualifier}\n\n${finalBody}`,
    });
    toast(`Recorded: ${how}`);
    onRecorded?.();
  };

  // Variable keys are for template authors; a warning should read in English.
  const missingLabels = (rendered?.missing ?? []).map(
    (key) => TEMPLATE_VARIABLES.find((v) => v.key === key)?.label.toLowerCase() ?? key,
  );
  const missingAreSenderFields = (rendered?.missing ?? []).every((key) => key.startsWith('sender'));

  const mailto = buildMailto({ to: finalTo, subject: finalSubject, body: finalBody, missing: [] });
  const emailUsable = isValidEmail(finalTo);
  const tooLongForMailto = mailto.length > 1800;

  // With attachments, the email goes to the address on the profile — the
  // server will not send a customer's documents anywhere else.
  const profileAddress = contact?.email ?? '';
  const profileAddressUsable = isValidEmail(profileAddress);
  const sendBlocked =
    !limits?.enabled || !profileAddressUsable || fileProblems || Boolean(groupProblem)
    || !finalSubject.trim() || !finalBody.trim();

  const send = async () => {
    if (!contact || sending || sendBlocked) return;
    setSending(true);
    setSendError(null);
    try {
      const result = await sendCustomerEmail({
        contactId: contact.id,
        fileIds: attachedDocs.map((f) => f.id),
        subject: finalSubject,
        body: finalBody,
        sendId: sendId.current,
        aircraftId: aircraft?.id ?? null,
        opportunityId: opportunityId ?? null,
      });
      const count = result.attachments.length;
      toast(`Email sent to ${result.sentTo} with ${count === 1 ? '1 document' : `${count} documents`}`);
      if (!result.activityId) toast('The email went, but it could not be added to the timeline', 'error');
      void cloud?.refresh();
      onRecorded?.();
      onClose();
    } catch (error) {
      if (error instanceof Unreachable) {
        // It may have gone. Sending again with the same id cannot send twice.
        setSendError('Could not reach AEROBOOK, so the email may not have gone. Check the connection and press Send again — it will not be sent twice.');
      } else {
        // The server answered, so nothing went; the next try is a new email.
        sendId.current = newId('snd');
        setSendError((error as Error).message);
      }
    } finally {
      setSending(false);
    }
  };

  if (!template || !rendered) {
    return (
      <Sheet title="Email preview" onClose={onClose}>
        <Banner tone="warn">No email templates are available. Add one under Settings → Email templates.</Banner>
      </Sheet>
    );
  }

  return (
    <Sheet
      title="Email preview"
      onClose={onClose}
      footer={
        withAttachments ? (
          <>
            <button className="btn btn--ghost" onClick={onClose} disabled={sending}>Cancel</button>
            <button className="btn btn--primary" onClick={() => void send()} disabled={sending || sendBlocked}>
              <IconSend /> {sending ? 'Sending…' : `Send with ${attachedDocs.length === 1 ? '1 document' : `${attachedDocs.length} documents`}`}
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--ghost" onClick={() => copy(`${finalSubject}\n\n${finalBody}`, 'Email copied')}>
              <IconCopy /> Copy
            </button>
            <a
              className="btn btn--primary"
              href={mailto}
              onClick={() => record('Opened in Mail')}
              aria-disabled={!emailUsable}
              style={!emailUsable ? { pointerEvents: 'none', opacity: 0.45 } : undefined}
            >
              <IconExternal /> Open in Mail
            </a>
          </>
        )
      }
    >
      <div className="stack">
        <SelectField
          label="Template"
          value={templateId}
          options={db.templates.map((t) => ({ value: t.id, label: t.name }))}
          onChange={changeTemplate}
        />

        {sendError ? <Banner tone="danger">{sendError}</Banner> : null}

        {withAttachments && !profileAddressUsable ? (
          <Banner tone="warn">
            This customer has no working email address on their profile. Add one to send them documents.
          </Banner>
        ) : null}

        {!withAttachments && !emailUsable ? (
          <Banner tone="warn">
            {finalTo
              ? `“${finalTo}” does not look like a working email address.`
              : 'This contact has no email address. Add one, or copy the message and send it another way.'}
          </Banner>
        ) : null}

        {missingLabels.length > 0 && !editing ? (
          <Banner tone="info">
            Nothing on file for {listPhrase(missingLabels)}. The message still reads correctly without{' '}
            {missingLabels.length === 1 ? 'it' : 'them'}
            {missingAreSenderFields ? <> — fill your details in under <Link to="/settings">Settings</Link></> : null}.
          </Banner>
        ) : null}

        {tooLongForMailto && !withAttachments ? (
          <Banner tone="warn">
            This message is long enough that some mail clients will truncate a mailto link. Copy it instead if it
            arrives cut short.
          </Banner>
        ) : null}

        {editing ? (
          <>
            {withAttachments ? (
              <div className="kv"><span className="kv__key">To</span><span className="kv__value">{profileAddress || '—'}</span></div>
            ) : (
              <TextField label="To" value={to} onChange={setTo} type="email" inputMode="email" />
            )}
            <TextField label="Subject" value={subject} onChange={setSubject} />
            <TextArea label="Body" value={body} onChange={setBody} rows={14} />
            <details>
              <summary className="small muted" style={{ cursor: 'pointer' }}>Variables you can use</summary>
              <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
                {TEMPLATE_VARIABLES.map((v) => (
                  <button
                    key={v.key}
                    className="chip"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setBody(`${body}{{${v.key}}}`)}
                    title={v.label}
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
            </details>
          </>
        ) : (
          <div className="card stack stack--sm">
            <div className="kv"><span className="kv__key">To</span><span className="kv__value">{(withAttachments ? profileAddress : finalTo) || '—'}</span></div>
            <div className="kv"><span className="kv__key">Subject</span><span className="kv__value strong">{finalSubject}</span></div>
            <div className="divider" />
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                font: 'inherit',
                fontSize: 14,
                lineHeight: 1.55,
                color: 'var(--text-secondary)',
              }}
            >
              {finalBody}
            </pre>
          </div>
        )}

        {canAttach ? (
          <AttachmentsCard
            documents={documents ?? []}
            attached={attachedDocs}
            maxFileBytes={maxFileBytes}
            totalBytes={totalBytes}
            choosing={choosing}
            setChoosing={setChoosing}
            onToggle={toggleAttached}
            disabled={sending}
          />
        ) : null}

        {withAttachments ? (
          <>
            {groupProblem ? <Banner tone="warn">{groupProblem}</Banner> : null}
            {config === 'unavailable' ? (
              <Banner tone="warn">Could not check whether AEROBOOK can send email. Check the connection and open this again.</Banner>
            ) : limits && !limits.enabled ? (
              <Banner tone="warn">
                Sending email from AEROBOOK is not set up yet, so documents cannot be emailed. Ask an admin, or
                remove the attachments to open the message in your mail app.
              </Banner>
            ) : null}
            <p className="xsmall muted">
              A mail app cannot be handed attachments, so AEROBOOK sends this email itself, to the address on
              this customer’s profile, when you press Send. Replies come to your own email address. The email
              and its documents are recorded on the customer’s timeline.
            </p>
          </>
        ) : null}

        <div className="row" style={{ gap: 8 }}>
          {editing ? (
            <button className="btn btn--sm btn--ghost grow" onClick={() => setEditing(false)}>Revert to template</button>
          ) : (
            <button className="btn btn--sm btn--ghost grow" onClick={startEditing}>Edit this message</button>
          )}
          {withAttachments ? null : (
            <button className="btn btn--sm btn--ghost grow" onClick={() => record('Prepared')}>
              <IconMail /> Record as prepared
            </button>
          )}
        </div>

        {withAttachments ? null : (
          <>
            <button className="btn btn--sm btn--ghost btn--block" onClick={() => record('Marked sent by you')}>
              <IconCheck /> Mark as sent
            </button>

            <div className="row row--wrap" style={{ gap: 6 }}>
              <Chip>Prepared</Chip>
              <Chip>Opened in Mail</Chip>
              <Chip>Copied</Chip>
              <Chip>Marked sent by you</Chip>
              <span className="xsmall muted">
                Without attachments, AEROBOOK does not send the message itself. It records what it did, and
                records “sent” only as something you told it.
              </span>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** The documents going with the email, a way to remove each, and the customer's others to add. */
function AttachmentsCard({
  documents,
  attached,
  maxFileBytes,
  totalBytes,
  choosing,
  setChoosing,
  onToggle,
  disabled,
}: {
  documents: LinkedDocument[];
  attached: LinkedDocument['file'][];
  maxFileBytes: number;
  totalBytes: number;
  choosing: boolean;
  setChoosing: (on: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
  disabled: boolean;
}) {
  const attachedIds = new Set(attached.map((f) => f.id));
  return (
    <div className="card stack stack--sm">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
        <span className="strong small">Attachments</span>
        <span className="xsmall muted">
          {attached.length === 0 ? 'None' : `${attached.length} · ${formatBytes(totalBytes)}`}
        </span>
      </div>
      {attached.length > 0 ? (
        <div className="list list--flush">
          {attached.map((f) => {
            const problem = attachmentProblem(f, maxFileBytes);
            return (
              <div className="link-row" key={f.id}>
                <IconDoc className="muted" style={{ width: 17, height: 17, flex: 'none' }} />
                <div className="grow truncate">
                  <div className="small truncate">{f.name}</div>
                  <div className={`xsmall ${problem ? '' : 'muted'}`} style={problem ? { color: 'var(--danger)' } : undefined}>
                    {problem ? `Cannot be sent: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}` : formatBytes(f.size)}
                  </div>
                </div>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => onToggle(f.id, false)}
                  disabled={disabled}
                  aria-label={`Remove attachment ${f.name}`}
                  title="Remove attachment"
                >
                  <IconX />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {choosing ? (
        documents.length === 0 ? (
          <div className="small muted">There are no documents on this customer’s profile.</div>
        ) : (
          <div className="list list--flush">
            {documents.map(({ file: f, via }) => {
              const problem = attachmentProblem(f, maxFileBytes);
              return (
                <label className="checkbox-row picker-row" key={f.id} style={problem ? { opacity: 0.55 } : undefined}>
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={attachedIds.has(f.id)}
                    disabled={disabled || (Boolean(problem) && !attachedIds.has(f.id))}
                    onChange={(e) => onToggle(f.id, e.target.checked)}
                  />
                  <span className="grow truncate">
                    <span className="small truncate" style={{ display: 'block' }}>{f.name}</span>
                    <span className="xsmall muted">
                      {problem ?? [via ? `On ${via}` : '', formatBytes(f.size)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )
      ) : null}
      <button className="btn btn--sm btn--ghost btn--block" onClick={() => setChoosing(!choosing)} disabled={disabled}>
        {choosing ? 'Done choosing' : <><IconPlus /> {attached.length ? 'Attach more documents' : 'Attach documents from this profile'}</>}
      </button>
    </div>
  );
}
