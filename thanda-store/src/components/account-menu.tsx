'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export function AccountMenu() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void fetch('/api/session').then(response => response.json()).then(data => {
      if (active) setIsAdmin(data.user?.role === 'admin');
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  const links = [
    { href: '/', label: 'Store' },
    { href: '/accounts', label: 'Accounts' },
    { href: '/api-access', label: 'API access' },
    ...(isAdmin ? [{ href: '/admin/users', label: 'Admin' }] : []),
  ];

  return <div ref={container} className="relative shrink-0">
    <button ref={trigger} type="button" aria-expanded={open} aria-controls="account-navigation" onClick={() => setOpen(value => !value)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900">
      {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
      Menu
    </button>
    {open && <nav id="account-navigation" aria-label="Account navigation" className="absolute right-0 z-30 mt-2 w-[min(19rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white p-2 shadow-xl">
      {links.map(({ href, label }) => <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined} onClick={() => setOpen(false)} className={`block rounded-md px-3 py-2 text-sm font-medium hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none ${pathname === href ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-700'}`}>{label}</Link>)}
      <button type="button" onClick={() => void logout()} className="block w-full rounded-md px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none">Logout</button>
    </nav>}
  </div>;
}
