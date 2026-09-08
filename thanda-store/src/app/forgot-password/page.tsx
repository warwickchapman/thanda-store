'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

export default function ForgotPasswordPage() {
  return <Suspense fallback={<main className="min-h-screen bg-zinc-50" />}><ForgotPasswordForm /></Suspense>;
}

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') || '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to send a password reset email.');
      setMessage(data.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send a password reset email.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 py-8 text-zinc-950">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img src="/logos/logo_icon_color.png" alt="Thanda Store" className="h-11 w-11" />
          <div>
            <h1 className="text-xl font-bold">THANDA STORE</h1>
            <p className="text-sm text-zinc-500">Reset your password</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-semibold" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              required
              className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base outline-none focus:border-zinc-950"
            />
          </div>
          {message && <p className="text-sm text-green-700">{message}</p>}
          {error && <p className="text-sm text-red-700">{error}</p>}
          <button type="submit" disabled={busy} className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60">
            {busy ? 'Sending reset link...' : 'Email reset link'}
          </button>
        </form>
        <Link href={`/login?email=${encodeURIComponent(email)}`} className="mt-4 block text-center text-sm font-semibold text-zinc-600">Back to sign in</Link>
      </div>
    </main>
  );
}
