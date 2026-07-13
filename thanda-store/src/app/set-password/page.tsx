'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

export default function SetPasswordPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!token) {
      setError('This setup link is invalid. Request a new one from Thanda Store.');
      return;
    }
    if (password.length < 12) {
      setError('Use a password of at least 12 characters.');
      return;
    }
    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/auth/account/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to set your password.');
      setMessage('Password set. You can now sign in.');
      setPassword('');
      setConfirmation('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to set your password.');
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
            <p className="text-sm text-zinc-500">Set your account password</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-sm font-semibold" htmlFor="password">New password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base outline-none focus:border-zinc-950"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-semibold" htmlFor="confirmation">Confirm password</label>
            <input
              id="confirmation"
              type="password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="new-password"
              className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base outline-none focus:border-zinc-950"
            />
          </div>

          {message && <p className="text-sm text-green-700">{message}</p>}
          {error && <p className="text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={busy || Boolean(message)}
            className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Saving password...' : 'Set password'}
          </button>
        </form>

        <Link href="/login" className="mt-4 block text-center text-sm font-semibold text-zinc-600">Back to sign in</Link>
      </div>
    </main>
  );
}
