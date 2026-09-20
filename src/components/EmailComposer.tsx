/**
 * Email preview and composer.
 *
 * AEROBOOK never sends mail and never claims it did. The user can copy the
 * message or hand it to their mail client, and the activity that gets recorded
 * says exactly which of those happened.
 */
import { useMemo, useState } from 'react';

import { IconCopy, IconExternal, IconMail } from './Icons';
import { Banner, Chip, SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import { useCopy } from './detail';
import { useDatabase } from '../data/useStore';
import { logActivity } from '../data/store';
import { buildMailto, renderEmail, TEMPLATE_VARIABLES } from '../lib/email';
import { isValidEmail } from '../lib/phone';
import type { Aircraft, Contact } from '../data/types';

export function EmailComposer({
  contact,
  aircraft,
  opportunityId,
  onClose,
  onRecorded,
}: {
  contact: Contact | null;
  aircraft: Aircraft | null;
  opportunityId?: string | null;
  onClose: () => void;
  onRecorded?: () => void;
}) {
  const db = useDatabase();
  const toast = useToast();
  const copy = useCopy();

  const [templateId, setTemplateId] = useState(db.templates[0]?.id ?? '');
  const template = db.templates.find((t) => t.id === templateId) ?? db.templates[0];

  const rendered = useMemo(
    () => (template ? renderEmail(template, { contact, aircraft, settings: db.settings }) : null),
    [template, contact, aircraft, db.settings],
  );

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

  const record = (how: 'Prepared' | 'Opened in Mail' | 'Copied') => {
    logActivity({
      contactId: contact?.id ?? null,
      aircraftId: aircraft?.id ?? null,
      opportunityId: opportunityId ?? null,
      type: 'Email',
      subject: finalSubject,
      notes: `${how} — not a confirmed delivery.\n\n${finalBody}`,
    });
    toast(`Recorded: ${how}`);
    onRecorded?.();
  };

  const mailto = buildMailto({ to: finalTo, subject: finalSubject, body: finalBody, missing: [] });
  const emailUsable = isValidEmail(finalTo);
  const tooLongForMailto = mailto.length > 1800;

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
      }
    >
      <div className="stack">
        <SelectField
          label="Template"
          value={templateId}
          options={db.templates.map((t) => ({ value: t.id, label: t.name }))}
          onChange={changeTemplate}
        />

        {!emailUsable ? (
          <Banner tone="warn">
            {finalTo
              ? `“${finalTo}” does not look like a working email address.`
              : 'This contact has no email address. Add one, or copy the message and send it another way.'}
          </Banner>
        ) : null}

        {rendered.missing.length > 0 && !editing ? (
          <Banner tone="info">
            Not enough information for: {rendered.missing.join(', ')}. The message reads correctly without them, but
            check it before sending.
          </Banner>
        ) : null}

        {tooLongForMailto ? (
          <Banner tone="warn">
            This message is long enough that some mail clients will truncate a mailto link. Copy it instead if it
            arrives cut short.
          </Banner>
        ) : null}

        {editing ? (
          <>
            <TextField label="To" value={to} onChange={setTo} type="email" inputMode="email" />
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
            <div className="kv"><span className="kv__key">To</span><span className="kv__value">{finalTo || '—'}</span></div>
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

        <div className="row" style={{ gap: 8 }}>
          {editing ? (
            <button className="btn btn--sm btn--ghost grow" onClick={() => setEditing(false)}>Revert to template</button>
          ) : (
            <button className="btn btn--sm btn--ghost grow" onClick={startEditing}>Edit this message</button>
          )}
          <button className="btn btn--sm btn--ghost grow" onClick={() => record('Prepared')}>
            <IconMail /> Record as prepared
          </button>
        </div>

        <div className="row row--wrap" style={{ gap: 6 }}>
          <Chip>Prepared</Chip>
          <Chip>Opened in Mail</Chip>
          <Chip>Copied</Chip>
          <span className="xsmall muted">AEROBOOK cannot confirm delivery, so it never says “sent”.</span>
        </div>
      </div>
    </Sheet>
  );
}
