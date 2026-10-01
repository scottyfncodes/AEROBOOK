/**
 * Accounts: your own, and — for an admin — everyone else's. Turning someone's
 * access off is the everyday, reversible way to remove them. Deleting them is
 * for good: their account goes, and their name stays on everything they
 * recorded, marked deleted.
 */
import { useCallback, useEffect, useState } from 'react';
import { renderSVG } from 'uqr';

import { IconPlus } from './Icons';
import { Banner, Chip, ConfirmButton, SelectField, Sheet, TextField, useToast } from './ui';
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
      <TwoFactorCard />
    </section>
  );
}

/**
 * Two-step sign-in: for admins, a code from an authenticator app after the
 * password. Shown to admins, and to anyone who still has it on from being one.
 */
function TwoFactorCard() {
  const user = useCurrentUser();
  const [on, setOn] = useState<boolean | null>(null);
  const [sheet, setSheet] = useState<'setup' | 'codes' | 'off' | null>(null);

  const load = useCallback(() => {
    auth.twoFactorOn().then(setOn, () => setOn(null));
  }, []);
  useEffect(load, [load]);

  if (on === null || (!on && user.role !== 'admin')) return null;
  const close = () => { setSheet(null); load(); };

  return (
    <div className="card stack stack--sm">
      <div className="row row--between">
        <div className="strong">Two-step sign-in</div>
        <Chip tone={on ? 'success' : 'warn'}>{on ? 'On' : 'Off'}</Chip>
      </div>
      {on ? (
        <>
          <p className="small muted">
            Signing in asks for a code from your authenticator app as well as your password. Keep your backup codes
            somewhere safe: they get you in if you lose your phone.
          </p>
          <div className="btn-group">
            <button className="btn" onClick={() => setSheet('codes')}>New backup codes</button>
            <button className="btn" onClick={() => setSheet('off')}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="small muted">
            Admins can manage everyone’s accounts, so a password alone is a lot to rest on. Turn this on to also need a
            code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password and the
            like) each time you sign in.
          </p>
          <button className="btn btn--primary" onClick={() => setSheet('setup')}>Turn on two-step sign-in</button>
        </>
      )}
      {sheet === 'setup' ? <SetUpTwoFactorSheet onClose={close} /> : null}
      {sheet === 'codes' ? <NewBackupCodesSheet onClose={close} /> : null}
      {sheet === 'off' ? <TurnOffTwoFactorSheet onClose={close} /> : null}
    </div>
  );
}

