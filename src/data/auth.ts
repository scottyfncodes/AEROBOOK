/**
 * Sign-in and account management, as plain calls to /api/auth. Kept thin on
 * purpose: the server decides who may do what; this only asks.
 */
import type { CloudUser } from './cloud';
import type { HistoryEntry } from '../lib/history';

export interface TeamMember extends CloudUser {
  banned: boolean;
  createdAt: string;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach AEROBOOK. Check the connection and try again.');
  }
  const data = (await response.json().catch(() => null)) as ({ message?: string; error?: string } & T) | null;
  if (!response.ok) {
    if (response.status === 429) throw new Error('Too many attempts. Wait a minute and try again.');
    throw new Error(data?.message ?? data?.error ?? `The server said ${response.status}.`);
  }
  return data as T;
}

function toUser(u: { id: string; name: string; email: string; role?: string | null }): CloudUser {
  return { id: u.id, name: u.name, email: u.email, role: u.role === 'admin' ? 'admin' : 'user' };
}

/** Who is signed in on this device, or null. Throws only when the server cannot be reached. */
export async function currentUser(): Promise<CloudUser | null> {
  const session = await call<{ user?: { id: string; name: string; email: string; role?: string } } | null>(
    '/api/auth/get-session',
  );
  return session?.user ? toUser(session.user) : null;
}

export async function signIn(email: string, password: string): Promise<CloudUser> {
  const { user } = await call<{ user: { id: string; name: string; email: string; role?: string } }>(
    '/api/auth/sign-in/email',
    { email: email.trim().toLowerCase(), password },
  );
  // The sign-in reply may not carry the role; the session always does.
  return (await currentUser()) ?? toUser(user);
}

export async function signOut(): Promise<void> {
  await call('/api/auth/sign-out', {});
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await call('/api/auth/change-password', { currentPassword, newPassword, revokeOtherSessions: true });
}

export async function needsSetup(): Promise<boolean> {
  return (await call<{ needsSetup: boolean }>('/api/setup')).needsSetup;
}

export async function setUp(input: { token: string; name: string; email: string; password: string }): Promise<void> {
  await call('/api/setup', input);
}

/** Someone on the account, as anyone on it may see them. */
export interface Person {
  id: string;
  name: string;
  /** False when an admin has turned their access off. */
  active: boolean;
}

export async function listPeople(): Promise<Person[]> {
  return (await call<{ people: Person[] }>('/api/team')).people;
}

/** A page of the activity history, newest first; `before` continues an earlier page. */
export async function fetchHistory(before?: number): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  return call(`/api/history${before ? `?before=${before}` : ''}`);
}

/** Sends today's digest to the signed-in person's own address, now. */
export async function sendDigestNow(): Promise<string> {
  return (await call<{ sentTo: string }>('/api/digest/send', {})).sentTo;
}

// ------------------------------------------------------------ admin only

export async function listTeam(): Promise<TeamMember[]> {
  const { users } = await call<{
    users: { id: string; name: string; email: string; role?: string; banned?: boolean | null; createdAt: string }[];
  }>('/api/auth/admin/list-users?limit=100&sortBy=createdAt');
  return users.map((u) => ({ ...toUser(u), banned: Boolean(u.banned), createdAt: u.createdAt }));
}

export async function addMember(input: { name: string; email: string; password: string; role: 'admin' | 'user' }) {
  await call('/api/auth/admin/create-user', { ...input, email: input.email.trim().toLowerCase() });
}

export async function setRole(userId: string, role: 'admin' | 'user') {
  await call('/api/auth/admin/set-role', { userId, role });
}

export async function setPassword(userId: string, newPassword: string) {
  await call('/api/auth/admin/set-user-password', { userId, newPassword });
  // A reset password should also end wherever the old one is still signed in.
  await call('/api/auth/admin/revoke-user-sessions', { userId });
}

/** Turn someone's access off or back on, without deleting what they recorded. */
export async function setAccess(userId: string, allowed: boolean) {
  if (allowed) await call('/api/auth/admin/unban-user', { userId });
  else await call('/api/auth/admin/ban-user', { userId });
}
