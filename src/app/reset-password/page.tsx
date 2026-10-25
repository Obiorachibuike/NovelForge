'use client';
import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * Password reset page.
 *
 * With `?token=…` (from the e-mailed link) only a new password is needed. The
 * same message also carries a six-digit code, so the page accepts
 * `email + code + new password` — the path that works when the mail is opened
 * on a different device than the one doing the reset.
 */
function Reset() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [useCode, setUseCode] = useState(!token);
  const [email, setEmail] = useState(params.get('email') || '');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    try {
      const payload = useCode || !token ? { email, code, password } : { token, password };
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'This reset could not be completed.');
      setStatus('Password updated. You can now sign in with your new password.');
    } catch (error: any) {
      setStatus(error?.message || 'This reset could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  const done = status.startsWith('Password updated');

  return (
    <main className="min-h-screen bg-[#05070D] flex items-center justify-center p-6 text-white">
      <form onSubmit={submit} className="w-full max-w-md space-y-5">
        <h1 className="font-serif text-3xl">Choose a new password</h1>
        {!done && (
          <p className="text-sm text-slate-400">
            {useCode
              ? 'Enter the email address, the 6-digit code from the reset email, and a new password.'
              : 'Enter a new password for your account.'}
          </p>
        )}

        {useCode && (
          <>
            <label className="block text-sm text-slate-300" htmlFor="reset-email">
              Email
              <input
                id="reset-email"
                className="input mt-2"
                type="email"
                required
                maxLength={320}
                autoComplete="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="block text-sm text-slate-300" htmlFor="reset-code">
              Reset code
              <input
                id="reset-code"
                className="input mt-2 tracking-[0.4em] font-mono text-center text-lg"
                inputMode="numeric"
                pattern="[0-9 ]*"
                autoComplete="one-time-code"
                maxLength={7}
                required
                value={code}
                onChange={event => setCode(event.target.value)}
                placeholder="123456"
              />
            </label>
          </>
        )}

        <label className="block text-sm text-slate-300" htmlFor="reset-password">
          New password
          <input
            id="reset-password"
            className="input mt-2"
            type="password"
            required
            minLength={8}
            maxLength={72}
            autoComplete="new-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
        </label>

        {status && (
          <p role="status" className={done ? 'text-emerald-300' : 'text-red-400'}>
            {status}
          </p>
        )}

        {!done && (
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Updating…' : 'Update password'}
          </button>
        )}

        {token && (
          <button
            type="button"
            className="text-xs text-indigo-400 hover:text-indigo-300"
            onClick={() => {
              setUseCode(current => !current);
              setStatus('');
            }}
          >
            {useCode ? 'Use the link from the email instead' : 'Use the 6-digit code instead'}
          </button>
        )}

        <Link className="block text-indigo-400" href="/login">
          Back to sign in
        </Link>
      </form>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#05070D] text-white p-8">Loading…</main>}>
      <Reset />
    </Suspense>
  );
}