/** Password, then the QR code and backup codes, then a code from the app. Only that last step turns it on. */
function SetUpTwoFactorSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setSetup(await auth.startTwoFactor(password));
      setPassword('');
    } catch (e) {
      setError(/password/i.test((e as Error).message) ? 'That password is not right.' : (e as Error).message);
    }
    setBusy(false);
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await auth.confirmTwoFactor(code);
      toast('Two-step sign-in is on. Other devices will ask you to sign in again.');
      onClose();
    } catch {
      setError('That code is not right. Check the app and enter the code it shows now.');
      setCode('');
      setBusy(false);
    }
  };

  const secret = setup ? new URL(setup.totpURI).searchParams.get('secret') ?? '' : '';

  return (
    <Sheet
      title="Turn on two-step sign-in"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          {setup ? (
            <button className="btn btn--primary" disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={() => void confirm()}>Turn on</button>
          ) : (
            <button className="btn btn--primary" disabled={busy || !password} onClick={() => void start()}>Next</button>
          )}
        </>
      }
    >
      {setup ? (
        <div className="stack">
          <p className="small">
            <span className="strong">1.</span> In your authenticator app, add an account and scan this code.
          </p>
          <img
            alt="QR code for your authenticator app"
            src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.totpURI, { border: 2 }))}`}
            width={200}
            height={200}
            style={{ alignSelf: 'center', background: '#fff', borderRadius: 8 }}
          />
          <p className="xsmall muted">
            Can’t scan it? Choose to enter a key instead and type: <code className="mono">{secret.match(/.{1,4}/g)?.join(' ')}</code>
          </p>
          <p className="small">
            <span className="strong">2.</span> Save these backup codes somewhere safe, away from your phone. Each gets you
            in once if you lose it. They are not shown again.
          </p>
          <BackupCodes codes={setup.backupCodes} />
          <p className="small">
            <span className="strong">3.</span> Enter the six-digit code the app now shows for AEROBOOK.
          </p>
          <TextField label="Code from the app" value={code} onChange={setCode} inputMode="numeric" autoComplete="one-time-code" />
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>
      ) : (
        <div className="stack">
          <p className="small">Enter your password to start. Nothing changes until you enter a code from the app.</p>
          <TextField label="Password" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>
      )}
    </Sheet>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const toast = useToast();
  return (
    <div className="stack stack--sm">
      <div className="card mono small" style={{ columns: 2 }}>
        {codes.map((c) => <div key={c}>{c}</div>)}
      </div>
      <button
        className="btn btn--ghost"
        onClick={() => {
          navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Backup codes copied'), () => toast('Copy them by hand instead', 'error'));
        }}
      >
        Copy the codes
      </button>
    </div>
  );
}

function NewBackupCodesSheet({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const make = async () => {
    setBusy(true);
    setError('');
    try {
      setCodes(await auth.newBackupCodes(password));
      setPassword('');
    } catch (e) {
      setError(/password/i.test((e as Error).message) ? 'That password is not right.' : (e as Error).message);
    }
    setBusy(false);
  };

  return (
    <Sheet
      title="New backup codes"
      onClose={onClose}
      footer={codes ? <button className="btn btn--primary" onClick={onClose}>I’ve saved them</button> : (
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={busy || !password} onClick={() => void make()}>Make new codes</button>
        </>
      )}
    >
      {codes ? (
        <div className="stack">
          <p className="small">Your old backup codes no longer work. Save these somewhere safe; they are not shown again.</p>
          <BackupCodes codes={codes} />
        </div>
      ) : (
        <div className="stack">
          <p className="small">New codes replace the old ones, which stop working.</p>
          <TextField label="Password" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>
      )}
    </Sheet>
  );
}

function TurnOffTwoFactorSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const turnOff = async () => {
    setBusy(true);
    setError('');
    try {
      await auth.turnOffTwoFactor(password);
      toast('Two-step sign-in is off');
      onClose();
    } catch (e) {
      setError(/password/i.test((e as Error).message) ? 'That password is not right.' : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Turn off two-step sign-in"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--danger" disabled={busy || !password} onClick={() => void turnOff()}>Turn off</button>
        </>
      }
    >
      <div className="stack">
        <p className="small">Signing in will need only your password again. Your backup codes stop working.</p>
        <TextField label="Password" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
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
            {m.twoFactor ? <Chip tone="success">Two-step</Chip> : null}
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
  const [deleting, setDeleting] = useState(false);

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

  if (deleting) {
    return (
      <DeleteMemberSheet
        member={member}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          toast(`${member.name} was deleted`);
          onChanged();
          onClose();
        }}
      />
    );
  }

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
            {member.twoFactor ? (
              <>
                <ConfirmButton
                  className="btn btn--danger btn--block"
                  label="Reset two-step sign-in"
                  confirmLabel="Tap again to reset it"
                  onConfirm={() => void run(() => auth.resetTwoFactor(member.id), `Two-step sign-in reset for ${member.name}`)}
                />
                <p className="xsmall muted">
                  Only for someone who has lost their phone and their backup codes. It signs them out everywhere; they sign in
                  with their password and set it up again. It is recorded against your name.
                </p>
              </>
            ) : null}
            <button className="btn btn--danger btn--block" disabled={busy} onClick={() => setDeleting(true)}>
              Delete {member.name}…
            </button>
          </>
        )}
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
  );
}

/** Deleting is for good, so it asks for the person's name first. */
function DeleteMemberSheet({ member, onClose, onDeleted }: {
  member: TeamMember;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim().toLowerCase() === member.name.trim().toLowerCase();

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await auth.deleteMember(member.id);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={`Delete ${member.name}`}
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--danger" disabled={busy || !matches} onClick={() => void remove()}>
            {busy ? 'Deleting…' : 'Delete for good'}
          </button>
        </>
      )}
    >
      <div className="stack">
        <Banner tone="warn">This cannot be undone. To stop someone signing in for now, turn off their access instead.</Banner>
        <div className="small stack stack--sm">
          <div>
            <span className="strong">Goes:</span> their sign-in and password, their email address on this account (free to
            use for someone new), their notifications and devices, the aircraft they watch, and their place in group chats.
            Follow-ups for them go back to everyone.
          </div>
          <div>
            <span className="strong">Stays:</span> everything they recorded — contacts, aircraft, notes, documents, messages
            and comments — shown as “{member.name} (deleted)”.
          </div>
        </div>
        <TextField label={`Type “${member.name}” to confirm`} value={typed} onChange={setTyped} autoComplete="off" />
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Sheet>
  );
}
