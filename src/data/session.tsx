/**
 * Who is using AEROBOOK on this device, and getting their data open.
 *
 * Opening the app asks the server who is signed in. Without a connection, the
 * last person to use this device gets their cached copy, marked offline; the
 * server is asked again once the connection is back.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as auth from './auth';
import { CloudSync, forgetCache, SessionExpired, type CloudUser } from './cloud';
import * as store from './store';

export type SessionStatus = 'checking' | 'setup' | 'signed-out' | 'ready' | 'unreachable';

interface SessionValue {
  status: SessionStatus;
  user: CloudUser | null;
  /** Everyone on the account, for saying who a follow-up is for. */
  team: auth.Person[];
  reloadTeam(): void;
  cloud: CloudSync | null;
  /** Why the person is looking at the sign-in screen, when it is not obvious. */
  message: string;
  /** 'code' when the password was right and the authenticator code is wanted next. */
  signIn(email: string, password: string): Promise<'signed-in' | 'code'>;
  finishSignIn(code: string, kind: 'app' | 'backup'): Promise<void>;
  signOut(): Promise<void>;
  retry(): void;
}

const SessionContext = createContext<SessionValue | null>(null);

const LAST_USER = 'aerobook:lastUser';

function rememberUser(user: CloudUser | null): void {
  try {
    if (user) localStorage.setItem(LAST_USER, JSON.stringify(user));
    else localStorage.removeItem(LAST_USER);
  } catch {
    /* private mode: the offline copy just will not open */
  }
}

function lastUser(): CloudUser | null {
  try {
    const raw = localStorage.getItem(LAST_USER);
    return raw ? (JSON.parse(raw) as CloudUser) : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('checking');
  const [user, setUser] = useState<CloudUser | null>(null);
  const [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [team, setTeam] = useState<auth.Person[]>([]);
  const cloudRef = useRef<CloudSync | null>(null);

  // Offline, the list stays as it was: names are a convenience, not the data.
  const reloadTeam = useCallback(() => {
    auth.listPeople().then(setTeam, () => undefined);
  }, []);
  useEffect(() => {
    if (status === 'ready') reloadTeam();
  }, [status, reloadTeam]);

  const close = useCallback(async () => {
    cloudRef.current?.stop();
    cloudRef.current = null;
    await store.unload();
  }, []);

  const open = useCallback(async (next: CloudUser) => {
    await close();
    const cloud = new CloudSync(next);
    cloud.onSessionExpired = () => {
      void close().then(() => {
        rememberUser(null);
        setUser(null);
        setMessage('Your sign-in expired. Sign in again to carry on.');
        setStatus('signed-out');
      });
    };
    await cloud.start();
    cloudRef.current = cloud;
    rememberUser(next);
    setUser(next);
    setStatus('ready');
  }, [close]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await auth.currentUser();
        if (cancelled) return;
        if (current) await open(current);
        else setStatus((await auth.needsSetup()) ? 'setup' : 'signed-out');
      } catch (error) {
        if (cancelled) return;
        if (error instanceof SessionExpired) {
          setStatus('signed-out');
          return;
        }
        // No connection: open what this device last had, if anything.
        const previous = lastUser();
        if (previous) {
          try {
            await open(previous);
            return;
          } catch {
            /* nothing cached either */
          }
        }
        setStatus('unreachable');
      }
    })();
    return () => { cancelled = true; };
  }, [open, attempt]);

  useEffect(() => () => cloudRef.current?.stop(), []);

  const value: SessionValue = {
    status,
    user,
    team,
    reloadTeam,
    cloud: cloudRef.current,
    message,
    async signIn(email, password) {
      const result = await auth.signIn(email, password);
      if ('needsCode' in result) return 'code';
      setMessage('');
      await open(result.user);
      return 'signed-in';
    },
    async finishSignIn(code, kind) {
      const signedIn = await auth.finishSignIn(code, kind);
      setMessage('');
      await open(signedIn);
    },
    async signOut() {
      // Whatever is still on its way up goes before the door closes.
      await store.flush().catch(() => undefined);
      await auth.signOut().catch(() => undefined);
      const leaving = user;
      await close();
      rememberUser(null);
      if (leaving) await forgetCache(leaving.id);
      setUser(null);
      setMessage('');
      setStatus('signed-out');
    },
    retry() {
      setStatus('checking');
      setAttempt((n) => n + 1);
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession outside SessionProvider');
  return value;
}

/**
 * The team, and a way to name the person a follow-up is for. The signed-in
 * person is always in the list, even before it has loaded.
 */
export function useTeam(): { people: auth.Person[]; nameOf(id: string | null | undefined): string } {
  const { team, user } = useSession();
  const people = user && !team.some((p) => p.id === user.id)
    ? [{ id: user.id, name: user.name, active: true }, ...team]
    : team;
  return {
    people,
    nameOf(id) {
      if (!id) return 'Unassigned';
      if (id === user?.id) return 'You';
      return people.find((p) => p.id === id)?.name ?? 'Someone else';
    },
  };
}

/** The signed-in person. Only for screens behind the sign-in. */
export function useCurrentUser(): CloudUser {
  const { user } = useSession();
  if (!user) throw new Error('useCurrentUser with nobody signed in');
  return user;
}
