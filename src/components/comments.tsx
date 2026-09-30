/**
 * The discussion on one aircraft: who said what about this tail, in order,
 * kept on the aircraft's page rather than in chat.
 *
 * Comments since the person last looked are marked new, and count as read
 * once the section has actually been on screen. Watching an aircraft means
 * hearing about new comments on it; writing one starts watching.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Composer } from './Composer';
import { IconBell, IconChat } from './Icons';
import { Banner, Chip, ConfirmButton, useToast } from './ui';
import { useCurrentUser, useSession } from '../data/session';
import { useInbox } from '../data/inbox';
import * as api from '../data/messaging';
import { chatTime } from '../lib/inbox';

const REFRESH_MS = 15_000;
/** How soon to look again for an aircraft whose first save has not landed yet. */
const SAVING_MS = 2_000;

type Load =
  | { status: 'loading' }
  | { status: 'saving' }
  | { status: 'missing' }
  | { status: 'error'; message: string }
  | { status: 'ready'; thread: api.CommentThread };

export function AircraftComments({ aircraftId }: { aircraftId: string }) {
  const me = useCurrentUser();
  const { cloud } = useSession();
  const toast = useToast();
  const { refresh, aircraftUnread } = useInbox();
  const location = useLocation();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Where "new" starts for this visit; kept while the page is open so the marks do not vanish as they are read. */
  const [newAfter, setNewAfter] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const section = useRef<HTMLElement>(null);
  const scrolled = useRef(false);

  const fetchThread = useCallback(async () => {
    // Just created here: the server has not heard of it yet, so there is nothing to ask.
    if (cloud && !cloud.isStored('aircraft', aircraftId)) {
      setLoad((current) => (current.status === 'ready' ? current : { status: 'saving' }));
      return;
    }
    try {
      const thread = await api.listComments(aircraftId);
      setLoad({ status: 'ready', thread });
      setNewAfter((n) => n ?? thread.lastReadCommentId);
    } catch (e) {
      const err = e as api.ApiError;
      setLoad((current) => {
        if (err.status === 404) return { status: 'missing' };
        // A failed refresh keeps what is already on screen.
        return current.status === 'ready' ? current : { status: 'error', message: err.message };
      });
    }
  }, [aircraftId, cloud]);

  useEffect(() => {
    setLoad({ status: 'loading' });
    setNewAfter(null);
    scrolled.current = false;
    void fetchThread();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchThread();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [fetchThread]);

  useEffect(() => {
    if (load.status !== 'saving') return;
    const t = setTimeout(() => void fetchThread(), SAVING_MS);
    return () => clearTimeout(t);
  }, [load, fetchThread]);

  // Someone else commented (the inbox saw it): fetch now rather than at the next tick.
  const unreadHere = aircraftUnread[aircraftId] ?? 0;
  useEffect(() => {
    if (unreadHere > 0) void fetchThread();
  }, [unreadHere, fetchThread]);

  // Opened from a notification: straight to the comments.
  useEffect(() => {
    if (load.status !== 'ready' || scrolled.current || location.hash !== '#comments') return;
    scrolled.current = true;
    requestAnimationFrame(() => section.current?.scrollIntoView({ block: 'start' }));
  }, [load.status, location.hash]);

  // Read once the section has been on screen.
  const newest = load.status === 'ready' ? load.thread.comments.at(-1)?.id ?? 0 : 0;
  const readUpTo = load.status === 'ready' ? load.thread.lastReadCommentId : 0;
  useEffect(() => {
    const el = section.current;
    if (!el || newest <= readUpTo) return;
    const markRead = () => {
      api.markCommentsRead(aircraftId, newest).then(() => {
        setLoad((current) => current.status === 'ready'
          ? { status: 'ready', thread: { ...current.thread, lastReadCommentId: Math.max(current.thread.lastReadCommentId, newest) } }
          : current);
        refresh();
      }, () => undefined);
    };
    if (typeof IntersectionObserver === 'undefined') {
      markRead();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && document.visibilityState === 'visible') {
        observer.disconnect();
        markRead();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [aircraftId, newest, readUpTo, refresh]);

  const replace = (comment: api.Comment) => setLoad((current) => current.status === 'ready'
    ? {
      status: 'ready',
      thread: {
        ...current.thread,
        comments: current.thread.comments.some((c) => c.id === comment.id)
          ? current.thread.comments.map((c) => (c.id === comment.id ? comment : c))
          : [...current.thread.comments, comment],
      },
    }
    : current);

  const post = async (text: string): Promise<boolean> => {
    try {
      const comment = await api.addComment(aircraftId, text, api.clientId());
      replace(comment);
      setLoad((current) => current.status === 'ready'
        ? { status: 'ready', thread: { ...current.thread, watching: true, lastReadCommentId: Math.max(current.thread.lastReadCommentId, comment.id) } }
        : current);
      return true;
    } catch (e) {
      toast((e as Error).message, 'error');
      return false;
    }
  };

  const toggleWatch = async (watching: boolean) => {
    try {
      await api.setWatching(aircraftId, watching);
      setLoad((current) => current.status === 'ready' ? { status: 'ready', thread: { ...current.thread, watching } } : current);
      toast(watching ? 'You’ll be notified of new comments here' : 'You won’t be notified of new comments here');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const comments = load.status === 'ready' ? load.thread.comments : [];
  const isNew = (c: api.Comment) => newAfter !== null && c.id > newAfter && c.authorId !== me.id && !c.deleted;
  const newCount = comments.filter(isNew).length;

  return (
    <section className="stack stack--sm comments" id="comments" ref={section} aria-label="Comments">
      <div className="row row--between">
        <h2 className="section-title">
          Comments{comments.length ? ` · ${comments.filter((c) => !c.deleted).length}` : ''}
        </h2>
        <div className="row" style={{ gap: 6 }}>
          {newCount ? <Chip tone="accent">{newCount} new</Chip> : null}
          {load.status === 'ready' ? (
            <button
              className={`btn btn--sm ${load.thread.watching ? 'btn--ghost is-on' : 'btn--ghost'}`}
              onClick={() => void toggleWatch(!load.thread.watching)}
              aria-pressed={load.thread.watching}
            >
              <IconBell /> {load.thread.watching ? 'Watching' : 'Watch'}
            </button>
          ) : null}
        </div>
      </div>

      {load.status === 'loading' ? <div className="card muted small">Loading comments…</div> : null}
      {load.status === 'saving' ? <div className="card muted small">Saving this aircraft… comments open in a moment.</div> : null}
      {load.status === 'missing' ? (
        <div className="card muted small">Comments open once this aircraft has been saved to the cloud.</div>
      ) : null}
      {load.status === 'error' ? (
        <Banner tone="danger">
          Comments could not be loaded. {load.message}{' '}
          <button className="btn btn--sm btn--ghost" onClick={() => void fetchThread()}>Try again</button>
        </Banner>
      ) : null}

      {load.status === 'ready' ? (
        <>
          {comments.length === 0 ? (
            <div className="card comments__empty">
              <IconChat aria-hidden />
              <div className="small muted">No comments yet. Notes for the team about this aircraft go here — the rest of the page stays as it is.</div>
            </div>
          ) : (
            <ol className="list list--flush comments__list">
              {comments.map((c) => (
                <li key={c.id} className={`comment${isNew(c) ? ' comment--new' : ''}`}>
                  <div className="row row--between comment__meta">
                    <span className="small strong truncate">{c.authorId === me.id ? 'You' : c.authorName}</span>
                    <span className="xsmall muted nowrap">
                      {chatTime(c.createdAt)}{c.editedAt && !c.deleted ? ' · edited' : ''}
                    </span>
                  </div>
                  {c.deleted ? (
                    <div className="small muted comment__deleted">Comment deleted</div>
                  ) : editing === c.id ? (
                    <EditComment
                      comment={c}
                      onCancel={() => setEditing(null)}
                      onSave={async (text) => {
                        try {
                          replace(await api.editComment(aircraftId, c.id, text));
                          setEditing(null);
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                      }}
                    />
                  ) : (
                    <>
                      <div className="comment__body">{c.body}</div>
                      {c.authorId === me.id || me.role === 'admin' ? (
                        <div className="row comment__actions">
                          {c.authorId === me.id ? (
                            <button className="btn btn--sm btn--ghost" onClick={() => setEditing(c.id)}>Edit</button>
                          ) : null}
                          <ConfirmButton
                            label="Delete"
                            confirmLabel="Tap again to delete"
                            className="btn btn--sm btn--ghost btn--danger"
                            onConfirm={() => {
                              api.deleteComment(aircraftId, c.id).then(replace, (e: Error) => toast(e.message, 'error'));
                            }}
                          />
                        </div>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
          <Composer label={`Comment on this aircraft`} placeholder="Add a comment for the team" onSend={post} />
        </>
      ) : null}
    </section>
  );
}

function EditComment({ comment, onSave, onCancel }: {
  comment: api.Comment;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  return (
    <div className="stack stack--sm">
      <textarea
        className="textarea"
        aria-label="Edit comment"
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row">
        <button className="btn btn--sm btn--ghost" onClick={onCancel}>Cancel</button>
        <button
          className="btn btn--sm btn--primary"
          disabled={!text.trim() || saving}
          onClick={async () => {
            setSaving(true);
            await onSave(text);
            setSaving(false);
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
