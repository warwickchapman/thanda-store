'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';

type SessionUser = {
  id: number;
  email: string;
  organisationName: string;
  role: string;
  apiEnabled: boolean;
  impersonatedBy?: { email: string } | null;
};
type Session = { user: SessionUser | null; status: 'loading' | 'signed-in' | 'signed-out' | 'error' };
type SessionContextValue = Session & { reload: () => void };
const SessionContext = createContext<SessionContextValue | null>(null);

export function useStoreSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error('Store session must be inside StoreSessionProvider');
  return context;
}

export function StoreSessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isPublicPage = ['/login', '/forgot-password', '/set-password', '/request-quote'].includes(pathname);
  if (isPublicPage) return <SessionContext.Provider value={{ user: null, status: 'signed-out', reload: () => {} }}>{children}</SessionContext.Provider>;
  return <SignedInSessionProvider>{children}</SignedInSessionProvider>;
}

function SignedInSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ user: null, status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    async function load() {
      try {
        const response = await fetch('/api/session', { cache: 'no-store', signal: controller.signal });
        if (response.status === 401) {
          if (active) setSession({ user: null, status: 'signed-out' });
          return;
        }
        if (!response.ok) throw new Error('Session unavailable');
        const { user } = await response.json();
        if (!user || typeof user.email !== 'string' || typeof user.organisationName !== 'string') throw new Error('Session unavailable');
        if (active) setSession({ user, status: 'signed-in' });
      } catch {
        if (active) setSession({ user: null, status: 'error' });
      } finally {
        clearTimeout(timeout);
      }
    }
    void load();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [attempt]);

  function reload() {
    setSession({ user: null, status: 'loading' });
    setAttempt(value => value + 1);
  }
  return <SessionContext.Provider value={{ ...session, reload }}>{children}</SessionContext.Provider>;
}
