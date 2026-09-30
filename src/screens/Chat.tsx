/**
 * Chat: everyone's conversations with the rest of the team, newest first.
 * General talk lives here; talk about one aircraft belongs in that
 * aircraft's comments, where it stays with the record.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppBar } from '../components/AppBar';
import { IconChat, IconPlus, IconUsers } from '../components/Icons';
import { Banner, EmptyState, Sheet, TextField, useToast } from '../components/ui';
import { useCurrentUser, useTeam } from '../data/session';
import { useInbox } from '../data/inbox';
import * as api from '../data/messaging';
import { chatTime } from '../lib/inbox';

export default function Chat() {
  const me = useCurrentUser();
  const { latest, chatUnread } = useInbox();
  const [conversations, setConversations] = useState<api.Conversation[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setConversations(await api.listConversations());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Again whenever the inbox sees something new arrive.
  const signal = useMemo(() => `${chatUnread}:${Object.entries(latest).sort().join(',')}`, [latest, chatUnread]);
  useEffect(() => {
    void load();
  }, [load, signal]);

  return (
    <>
      <AppBar
        title="Chat"
        actions={
          <button className="btn btn--ghost btn--icon" onClick={() => setCreating(true)} aria-label="New conversation">
            <IconPlus />
          </button>
        }
      />
      <main className="page stack">
        {error ? (
          <Banner tone="danger">
            Conversations could not be loaded. {error}{' '}
            <button className="btn btn--sm btn--ghost" onClick={() => void load()}>Try again</button>
          </Banner>
        ) : null}

        {conversations === null && !error ? <div className="muted small">Loading conversations…</div> : null}

        {conversations?.length === 0 ? (
          <EmptyState
            icon={<IconChat />}
            title="No conversations yet"
            body="Message someone on the team, or start a group. Notes about one aircraft go in its comments."
            action={
              <button className="btn btn--primary" onClick={() => setCreating(true)}>
                <IconPlus /> New conversation
              </button>
            }
          />
        ) : null}

        {conversations?.length ? (
          <div className="list">
            {conversations.map((c) => {
              const last = c.lastMessage;
              const who = last ? (last.senderId === me.id ? 'You' : c.kind === 'group' ? last.senderName : '') : '';
              return (
                <Link key={c.id} className={`tile convo${c.unread ? ' convo--unread' : ''}`} to={`/chat/${encodeURIComponent(c.id)}`}>
                  <span className="convo__avatar" aria-hidden>
                    {c.kind === 'group' ? <IconUsers /> : initials(c.title)}
                  </span>
                  <span className="grow stack" style={{ gap: 2 }}>
                    <span className="row row--between">
                      <span className="strong truncate">{c.title}</span>
                      <span className="xsmall muted nowrap">{last ? chatTime(last.createdAt) : ''}</span>
                    </span>
                    <span className="row row--between">
                      <span className="small secondary truncate">
                        {last ? `${who ? `${who}: ` : ''}${last.preview}` : c.kind === 'group' ? `${c.members.length} people` : 'No messages yet'}
                      </span>
                      {c.unread ? <span className="count-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span> : null}
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        ) : null}
      </main>

      {creating ? <NewConversationSheet onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** People who can be added to a conversation: on the team, access on, not yourself. */
export function usePeople(exclude: string[] = []) {
  const me = useCurrentUser();
  const { people } = useTeam();
  return people.filter((p) => p.active && p.id !== me.id && !exclude.includes(p.id));
}

function NewConversationSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const people = usePeople();
  const [mode, setMode] = useState<'person' | 'group'>('person');
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const open = async (make: () => Promise<api.Conversation>) => {
    setBusy(true);
    try {
      const conversation = await make();
      onClose();
      navigate(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={mode === 'person' ? 'New conversation' : 'New group'}
      onClose={onClose}
      footer={mode === 'group' ? (
        <button
          className="btn btn--primary"
          disabled={busy || !name.trim() || chosen.length === 0}
          onClick={() => void open(() => api.startGroup(name, chosen))}
        >
          Create group
        </button>
      ) : undefined}
    >
      <div className="stack">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={mode === 'person'} className={mode === 'person' ? 'is-active' : ''} onClick={() => setMode('person')}>
            One person
          </button>
          <button role="tab" aria-selected={mode === 'group'} className={mode === 'group' ? 'is-active' : ''} onClick={() => setMode('group')}>
            Group
          </button>
        </div>

        {people.length === 0 ? (
          <p className="muted small">Nobody else on the team has access yet. An admin adds people under Settings → Team.</p>
        ) : mode === 'person' ? (
          <div className="list list--flush">
            {people.map((p) => (
              <button key={p.id} className="tile row" disabled={busy} onClick={() => void open(() => api.startDirect(p.id))}>
                <span className="convo__avatar" aria-hidden>{initials(p.name)}</span>
                <span className="grow strong truncate">{p.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <TextField label="Group name" value={name} onChange={setName} placeholder="e.g. Sales team" />
            <div className="section-title">Members</div>
            <PeoplePicker people={people} chosen={chosen} onChange={setChosen} />
          </>
        )}
      </div>
    </Sheet>
  );
}

export function PeoplePicker({ people, chosen, onChange }: {
  people: { id: string; name: string }[];
  chosen: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="list list--flush">
      {people.map((p) => (
        <label key={p.id} className="checkbox-row picker-row">
          <input
            className="checkbox"
            type="checkbox"
            checked={chosen.includes(p.id)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, p.id] : chosen.filter((id) => id !== p.id))}
          />
          <span className="grow">{p.name}</span>
        </label>
      ))}
    </div>
  );
}
