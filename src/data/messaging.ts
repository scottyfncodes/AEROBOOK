/**
 * Chat, aircraft comments, the inbox and push, as plain calls to the API.
 * Kept thin like auth.ts: the server decides who may see what; this asks.
 *
 * None of it goes through the store or the device cache. Conversations are
 * not shared records — they belong to their members — so they are fetched
 * when needed and never kept on a device someone else might sign in to.
 */

export interface Member {
  id: string;
  name: string;
  active: boolean;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  name: string | null;
  createdBy: string;
  members: Member[];
  lastMessage: { id: number; senderId: string; senderName: string; preview: string; createdAt: string } | null;
  unread: number;
  lastReadMessageId: number;
}

export interface Message {
  id: number;
  conversationId: string;
  senderId: string;
  senderName: string;
  body: string;
  clientId: string;
  createdAt: string;
}

export interface Comment {
  id: number;
  aircraftId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface CommentThread {
  comments: Comment[];
  lastReadCommentId: number;
  watching: boolean;
}

export interface InboxEvent {
  id: number;
  kind: 'message' | 'comment';
  thread: string;
  url: string;
  text: string;
  actorId: string | null;
  createdAt: string;
}

export interface Inbox {
  conversations: { id: string; latestMessageId: number; unread: number }[];
  chatUnread: number;
  aircraftUnread: Record<string, number>;
  events: InboxEvent[];
  cursor: number;
}

/** A reply the server refused, with its status, so a screen can tell "gone" from "offline". */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, 'Could not reach AEROBOOK. Check the connection and try again.');
  }
  const data = (await response.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!response.ok) throw new ApiError(response.status, data?.error ?? `The server said ${response.status}.`);
  return data as T;
}

const conv = (id: string) => `/api/chat/conversations/${encodeURIComponent(id)}`;
const plane = (id: string) => `/api/aircraft/${encodeURIComponent(id)}`;

/** An id for a message before the server has seen it, so a retried send lands once. */
export function clientId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

// ------------------------------------------------------------------- chat

export async function listConversations(): Promise<Conversation[]> {
  return (await call<{ conversations: Conversation[] }>('/api/chat/conversations')).conversations;
}

export function getConversation(id: string): Promise<Conversation> {
  return call(conv(id));
}

export function startDirect(userId: string): Promise<Conversation> {
  return call('/api/chat/conversations', { kind: 'direct', userId });
}

export function startGroup(name: string, memberIds: string[]): Promise<Conversation> {
  return call('/api/chat/conversations', { kind: 'group', name, memberIds });
}

export function listMessages(id: string, cursor: { before?: number; after?: number } = {}): Promise<{ messages: Message[]; more: boolean }> {
  const q = new URLSearchParams();
  if (cursor.before) q.set('before', String(cursor.before));
  if (cursor.after !== undefined) q.set('after', String(cursor.after));
  const query = q.toString();
  return call(`${conv(id)}/messages${query ? `?${query}` : ''}`);
}

export async function sendMessage(id: string, body: string, client: string): Promise<Message> {
  return (await call<{ message: Message }>(`${conv(id)}/messages`, { body, clientId: client })).message;
}

export function markRead(id: string, messageId: number): Promise<{ lastReadMessageId: number }> {
  return call(`${conv(id)}/read`, { messageId });
}

export function renameGroup(id: string, name: string): Promise<Conversation> {
  return call(`${conv(id)}/rename`, { name });
}

export function addMembers(id: string, userIds: string[]): Promise<Conversation> {
  return call(`${conv(id)}/members`, { userIds });
}

export function leaveGroup(id: string): Promise<{ ok: true }> {
  return call(`${conv(id)}/leave`, {});
}

export function removeMember(id: string, userId: string): Promise<{ ok: true }> {
  return call(`${conv(id)}/remove`, { userId });
}

// --------------------------------------------------------------- comments

export function listComments(aircraftId: string): Promise<CommentThread> {
  return call(`${plane(aircraftId)}/comments`);
}

export async function addComment(aircraftId: string, body: string, client: string): Promise<Comment> {
  return (await call<{ comment: Comment }>(`${plane(aircraftId)}/comments`, { body, clientId: client })).comment;
}

export async function editComment(aircraftId: string, commentId: number, body: string): Promise<Comment> {
  return (await call<{ comment: Comment }>(`${plane(aircraftId)}/comments/${commentId}/edit`, { body })).comment;
}

export async function deleteComment(aircraftId: string, commentId: number): Promise<Comment> {
  return (await call<{ comment: Comment }>(`${plane(aircraftId)}/comments/${commentId}/delete`, {})).comment;
}

export function markCommentsRead(aircraftId: string, commentId: number): Promise<{ lastReadCommentId: number }> {
  return call(`${plane(aircraftId)}/comments/read`, { commentId });
}

export function setWatching(aircraftId: string, watching: boolean): Promise<{ watching: boolean }> {
  return call(`${plane(aircraftId)}/watch`, { watching });
}

// ------------------------------------------------------------ inbox, push

export function fetchInbox(input: { deviceId: string; view: string | null; since: number | null }): Promise<Inbox> {
  return call('/api/inbox', input);
}

/** Said as the app goes into the background; keepalive lets it finish as the page is put away. */
export function leavePresence(deviceId: string): Promise<void> {
  return call('/api/presence', { deviceId, view: null }, { keepalive: true }).then(() => undefined, () => undefined);
}

export function pushConfig(): Promise<{ enabled: boolean; publicKey: string | null }> {
  return call('/api/push/config');
}

export function savePushSubscription(subscription: PushSubscriptionJSON): Promise<{ ok: true }> {
  return call('/api/push/subscribe', { subscription });
}

export function removePushSubscription(endpoint: string): Promise<{ removed: boolean }> {
  return call('/api/push/unsubscribe', { endpoint });
}

export function pushStatus(endpoint: string | null): Promise<{ devices: number; thisDevice: boolean }> {
  return call('/api/push/status', { endpoint });
}

export function sendTestPush(): Promise<{ sent: number; devices: number; enabled: boolean }> {
  return call('/api/push/test', {});
}
