/**
 * Insurance UI.
 *
 * One card and one sheet, shared by the aircraft, the contact and the deal,
 * so a renewal looks and behaves the same wherever the user meets it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { IconCalendar, IconPlus, IconShield, IconTrash } from './Icons';
import { Chip, ConfirmButton, KeyValue, SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import { createPolicy, deletePolicy, updatePolicy } from '../data/store';
import { RENEWAL_STATUSES, type InsurancePolicy, type RenewalStatus } from '../data/types';
import { policyLabel, policyState } from '../lib/insurance';
import { formatDate } from '../lib/dates';

/** The chip that says where a renewal stands. Text first, colour second. */
export function RenewalChip({ policy, now }: { policy: InsurancePolicy; now?: Date }) {
  const state = policyState(policy, now);
  return <Chip tone={state.tone}>{state.countdown || state.status}</Chip>;
}

export function PolicyCard({
  policy,
  onEdit,
  onFollowUp,
  footer,
}: {
  policy: InsurancePolicy;
  onEdit?: () => void;
  onFollowUp?: () => void;
  footer?: React.ReactNode;
}) {
  const state = policyState(policy);
  return (
    <div className="card stack stack--sm">
      <div className="row row--between">
        <span className="strong truncate">{policyLabel(policy)}</span>
        <Chip tone={state.tone}>{state.status}</Chip>
      </div>

      {state.countdown ? (
        <div className={state.needsAttention ? 'strong' : 'secondary'} style={{ fontSize: 15 }}>
          {state.countdown}
        </div>
      ) : (
        <div className="small muted">No expiration date on record.</div>
      )}

      <div className="card card--tight" style={{ background: 'var(--bg-elevated)' }}>
        {policy.policyNumber ? <KeyValue k="Policy">{policy.policyNumber}</KeyValue> : null}
        {policy.effectiveDate ? <KeyValue k="Effective">{formatDate(policy.effectiveDate)}</KeyValue> : null}
        {policy.expirationDate ? <KeyValue k="Expires">{formatDate(policy.expirationDate)}</KeyValue> : null}
        {policy.hullValue ? <KeyValue k="Hull value">{policy.hullValue}</KeyValue> : null}
        {policy.liabilityLimit ? <KeyValue k="Liability">{policy.liabilityLimit}</KeyValue> : null}
        {policy.deductible ? <KeyValue k="Deductible">{policy.deductible}</KeyValue> : null}
        {policy.premium ? <KeyValue k="Premium">{policy.premium}</KeyValue> : null}
        {policy.quotedPremium ? <KeyValue k="Quoted">{policy.quotedPremium}</KeyValue> : null}
        {policy.lastQuoteDate ? <KeyValue k="Last quote">{formatDate(policy.lastQuoteDate)}</KeyValue> : null}
        {policy.brokerAgent ? <KeyValue k="Broker">{policy.brokerAgent}</KeyValue> : null}
      </div>

      {policy.renewalNotes ? <div className="small secondary" style={{ whiteSpace: 'pre-wrap' }}>{policy.renewalNotes}</div> : null}
      {policy.notes ? <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{policy.notes}</div> : null}

      <div className="row" style={{ gap: 6 }}>
        {onEdit ? (
          <button className="btn btn--sm grow" onClick={onEdit}>
            <IconShield /> Edit policy
          </button>
        ) : null}
        {onFollowUp ? (
          <button className="btn btn--sm btn--ghost grow" onClick={onFollowUp}>
            <IconCalendar /> Renewal follow-up
          </button>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

/** The compact row used in lists — the home screen, the renewals screen. */
export function PolicyRow({
  policy,
  title,
  subtitle,
  to,
}: {
  policy: InsurancePolicy;
  title: string;
  subtitle?: string;
  to: string;
}) {
  const state = policyState(policy);
  return (
    <Link className="tile" to={to}>
      <div className="row row--between">
        <span className="tail strong truncate">{title}</span>
        <Chip tone={state.tone}>{state.countdown || state.status}</Chip>
      </div>
      <div className="small muted truncate">{[policyLabel(policy), subtitle].filter(Boolean).join(' · ')}</div>
    </Link>
  );
}

export function PolicySheet({
  existing,
  links,
  onClose,
  onSaved,
}: {
  existing?: InsurancePolicy;
  links: { aircraftId?: string | null; contactId?: string | null; opportunityId?: string | null };
  onClose: () => void;
  onSaved?: (policy: InsurancePolicy) => void;
}) {
  const toast = useToast();
  const [carrier, setCarrier] = useState(existing?.carrier ?? '');
  const [policyNumber, setPolicyNumber] = useState(existing?.policyNumber ?? '');
  const [brokerAgent, setBrokerAgent] = useState(existing?.brokerAgent ?? '');
  const [effectiveDate, setEffectiveDate] = useState(existing?.effectiveDate ?? '');
  const [expirationDate, setExpirationDate] = useState(existing?.expirationDate ?? '');
  const [premium, setPremium] = useState(existing?.premium ?? '');
  const [hullValue, setHullValue] = useState(existing?.hullValue ?? '');
  const [liabilityLimit, setLiabilityLimit] = useState(existing?.liabilityLimit ?? '');
  const [deductible, setDeductible] = useState(existing?.deductible ?? '');
  const [status, setStatus] = useState<RenewalStatus>(existing?.status ?? 'Unknown');
  const [lastQuoteDate, setLastQuoteDate] = useState(existing?.lastQuoteDate ?? '');
  const [quotedPremium, setQuotedPremium] = useState(existing?.quotedPremium ?? '');
  const [renewalNotes, setRenewalNotes] = useState(existing?.renewalNotes ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const datesOutOfOrder =
    effectiveDate !== '' && expirationDate !== '' && expirationDate < effectiveDate;

  const preview: InsurancePolicy = {
    ...(existing ?? {
      id: 'preview',
      aircraftId: null,
      contactId: null,
      opportunityId: null,
      createdAt: '',
      updatedAt: '',
    }),
    carrier,
    policyNumber,
    brokerAgent,
    effectiveDate: effectiveDate || undefined,
    expirationDate: expirationDate || undefined,
    premium,
    hullValue,
    liabilityLimit,
    deductible,
    status,
    lastQuoteDate: lastQuoteDate || undefined,
    quotedPremium,
    renewalNotes,
    notes,
  };
  const previewState = policyState(preview);

  const save = () => {
    if (datesOutOfOrder) return;
    const patch = {
      carrier: carrier.trim(),
      policyNumber: policyNumber.trim(),
      brokerAgent: brokerAgent.trim(),
      effectiveDate: effectiveDate || undefined,
      expirationDate: expirationDate || undefined,
      premium: premium.trim(),
      hullValue: hullValue.trim(),
      liabilityLimit: liabilityLimit.trim(),
      deductible: deductible.trim(),
      status,
      lastQuoteDate: lastQuoteDate || undefined,
      quotedPremium: quotedPremium.trim(),
      renewalNotes: renewalNotes.trim(),
      notes: notes.trim(),
    };
    if (existing) {
      updatePolicy(existing.id, patch);
      toast('Policy updated');
      onSaved?.({ ...existing, ...patch });
    } else {
      const created = createPolicy({ ...patch, ...links });
      toast('Policy added');
      onSaved?.(created);
    }
    onClose();
  };

  return (
    <Sheet
      title={existing ? 'Edit insurance policy' : 'Add insurance policy'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={datesOutOfOrder}>Save</button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          Every field is optional. Fill in what you know — the renewal countdown needs only the
          expiration date.
        </p>

        {expirationDate && !datesOutOfOrder ? (
          <div className="card card--tight row row--between">
            <span className="small muted">Will show as</span>
            <Chip tone={previewState.tone}>{previewState.countdown}</Chip>
          </div>
        ) : null}

        <TextField label="Carrier" value={carrier} onChange={setCarrier} placeholder="Global Aerospace, Old Republic…" />
        <TextField label="Policy number" value={policyNumber} onChange={setPolicyNumber} />
        <div className="form-grid">
          <TextField label="Effective date" value={effectiveDate} onChange={setEffectiveDate} type="date" />
          <TextField
            label="Expiration date"
            value={expirationDate}
            onChange={setExpirationDate}
            type="date"
            error={datesOutOfOrder ? 'The policy cannot expire before it takes effect.' : undefined}
          />
        </div>
        <SelectField
          label="Renewal status"
          value={status}
          options={RENEWAL_STATUSES}
          onChange={setStatus}
          hint="Leave on Unknown and the expiration date decides."
        />

        <div className="divider" />
        <div className="section-title">Coverage</div>
        <div className="form-grid">
          <TextField label="Hull value" value={hullValue} onChange={setHullValue} placeholder="$1,250,000" />
          <TextField label="Liability limit" value={liabilityLimit} onChange={setLiabilityLimit} placeholder="$5M smooth" />
        </div>
        <div className="form-grid">
          <TextField label="Premium" value={premium} onChange={setPremium} />
          <TextField label="Deductible" value={deductible} onChange={setDeductible} />
        </div>

        <div className="divider" />
        <div className="section-title">Quoting</div>
        <div className="form-grid">
          <TextField label="Last quote date" value={lastQuoteDate} onChange={setLastQuoteDate} type="date" />
          <TextField label="Quoted premium" value={quotedPremium} onChange={setQuotedPremium} />
        </div>
        <TextField label="Broker / agent of record" value={brokerAgent} onChange={setBrokerAgent} />
        <TextArea label="Renewal notes" value={renewalNotes} onChange={setRenewalNotes} rows={3} />
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={3} />

        {existing ? (
          <>
            <div className="divider" />
            <ConfirmButton
              label="Delete this policy"
              confirmLabel="Tap again to delete permanently"
              className="btn btn--danger btn--block"
              onConfirm={() => {
                deletePolicy(existing.id);
                toast('Policy deleted');
                onClose();
              }}
            />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * The insurance block a detail screen shows. It is deliberately loud about
 * having nothing: "no insurance on record" is itself a useful answer to
 * "what is their insurance situation?".
 */
export function InsuranceSection({
  policies,
  links,
  emptyBody,
  onFollowUp,
}: {
  policies: InsurancePolicy[];
  links: { aircraftId?: string | null; contactId?: string | null; opportunityId?: string | null };
  emptyBody: string;
  onFollowUp?: (policy: InsurancePolicy) => void;
}) {
  const [sheet, setSheet] = useState<'new' | InsurancePolicy | null>(null);

  return (
    <section className="stack stack--sm">
      <div className="row row--between">
        <h2 className="section-title">Insurance</h2>
        <button className="btn btn--sm btn--ghost" onClick={() => setSheet('new')}>
          <IconPlus /> Add
        </button>
      </div>

      {policies.length === 0 ? (
        <div className="card small muted">{emptyBody}</div>
      ) : (
        <div className="stack stack--sm">
          {policies.map((p) => (
            <PolicyCard
              key={p.id}
              policy={p}
              onEdit={() => setSheet(p)}
              onFollowUp={onFollowUp ? () => onFollowUp(p) : undefined}
            />
          ))}
        </div>
      )}

      {sheet ? (
        <PolicySheet
          existing={sheet === 'new' ? undefined : sheet}
          links={links}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </section>
  );
}

export { IconTrash };
