/**
 * Accounts: your own, and — for an admin — everyone else's. Removing someone
 * turns their access off rather than deleting them, so their name stays on
 * everything they recorded and access can be given back.
 */
import { useCallback, useEffect, useState } from 'react';

import { IconPlus } from './Icons';
import { Banner, Chip, SelectField, Sheet, TextField, useToast } from './ui';
import * as auth from '../data/auth';
import type { TeamMember } from '../data/auth';
import { useCurrentUser, useSession } from '../data/session';

const ROLE_OPTIONS = [
  { value: 'user', label: 'User — works with all the data' },
  { value: 'admin', label: 'Admin — also manages accounts' },
];

export function AccountSection() {
  const user = useCurrentUser();
  const session = useSession();
  const [changing, setChanging] = useState(false);

  return (
    <section className="stack stack--sm">
      <h2 className="section-title">Account</h2>
      <div className="card stack stack--sm">
        <div className="row row--between">
          <div>
            <div className="strong">{user.name}</div>
            <div className="small muted">{user.email}</div>
          </div>
          <Chip tone={user.role === 'admin' ? 'accent' : undefined}>{user.role === 'admin' ? 'Admin' : 'User'}</Chip>
        </div>
      </div>
      <div className="btn-group">
        <button className="btn" onClick={() => setChanging(true)}>Change password</button>
        <button className="btn" onClick={() => void session.signOut()}>Sign out</button>
      </div>
      {changing ? <ChangePasswordSheet onClose={() => setChanging(false)} /> : null}
    </section>
  );
}

function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (next.length < 10) return setError('Use at least 10 characters.');
    setBusy(true);
    setError('');
    try {
      await auth.changePassword(current, next);
      toast('Password changed. Other devices will ask you to sign in again.');
      onClose();
    } catch (e) {
      setError(/invalid|incorrect/i.test((e as Error).message) ? 'The current password is not right.' : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Change password"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !current || !next} onClick={() => void save()}>Change</button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Current password" value={current} onChange={setCurrent} type="password" autoComplete="current-password" />
        <TextField label="New password" value={next} onChange={setNext} type="password" autoComplete="new-password" hint="At least 10 characters." />
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
  );
}

/** Admins only — the caller decides whether to show it. */
export function TeamSection() {
  const me = useCurrentUser();
  const { reloadTeam } = useSession();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);

  const load = useCallback(() => {
    auth.listTeam().then(setMembers, (e: Error) => setError(e.message));
    // Keep the follow-up "for" picker in step with who is on the team.
    reloadTeam();
  }, [reloadTeam]);
  useEffect(load, [load]);

  return (
    <section className="stack stack--sm">
      <div className="row row--between">
        <h2 className="section-title">Team</h2>
        <button className="btn btn--ghost" onClick={() => setAdding(true)}><IconPlus /> Add person</button>
      </div>
      <p className="small muted">Everyone here sees and edits the same aircraft, contacts and follow-ups.</p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <div className="card">
        {members === null ? <div className="small muted">Loading…</div> : members.map((m) => (
          <button key={m.id} className="team-row" onClick={() => setEditing(m)} aria-label={`Manage ${m.name}`}>
            <span className="grow">
              <span className="strong">{m.name}{m.id === me.id ? ' (you)' : ''}</span>
              <span className="small muted" style={{ display: 'block' }}>{m.email}</span>
            </span>
            {m.banned ? <Chip tone="danger">No access</Chip> : null}
            <Chip tone={m.role === 'admin' ? 'accent' : undefined}>{m.role === 'admin' ? 'Admin' : 'User'}</Chip>
          </button>
        ))}
      </div>
      {adding ? <AddMemberSheet onClose={() => setAdding(false)} onAdded={load} /> : null}
      {editing ? (
        <MemberSheet member={editing} isMe={editing.id === me.id} onClose={() => setEditing(null)} onChanged={load} />
      ) : null}
    </section>
  );
}

function AddMemberSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (password.length < 10) return setError('Use at least 10 characters for the password.');
    setBusy(true);
    setError('');
    try {
      await auth.addMember({ name: name.trim(), email, password, role });
      toast(`${name.trim()} can now sign in`);
      onAdded();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Add a person"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !name.trim() || !email || !password} onClick={() => void save()}>
            Add
          </button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
        <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="off" />
        <TextField
          label="First password"
          value={password}
          onChange={setPassword}
          type="text"
          autoComplete="off"
          hint="Give it to them yourself; they can change it under Settings."
        />
        <SelectField label="Role" value={role} options={ROLE_OPTIONS} onChange={(v) => setRole(v as 'admin' | 'user')} />
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
  );
}

function MemberSheet({
  member, isMe, onClose, onChanged,
}: {
  member: TeamMember;
  isMe: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (job: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    try {
      await job();
      toast(done);
      onChanged();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet title={member.name} onClose={onClose}>
      <div className="stack">
        <div className="small muted">{member.email}</div>
        {isMe ? (
          <Banner tone="info">This is you. Another admin can change your role or access, so nobody locks themselves out.</Banner>
        ) : (
          <>
            <SelectField
              label="Role"
              value={member.role}
              options={ROLE_OPTIONS}
              onChange={(v) => void run(() => auth.setRole(member.id, v as 'admin' | 'user'), `${member.name} is now ${v === 'admin' ? 'an admin' : 'a user'}`)}
            />
            <TextField
              label="Set a new password"
              value={password}
              onChange={setPassword}
              type="text"
              autoComplete="off"
              hint="Signs them out everywhere. At least 10 characters."
            />
            <button
              className="btn btn--block"
              disabled={busy || password.length < 10}
              onClick={() => void run(() => auth.setPassword(member.id, password), 'Password set')}
            >
              Set password
            </button>
            {member.banned ? (
              <button className="btn btn--block" disabled={busy} onClick={() => void run(() => auth.setAccess(member.id, true), `${member.name} can sign in again`)}>
                Give access back
              </button>
            ) : (
              <button className="btn btn--danger btn--block" disabled={busy} onClick={() => void run(() => auth.setAccess(member.id, false), `${member.name} can no longer sign in`)}>
                Turn off access
              </button>
            )}
            <p className="xsmall muted">
              Turning off access signs them out and stops them signing in. What they recorded stays, with their name on it.
            </p>
          </>
        )}
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
  );
}
