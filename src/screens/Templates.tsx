import { useState } from 'react';

import { AppBar } from '../components/AppBar';
import { IconMail, IconPlus, IconTrash } from '../components/Icons';
import { Banner, Chip, ConfirmButton, Sheet, TextArea, TextField, useToast } from '../components/ui';
import { useDatabase } from '../data/useStore';
import { createTemplate, deleteTemplate, resetTemplates, saveTemplate } from '../data/store';
import { TEMPLATE_VARIABLES, renderEmail } from '../lib/email';
import type { EmailTemplate } from '../data/types';

/** A record used only to show the user what a template looks like rendered. */
const SAMPLE_CONTACT = {
  id: 'sample', firstName: 'John', lastName: 'Heine', rawName: 'Heine John Charles', company: '',
  email: 'owner@example.com', phone: '', address: '', city: 'Santa Barbara', state: 'CA', zip: '',
  contactTypes: [], status: 'Prospect' as const, prospectStatus: 'New' as const, notes: '',
  custom: {}, nameConfidence: 'high' as const, needsReview: false, createdAt: '', updatedAt: '',
};

const SAMPLE_AIRCRAFT = {
  id: 'sample', tailNumber: 'N917JH', tailKey: '917JH', year: '2026', make: 'Cirrus', model: 'SR22T',
  ownerships: [], status: 'Unknown' as const, notes: '', custom: {}, createdAt: '', updatedAt: '',
};

export default function Templates() {
  const db = useDatabase();
  const toast = useToast();
  const [editing, setEditing] = useState<EmailTemplate | null>(null);

  return (
    <>
      <AppBar
        title="Email templates"
        back="/settings"
        actions={
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => { const t = createTemplate('New template'); setEditing(t); }}
            aria-label="New template"
          >
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        <Banner tone="info">
          Templates are yours to change. Variables like <code>{'{{firstName}}'}</code> and <code>{'{{tail}}'}</code> are
          filled in from the record you are emailing about.
        </Banner>

        <div className="list">
          {db.templates.map((t) => {
            const preview = renderEmail(t, { contact: SAMPLE_CONTACT, aircraft: SAMPLE_AIRCRAFT, settings: db.settings });
            return (
              <button className="tile" key={t.id} onClick={() => setEditing(t)}>
                <div className="row row--between">
                  <span className="strong truncate">{t.name}</span>
                  {t.builtIn ? <Chip>Built in</Chip> : null}
                </div>
                <div className="small secondary truncate">{preview.subject}</div>
                <div className="xsmall muted truncate">{preview.body.split('\n')[0]}</div>
              </button>
            );
          })}
        </div>

        <ConfirmButton
          label="Reset to the built-in templates"
          confirmLabel="Tap again — this discards your edits"
          className="btn btn--ghost btn--block"
          onConfirm={() => { resetTemplates(); toast('Templates reset'); }}
        />
      </main>

      {editing ? <EditTemplateSheet template={editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function EditTemplateSheet({ template, onClose }: { template: EmailTemplate; onClose: () => void }) {
  const db = useDatabase();
  const toast = useToast();
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [showPreview, setShowPreview] = useState(false);

  const preview = renderEmail(
    { ...template, subject, body },
    { contact: SAMPLE_CONTACT, aircraft: SAMPLE_AIRCRAFT, settings: db.settings },
  );

  const insert = (key: string) => setBody(`${body}{{${key}}}`);

  return (
    <Sheet
      title={template.builtIn ? `Edit ${template.name}` : 'Edit template'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => {
              saveTemplate({ ...template, name: name.trim() || 'Untitled', subject, body });
              toast('Template saved');
              onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} />
        <TextField label="Subject" value={subject} onChange={setSubject} />
        <TextArea label="Body" value={body} onChange={setBody} rows={14} />

        <div className="field">
          <span className="field__label">Insert a variable</span>
          <div className="row row--wrap" style={{ gap: 6 }}>
            {TEMPLATE_VARIABLES.map((v) => (
              <button key={v.key} className="chip" style={{ cursor: 'pointer' }} onClick={() => insert(v.key)} title={v.label}>
                {`{{${v.key}}}`}
              </button>
            ))}
          </div>
          <span className="field__hint">
            The sender variables come from Settings. A variable with nothing behind it renders as nothing — the message
            still reads correctly.
          </span>
        </div>

        <button className="btn btn--ghost btn--block" onClick={() => setShowPreview((v) => !v)}>
          <IconMail /> {showPreview ? 'Hide' : 'Show'} preview
        </button>

        {showPreview ? (
          <div className="card stack stack--sm">
            <div className="xsmall muted">Rendered against a sample record</div>
            <div className="strong small">{preview.subject}</div>
            <div className="divider" />
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', font: 'inherit', fontSize: 14, color: 'var(--text-secondary)' }}>
              {preview.body}
            </pre>
          </div>
        ) : null}

        {!template.builtIn ? (
          <ConfirmButton
            label="Delete this template"
            confirmLabel="Tap again to delete"
            className="btn btn--danger btn--block"
            onConfirm={() => { deleteTemplate(template.id); toast('Template deleted'); onClose(); }}
          />
        ) : (
          <p className="xsmall muted">
            <IconTrash style={{ width: 12, height: 12, verticalAlign: '-2px' }} /> Built-in templates can be edited but
            not deleted. Reset restores them.
          </p>
        )}
      </div>
    </Sheet>
  );
}
