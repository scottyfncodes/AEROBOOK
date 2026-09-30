/**
 * One conversation: the messages, oldest at the top, and the box to reply.
 *
 * It opens at the newest message. New ones arrive while it is open (the
 * inbox notices within a few seconds) and scroll into view if the person is
 * at the bottom already; if they have scrolled up to read, a button offers
 * to take them down instead. What is sent shows at once and says so if it
 * did not go, with the draft kept to try again.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppBar } from '../components/AppBar';
import { Composer } from '../components/Composer';
import { IconUsers } from '../components/Icons';
import { Banner, ConfirmButton, EmptyState, Sheet, TextField, useToast } from '../components/ui';
import { useCurrentUser } from '../data/session';
import { useInbox } from '../data/inbox';
import * as api from '../data/messaging';
import { chatTime } from '../lib/inbox';
import { PeoplePicker, usePeople } from './Chat';

interface Pending {
  clientId: string;
  body: string;
  failed: boolean;
}

function nearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
}

function toBottom(smooth = false): void {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

/** Merge by id, oldest first, never twice. */
function merge(current: api.Message[], incoming: api.Message[]): api.Message[] {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export default function Conversation() {
  const { id = '' } = useParams();
  const me = useCurrentUser();
  const toast = useToast();
  const { latest, refresh } = useInbox();
  const [conversation, setConversation] = useState<api.Conversation | null>(null);
  const [messages, setMessages] = useState<api.Message[]>([]);
  const [more, setMore] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Pending[]>([]);
  const [below, setBelow] = useState(0);
  const [info, setInfo] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stick = useRef(true);
  const olderFrom = useRef<number | null>(null);

  const newestId = messages.at(-1)?.id ?? 0;
  const newestRef = useRef(0);
  newestRef.current = newestId;

  const open = useCallback(async () => {
    setState('loading');
    try {
      const [c, page] = await Promise.all([api.getConversation(id), api.listMessages(id)]);
      setConversation(c);
      setMessages(page.messages);
      setMore(page.more);
      setState('ready');
      stick.current = true;
    } catch (e) {
      const err = e as api.ApiError;
      setState(err.status === 404 ? 'missing' : 'error');
      setError(err.message);
    }
  }, [id]);

  useEffect(() => {
    setMessages([]);
    setPending([]);
    setBelow(0);
    void open();
  }, [open]);

  // Something newer than what is on screen: fetch just that.
  const fetchNewer = useCallback(async () => {
    try {
      const page = await api.listMessages(id, { after: newestRef.current });
      if (!page.messages.length) return;
      stick.current = nearBottom();
      if (!stick.current) setBelow((n) => n + page.messages.filter((m) => m.senderId !== me.id).length);
      setMessages((current) => merge(current, page.messages));
    } catch {
      // The next signal tries again.
    }
  }, [id, me.id]);

  const latestHere = latest[id] ?? 0;
  useEffect(() => {
    if (state === 'ready' && latestHere > newestRef.current) void fetchNewer();
  }, [latestHere, state, fetchNewer]);

  // Keep the newest in view when the person was already there; keep their
  // place when older messages load above.
  useLayoutEffect(() => {
    if (olderFrom.current !== null) {
      window.scrollTo(0, window.scrollY + document.documentElement.scrollHeight - olderFrom.current);
      olderFrom.current = null;
      return;
    }
    if (stick.current) toBottom();
  }, [messages, pending]);

  useEffect(() => {
    const onScroll = () => {
      if (nearBottom()) setBelow(0);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Read what is on screen, while the app is in front.
  const lastRead = useRef(0);
  useEffect(() => {
    if (state !== 'ready' || !newestId || newestId <= lastRead.current) return;
    const mark = () => {
      if (document.visibilityState !== 'visible' || newestId <= lastRead.current) return;
      lastRead.current = newestId;
      api.markRead(id, newestId).then(refresh, () => { lastRead.current = 0; });
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [id, newestId, state, refresh]);

  const loadOlder = async () => {
    const first = messages[0]?.id;
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await api.listMessages(id, { before: first });
      olderFrom.current = document.documentElement.scrollHeight;
      stick.current = false;
      setMessages((current) => merge(current, page.messages));
      setMore(page.more);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setLoadingOlder(false);
    }
  };

  const deliver = async (item: Pending): Promise<boolean> => {
    stick.current = true;
    setPending((p) => [...p.filter((x) => x.clientId !== item.clientId), { ...item, failed: false }]);
    try {
      const message = await api.sendMessage(id, item.body, item.clientId);
      setMessages((current) => merge(current, [message]));
      setPending((p) => p.filter((x) => x.clientId !== item.clientId));
      refresh();
      return true;
    } catch (e) {
      const err = e as api.ApiError;
      if (err.status > 0 && err.status !== 409) {
        // Refused, not lost: say why and keep the words in the box.
        setPending((p) => p.filter((x) => x.clientId !== item.clientId));
        toast(err.message, 'error');
        return false;
      }
      setPending((p) => p.map((x) => (x.clientId === item.clientId ? { ...x, failed: true } : x)));
      if (err.status === 409) toast(err.message, 'error');
      return true;
    }
  };

  if (state === 'missing') {
    return (
      <>
        <AppBar title="Chat" back="/chat" />
        <main className="page">
          <EmptyState
            title="That conversation is not available"
            body="It may not exist, or you are no longer in it."
            action={<Link className="btn" to="/chat">All conversations</Link>}
          />
        </main>
      </>
    );
  }

  const isGroup = conversation?.kind === 'group';
  const other = conversation?.members.find((m) => m.id !== me.id);
  const subtitle = isGroup
    ? `${conversation!.members.length} people`
    : other && !other.active ? 'Access off' : '';

  return (
    <>
      <AppBar
        title={conversation?.title ?? 'Chat'}
        back="/chat"
        showSearch={false}
        actions={isGroup ? (
          <button className="btn btn--ghost btn--icon" onClick={() => setInfo(true)} aria-label="Group details">
            <IconUsers />
          </button>
        ) : null}
      />
      <main className="page chat">
        {subtitle ? <div className="xsmall muted chat__subtitle">{subtitle}</div> : null}
        {state === 'loading' ? <div className="muted small">Loading messages…</div> : null}
        {state === 'error' ? (
          <Banner tone="danger">
            Messages could not be loaded. {error}{' '}
            <button className="btn btn--sm btn--ghost" onClick={() => void open()}>Try again</button>
          </Banner>
        ) : null}

        {state === 'ready' ? (
          <div className="chat__messages">
            {more ? (
              <button className="btn btn--sm btn--ghost chat__older" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Show earlier messages'}
              </button>
            ) : null}
            {messages.length === 0 && pending.length === 0 ? (
              <p className="muted small chat__empty">No messages yet. Say hello.</p>
            ) : null}
            {messages.map((m, i) => {
              const mine = m.senderId === me.id;
              const prev = messages[i - 1];
              const showName = isGroup && !mine && prev?.senderId !== m.senderId;
              const gap = !prev || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 10 * 60_000;
              return (
                <div key={m.id} className={`bubble-row${mine ? ' bubble-row--mine' : ''}`}>
                  {gap ? <div className="chat__time">{chatTime(m.createdAt)}</div> : null}
                  {showName ? <div className="bubble__name">{m.senderName}</div> : null}
                  <div className={`bubble${mine ? ' bubble--mine' : ''}`} title={new Date(m.createdAt).toLocaleString()}>
                    {m.body}
                  </div>
                </div>
              );
            })}
            {pending.map((p) => (
              <div key={p.clientId} className="bubble-row bubble-row--mine">
                <div className={`bubble bubble--mine bubble--pending${p.failed ? ' bubble--failed' : ''}`}>{p.body}</div>
                <div className="bubble__status">
                  {p.failed ? (
                    <>
                      Not sent.{' '}
                      <button className="linkish" onClick={() => void deliver(p)}>Try again</button>
                      {' · '}
                      <button className="linkish" onClick={() => setPending((all) => all.filter((x) => x.clientId !== p.clientId))}>Discard</button>
                    </>
                  ) : 'Sending…'}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {below > 0 ? (
          <button className="chat__jump" onClick={() => { setBelow(0); toBottom(true); }}>
            {below} new {below === 1 ? 'message' : 'messages'} ↓
          </button>
        ) : null}

        {state === 'ready' ? (
          <div className="chat__composer">
            <Composer
              label="Message"
              placeholder="Message"
              enterSends
              autoFocus
              onSend={(text) => deliver({ clientId: api.clientId(), body: text, failed: false })}
            />
          </div>
        ) : null}
      </main>

      {info && conversation ? (
        <GroupSheet
          conversation={conversation}
          onChange={setConversation}
          onClose={() => setInfo(false)}
        />
      ) : null}
    </>
  );
}

function GroupSheet({ conversation, onChange, onClose }: {
  conversation: api.Conversation;
  onChange: (c: api.Conversation) => void;
  onClose: () => void;
}) {
  const me = useCurrentUser();
  const toast = useToast();
  const navigate = useNavigate();
  const addable = usePeople(conversation.members.map((m) => m.id));
  const [name, setName] = useState(conversation.name ?? '');
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const canRemove = conversation.createdBy === me.id || me.role === 'admin';

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Group details" onClose={onClose}>
      <div className="stack stack--lg">
        <div className="stack stack--sm">
          <TextField label="Name" value={name} onChange={setName} />
          <button
            className="btn btn--ghost"
            disabled={busy || !name.trim() || name.trim() === conversation.name}
            onClick={() => void run(async () => {
              onChange(await api.renameGroup(conversation.id, name));
              toast('Group renamed');
            })}
          >
            Rename
          </button>
        </div>

        <div className="stack stack--sm">
          <div className="section-title">Members · {conversation.members.length}</div>
          <div className="list list--flush">
            {conversation.members.map((m) => (
              <div key={m.id} className="row picker-row">
                <span className="grow truncate">
                  {m.id === me.id ? 'You' : m.name}
                  {!m.active ? <span className="muted"> · access off</span> : null}
                  {m.id === conversation.createdBy ? <span className="muted"> · started the group</span> : null}
                </span>
                {canRemove && m.id !== me.id ? (
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Tap again"
                    className="btn btn--sm btn--ghost btn--danger"
                    onConfirm={() => void run(async () => {
                      await api.removeMember(conversation.id, m.id);
                      onChange(await api.getConversation(conversation.id));
                    })}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>

        {addable.length ? (
          <div className="stack stack--sm">
            <div className="section-title">Add people</div>
            <PeoplePicker people={addable} chosen={adding} onChange={setAdding} />
            <button
              className="btn btn--ghost"
              disabled={busy || !adding.length}
              onClick={() => void run(async () => {
                onChange(await api.addMembers(conversation.id, adding));
                setAdding([]);
                toast('Added to the group');
              })}
            >
              Add {adding.length || ''}
            </button>
          </div>
        ) : null}

        <ConfirmButton
          label="Leave this group"
          confirmLabel="Tap again to leave"
          className="btn btn--danger btn--block"
          onConfirm={() => void run(async () => {
            await api.leaveGroup(conversation.id);
            onClose();
            navigate('/chat');
          })}
        />
      </div>
    </Sheet>
  );
}
