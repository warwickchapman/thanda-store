'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

const RESEND_COOLDOWN_SECONDS = 30;

export default function LoginPage() {
  return <Suspense fallback={<main className="min-h-screen bg-zinc-50" />}><LoginForm /></Suspense>;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(() => searchParams.get('email') || '');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'password' | 'otp'>('password');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(0);

  useEffect(() => {
    if (resendSeconds === 0) return;

    const timer = window.setInterval(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resendSeconds]);

  async function requestOtp() {
    const isResend = step === 'otp';
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch('/api/auth/login/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not request login code');
      setStep('otp');
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
      setMessage(isResend ? `A new login code was sent to ${data.email}.` : `Login code sent to ${data.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request login code');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Invalid login code');
      window.location.href = '/';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid login code');
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
            <p className="text-sm text-zinc-500">Dealer portal sign in</p>
          </div>
        </div>

        <form
          onSubmit={(event) => {
            if (step === 'password') {
              event.preventDefault();
              void requestOtp();
              return;
            }
            void verifyOtp(event);
          }}
          className="space-y-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm"
        >
          <div>
            <label className="mb-1 block text-sm font-semibold" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={step === 'otp'}
              autoComplete="email"
              className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base outline-none focus:border-zinc-950"
            />
          </div>

          {step === 'password' ? (
            <div>
              <label className="mb-1 block text-sm font-semibold" htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base outline-none focus:border-zinc-950"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-semibold" htmlFor="otp">Email code</label>
              <input
                id="otp"
                inputMode="numeric"
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
                autoComplete="one-time-code"
                className="h-11 w-full rounded-md border border-zinc-300 px-3 text-base tracking-widest outline-none focus:border-zinc-950"
              />
            </div>
          )}

          {message && <p className="text-sm text-green-700">{message}</p>}
          {error && <p className="text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="h-11 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Please wait...' : step === 'password' ? 'Send login code' : 'Sign in'}
          </button>

          {step === 'otp' && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => void requestOtp()}
                disabled={busy || resendSeconds > 0}
                className="h-10 w-full text-sm font-semibold text-zinc-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setStep('password');
                  setOtp('');
                  setMessage('');
                  setError('');
                  setResendSeconds(0);
                }}
                className="h-10 w-full text-sm font-semibold text-zinc-600"
              >
                Use a different password
              </button>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
