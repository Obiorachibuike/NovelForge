'use client';
import { useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * Verify-email page.
 *
 * The e-mail contains a link and a six-digit code. Opening the link lands here
 * with `?token=…` and verification happens automatically; typing the code is
 * the fallback for when the message is opened on a different device (or a mail
 * scanner consumed the link).
 */
function Verify() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [email, setEmail] = useState(params.get('email') || '');
  const [code, setCode] = useState('');
  const [linkState, setLinkState] = useState<'idle' | 'working' | 'ok' | 'error'>(token ? 'working' : 'idle');
  const [codeError, setCodeError] = useState('');
  const [codeOk, setCodeOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    let cancelled = false;
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async response => {
        if (cancelled) return;
        setLinkState(response.ok ? 'ok' : 'error');
      })
      .catch(() => !cancelled && setLinkState('error'));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const verified = linkState === 'ok' || codeOk;

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setCodeError('');
    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'That code could not be verified.');
      setCodeOk(true);
    } catch (error: any) {
      setCodeError(error?.message || 'That code could not be verified.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070D] flex items-center justify-center p-6 text-white">
      <section className="w-full max-w-md space-y-5">
        <h1 className="font-serif text-3xl">Verify your email</h1>

        {verified ? (
          <>
            <p role="status" className="text-emerald-300">
              Email verified. You can now sign in.
            </p>
            <Link className="text-indigo-400" href="/login">
              Continue to sign in
            </Link>
          </>
        ) : (
          <>
            {linkState === 'working' && <p role="status" className="text-slate-300">Verifying your email…</p>}
            {linkState === 'error' && (
              <p role="alert" className="text-amber-300">
                That link is invalid, expired, or already used. Enter the 6-digit code from the same email instead.
              </p>
            )}
            {linkState === 'idle' && (
              <p className="text-slate-400">
                Enter the 6-digit code from your verification email, or open the link in that message.
              </p>
            )}

            <form className="space-y-4" onSubmit={submitCode}>
              <label className="block text-sm text-slate-300" htmlFor="verify-email">
                Email
                <input
                  id="verify-email"
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
              <label className="block text-sm text-slate-300" htmlFor="verify-code">
                Verification code
                <input
                  id="verify-code"
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
              {codeError && (
                <p role="alert" className="text-red-400">
                  {codeError}
                </p>
              )}
              <button className="btn-primary w-full" disabled={busy}>
                {busy ? 'Verifying…' : 'Verify email'}
              </button>
            </form>

            <p className="text-sm text-slate-400">
              Need a new email? <Link className="text-indigo-400" href="/login?verification=required">Resend it from the sign-in page</Link>.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[#05070D] text-white p-8">Loading…</main>}>
      <Verify />
    </Suspense>
  );
}
