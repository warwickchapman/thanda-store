'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const destinations = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/companies', label: 'Companies' },
  { href: '/admin/data-health', label: 'Data health' },
  { href: '/admin/replenishment', label: 'Inventory planning' },
  { href: '/admin/quote-requests', label: 'Quote requests & notifications' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/', label: 'Back to store' },
];

export function AdminMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

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

  return <div ref={container} className="relative shrink-0">
    <button ref={trigger} type="button" aria-expanded={open} aria-controls="admin-navigation" onClick={() => setOpen(value => !value)} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900">
      {open ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
      Admin menu
    </button>
    {open && <nav id="admin-navigation" aria-label="Admin navigation" className="absolute right-0 z-30 mt-2 w-[min(19rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white p-1 shadow-xl">
      {destinations.map(({ href, label }) => {
        const current = href !== '/' && (pathname === href || (href === '/admin/users' && pathname.startsWith('/admin/users/')));
        return <Link key={href} href={href} aria-current={current ? 'page' : undefined} onClick={() => setOpen(false)} className={`block rounded-md px-3 py-2.5 text-sm font-medium hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:outline-none ${current ? 'bg-zinc-100 text-zinc-950' : 'text-zinc-700'} ${href === '/' ? 'mt-1 border-t border-zinc-200 pt-3' : ''}`}>{label}</Link>;
      })}
    </nav>}
  </div>;
}
