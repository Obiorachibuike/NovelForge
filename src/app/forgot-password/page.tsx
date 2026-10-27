'use client';
import { useState } from 'react';
import Link from 'next/link';

/**
 * Requests a password reset. The e-mail Brevo delivers contains both a reset
 * link and a six-digit code; the code path continues on /reset-password.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not submit request.');
      }
      setSent(true);
    } catch (err: any) {
      setError(err.message || 'Request failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#05070D] flex items-center justify-center p-6 text-white">
      <section className="w-full max-w-md space-y-5">
        <h1 className="font-serif text-3xl">Reset your password</h1>
        {sent ? (
          <div className="space-y-3">
            <p className="text-slate-300">
              If an account exists for that address, we sent a reset link and a 6-digit code. Check your inbox.
            </p>
            <Link
              className="btn-primary block w-full text-center"
              href={`/reset-password${email ? `?email=${encodeURIComponent(email)}` : ''}`}
            >
              Enter the 6-digit code
            </Link>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <p className="text-slate-400">
              Enter your account email and we’ll send a secure reset link plus a 6-digit code.
            </p>
            <input
              className="input"
              type="email"
              required
              maxLength={320}
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
            {error && (
              <p role="alert" className="text-red-400">
                {error}
              </p>
            )}
            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset email'}
            </button>
          </form>
        )}
        <Link className="text-indigo-400" href="/login">
          Back to sign in
        </Link>
      </section>
    </main>
  );
}
