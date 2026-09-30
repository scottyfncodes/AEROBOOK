import { useState, type FormEvent } from 'react';

import { Wordmark } from '../components/Brand';
import { Banner, TextField } from '../components/ui';
import * as auth from '../data/auth';
import { useSession } from '../data/session';

/**
 * The only screen before sign-in. There is deliberately no "create account":
 * an admin adds each person from Settings.
 */
export default function SignIn() {
  const session = useSession();

  return (
    <main className="page signin">
      <div className="signin__brand">
        <Wordmark large />
      </div>
      {session.status === 'checking' ? null
        : session.status === 'setup' ? <SetUp />
        : session.status === 'unreachable' ? <Unreachable onRetry={session.retry} />
        : <SignInForm />}
    </main>
  );
}

function SignInForm() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if ((await session.signIn(email, password)) === 'code') {
        setNeedsCode(true);
        setBusy(false);
      }
    } catch (err) {
      const text = (err as Error).message;
      setError(/invalid/i.test(text) ? 'That email and password do not match an account.' : text);
      setBusy(false);
    }
  };

  if (needsCode) {
    return <CodeForm onCancel={() => { setNeedsCode(false); setPassword(''); }} />;
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h1 className="signin__title">Sign in</h1>
      {session.message ? <Banner tone="info">{session.message}</Banner> : null}
      <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="username" />
      <TextField label="Password" value={password} onChange={setPassword} type="password" autoComplete="current-password" />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <button className="btn btn--primary btn--block" type="submit" disabled={busy || !email || !password}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="xsmall muted">No account? Ask whoever runs AEROBOOK to add you.</p>
    </form>
  );
}

/**
 * The second step for an account with two-step sign-in: the code the
 * authenticator app shows, or one of the backup codes saved at setup.
 */
function CodeForm({ onCancel }: { onCancel: () => void }) {
  const session = useSession();
  const [kind, setKind] = useState<'app' | 'backup'>('app');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await session.finishSignIn(code, kind);
    } catch (err) {
      const text = (err as Error).message;
      setError(
        /too many|locked/i.test(text) ? 'Too many wrong codes. Wait a few minutes, then sign in again.'
        : /cookie|expired/i.test(text) ? 'That took too long. Sign in again.'
        : kind === 'app' ? 'That code is not right. Check the app and try the code it shows now.'
        : 'That backup code is not right, or it has already been used.',
      );
      setCode('');
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h1 className="signin__title">Two-step sign-in</h1>
      <p className="small secondary">
        {kind === 'app'
          ? 'Enter the six-digit code your authenticator app shows for AEROBOOK.'
          : 'Enter one of the backup codes you saved when you set up two-step sign-in. Each works once.'}
      </p>
      <TextField
        label={kind === 'app' ? 'Code from the app' : 'Backup code'}
        value={code}
        onChange={setCode}
        inputMode={kind === 'app' ? 'numeric' : 'text'}
        autoComplete="one-time-code"
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <button className="btn btn--primary btn--block" type="submit" disabled={busy || !code.trim()}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <div className="btn-group">
        <button type="button" className="btn btn--ghost" onClick={() => { setKind(kind === 'app' ? 'backup' : 'app'); setCode(''); setError(''); }}>
          {kind === 'app' ? 'Use a backup code' : 'Use the app instead'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Back</button>
      </div>
      <p className="xsmall muted">Lost your phone and your backup codes? Another admin can reset two-step sign-in for you.</p>
    </form>
  );
}

function SetUp() {
  const session = useSession();
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = confirm !== '' && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 10) return setError('Use at least 10 characters for the password.');
    if (mismatch) return setError('The two passwords are different.');
    setError('');
    setBusy(true);
    try {
      await auth.setUp({ token: token.trim(), name, email, password });
      await session.signIn(email, password);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h1 className="signin__title">Set up AEROBOOK</h1>
      <p className="small secondary">
        Nobody has an account yet. Create the first one — it becomes the admin, who adds everyone else.
      </p>
      <TextField
        label="Setup token"
        value={token}
        onChange={setToken}
        type="password"
        autoComplete="off"
        hint="The SETUP_TOKEN set on the deployment."
      />
      <TextField label="Your name" value={name} onChange={setName} autoComplete="name" />
      <TextField label="Email" value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="username" />
      <TextField label="Password" value={password} onChange={setPassword} type="password" autoComplete="new-password" hint="At least 10 characters." />
      <TextField
        label="Password again"
        value={confirm}
        onChange={setConfirm}
        type="password"
        autoComplete="new-password"
        error={mismatch ? 'Different from the first' : undefined}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <button className="btn btn--primary btn--block" type="submit" disabled={busy || !token || !name || !email || !password}>
        {busy ? 'Setting up…' : 'Create the admin account'}
      </button>
    </form>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="card stack">
      <h1 className="signin__title">Can’t reach AEROBOOK</h1>
      <p className="small secondary">
        This device is offline or the server is not answering, and there is no copy saved here to open instead.
      </p>
      <button className="btn btn--primary btn--block" onClick={onRetry}>Try again</button>
    </div>
  );
}
