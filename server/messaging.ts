/**
 * The routes for chat, aircraft comments, the inbox and push. Every one of
 * them needs a signed-in person whose access is on (handle() checks before
 * calling in); what each may then see is decided in chat.ts and comments.ts
 * from that person alone.
 */
import type { SessionUser } from './auth.js';
import {
  addMembers, createConversation, getConversation, listConversations, listMessages, markRead, removeMember,
  renameGroup, sendMessage,
} from './chat.js';
import {
  addComment, deleteComment, editComment, listComments, markCommentsRead, setWatching,
} from './comments.js';
import { checkWrite, error, json, readJson } from './http.js';
import { inbox } from './inbox.js';
import { recordPresence } from './notify.js';
import { pushConfig, pushToUser, subscribe, subscriptionStatus, unsubscribe } from './push.js';

export function isMessagingPath(pathname: string): boolean {
  return pathname === '/api/inbox' || pathname === '/api/presence'
    || pathname.startsWith('/api/chat/') || pathname.startsWith('/api/push/')
    || pathname.startsWith('/api/aircraft/');
}

function segments(pathname: string, prefix: string): string[] | null {
  if (!pathname.startsWith(prefix)) return null;
  try {
    return pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

export async function messaging(request: Request, user: SessionUser): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const post = async (fn: (body: unknown) => Promise<unknown>): Promise<Response> => {
    if (method !== 'POST') return error(405, 'Method not allowed');
    const refused = checkWrite(request);
    if (refused) return refused;
    return json(await fn(await readJson(request)));
  };

  if (pathname === '/api/inbox') return post((body) => inbox(user, body));

  if (pathname === '/api/presence') {
    return post(async (body) => {
      const { deviceId, view } = (body ?? {}) as { deviceId?: unknown; view?: unknown };
      await recordPresence(user.id, deviceId, view ?? null);
      return { ok: true };
    });
  }

  const push = segments(pathname, '/api/push/');
  if (push) {
    const [action] = push;
    if (action === 'config' && push.length === 1) {
      if (method !== 'GET') return error(405, 'Method not allowed');
      const config = pushConfig();
      // The public key is public by design: the browser needs it to subscribe.
      return json({ enabled: Boolean(config), publicKey: config?.publicKey ?? null });
    }
    if (action === 'subscribe') return post((body) => subscribe(user.id, body, request.headers.get('user-agent')));
    if (action === 'unsubscribe') return post((body) => unsubscribe(user.id, body));
    if (action === 'status') {
      return post((body) => {
        const endpoint = (body as { endpoint?: unknown })?.endpoint;
        return subscriptionStatus(user.id, typeof endpoint === 'string' ? endpoint : null);
      });
    }
    if (action === 'test') {
      return post(async () => {
        if (!pushConfig()) return { sent: 0, devices: 0, enabled: false };
        const result = await pushToUser(
          user.id,
          { title: 'AEROBOOK', body: 'Notifications are on for this device', url: '/settings#notifications', tag: 'test' },
          'test',
        );
        return { ...result, enabled: true };
      });
    }
    return error(404, 'Not found');
  }

  const chat = segments(pathname, '/api/chat/');
  if (chat) {
    const [root, id, action, ...rest] = chat;
    if (root !== 'conversations' || rest.length) return error(404, 'Not found');
    if (!id) {
      if (method === 'GET') return json({ conversations: await listConversations(user) });
      return post((body) => createConversation(user, body));
    }
    if (!action) {
      if (method !== 'GET') return error(405, 'Method not allowed');
      return json(await getConversation(user, id));
    }
    if (action === 'messages') {
      if (method === 'GET') return json(await listMessages(user, id, url.searchParams));
      return post((body) => sendMessage(user, id, body).then(({ message }) => ({ message })));
    }
    if (action === 'read') return post((body) => markRead(user, id, body));
    if (action === 'rename') return post((body) => renameGroup(user, id, body));
    if (action === 'members') return post((body) => addMembers(user, id, body));
    if (action === 'leave') return post(() => removeMember(user, id, { userId: user.id }));
    if (action === 'remove') return post((body) => removeMember(user, id, body));
    return error(404, 'Not found');
  }

  const aircraft = segments(pathname, '/api/aircraft/');
  if (aircraft) {
    const [aircraftId, section, second, third, ...rest] = aircraft;
    if (!aircraftId || rest.length) return error(404, 'Not found');
    if (section === 'watch' && !second) return post((body) => setWatching(user, aircraftId, body));
    if (section !== 'comments') return error(404, 'Not found');
    if (!second) {
      if (method === 'GET') return json(await listComments(user, aircraftId));
      return post((body) => addComment(user, aircraftId, body).then(({ comment }) => ({ comment })));
    }
    if (second === 'read' && !third) return post((body) => markCommentsRead(user, aircraftId, body));
    if (third === 'edit') return post((body) => editComment(user, aircraftId, second, body).then((comment) => ({ comment })));
    if (third === 'delete') return post(() => deleteComment(user, aircraftId, second).then((comment) => ({ comment })));
    return error(404, 'Not found');
  }

  return error(404, 'Not found');
}
