/**
 * Opportunity UI shared by the screens that create and move deals.
 *
 * The stage control is the important piece: moving a deal forward is the most
 * common edit in the app, and on a phone it has to be one tap, not a form.
 */
import { useEffect, useRef, useState } from 'react';

import { IconCheck, IconChevronRight, IconTarget } from './Icons';
import { SelectField, Sheet, TextArea, TextField, useToast } from './ui';
import { createOpportunity, setOpportunityStatus } from '../data/store';
import {
  OPPORTUNITY_STAGES,
  OPPORTUNITY_TYPES,
  type Opportunity,
  type OpportunityStatus,
  type OpportunityType,
} from '../data/types';

/**
 * The pipeline as a row of taps. Won / Lost / Future sit underneath as the
 * ways out, so closing a deal never needs the edit sheet either.
 */
export function StageControl({ opportunity }: { opportunity: Opportunity }) {
  const toast = useToast();
  const current = OPPORTUNITY_STAGES.indexOf(opportunity.status);
  const track = useRef<HTMLDivElement>(null);

  // Five stages do not fit across a phone, so the track scrolls — which is
  // useless if the stage you are on is off-screen when the page opens.
  useEffect(() => {
    const el = track.current?.querySelector('.is-current');
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [opportunity.status]);

  const move = (status: OpportunityStatus) => {
    setOpportunityStatus(opportunity.id, status);
    toast(`Moved to ${status}`);
  };

  return (
    <div className="stack stack--sm">
      <div className="stage-track" role="group" aria-label="Pipeline stage" ref={track}>
        {OPPORTUNITY_STAGES.map((stage, i) => {
          const reached = current >= 0 && i <= current;
          return (
            <button
              key={stage}
              type="button"
              className={`stage${reached ? ' is-reached' : ''}${stage === opportunity.status ? ' is-current' : ''}`}
              aria-current={stage === opportunity.status ? 'step' : undefined}
              onClick={() => move(stage)}
            >
              {stage}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {(['Won', 'Lost', 'Future'] as const).map((status) => (
          <button
            key={status}
            className={`btn btn--sm grow${opportunity.status === status ? ' btn--primary' : ' btn--ghost'}`}
            onClick={() => move(status)}
          >
            {opportunity.status === status ? <IconCheck /> : null}
            {status}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One line on a list row: where the deal is and what happens next. */
export function NextActionLine({ opportunity }: { opportunity: Opportunity }) {
  if (!opportunity.nextAction) return null;
  return (
    <div className="row small secondary" style={{ gap: 4 }}>
      <IconChevronRight style={{ width: 14, height: 14, flex: 'none' }} />
      <span className="truncate">{opportunity.nextAction}</span>
    </div>
  );
}

export function NewOpportunitySheet({
  contactId,
  aircraftId,
  defaultTitle,
  defaultType = 'Insurance',
  onClose,
  onCreated,
}: {
  contactId: string | null;
  aircraftId: string | null;
  defaultTitle?: string;
  defaultType?: OpportunityType;
  onClose: () => void;
  onCreated?: (opportunity: Opportunity) => void;
}) {
  const toast = useToast();
  const [type, setType] = useState<OpportunityType>(defaultType);
  const [status, setStatus] = useState<OpportunityStatus>('Lead');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [estimatedValue, setEstimatedValue] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <Sheet
      title="New opportunity"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => {
              const created = createOpportunity({
                contactId,
                aircraftId,
                type,
                status,
                title: title.trim(),
                estimatedValue: estimatedValue.trim(),
                nextAction: nextAction.trim(),
                notes: notes.trim(),
              });
              toast('Opportunity created');
              onCreated?.(created);
              onClose();
            }}
          >
            <IconTarget /> Create
          </button>
        </>
      }
    >
      <div className="stack">
        <SelectField label="Type" value={type} options={OPPORTUNITY_TYPES} onChange={setType} />
        <SelectField
          label="Stage"
          value={status}
          options={OPPORTUNITY_STAGES}
          onChange={setStatus}
          hint="You can move it along with one tap afterwards."
        />
        <TextField label="Title" value={title} onChange={setTitle} placeholder="N917JH — hull and liability" />
        <TextField label="Estimated value" value={estimatedValue} onChange={setEstimatedValue} placeholder="$18,000 premium" />
        <TextField
          label="Next action"
          value={nextAction}
          onChange={setNextAction}
          placeholder="Send the renewal comparison"
          hint="The one thing that has to happen next."
        />
        <TextArea label="Notes" value={notes} onChange={setNotes} rows={4} />
      </div>
    </Sheet>
  );
}
