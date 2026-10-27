'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Search, UserRound, RefreshCw } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useStoreSession } from '@/components/store-session';

type SearchContextValue = { query: string; setQuery: React.Dispatch<React.SetStateAction<string>> };
const SearchContext = createContext<SearchContextValue | null>(null);

export function useStoreSearch() {
  const context = useContext(SearchContext);
  if (!context) throw new Error('Store search must be inside StoreSearchProvider');
  return context;
}

export function StoreSearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  return <SearchContext.Provider value={{ query, setQuery }}>{children}</SearchContext.Provider>;
}

export function StoreHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { query, setQuery } = useStoreSearch();
  const { user, status, reload } = useStoreSession();
  const isCatalogue = pathname === '/';
  const isAuthPage = ['/login', '/forgot-password', '/set-password'].includes(pathname);

  useEffect(() => {
    if (isCatalogue) setQuery(new URLSearchParams(window.location.search).get('q') || '');
  }, [isCatalogue, setQuery]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isCatalogue) return;
    const search = query.trim();
    router.push(search ? `/?q=${encodeURIComponent(search)}` : '/');
  }

  if (isAuthPage) return null;

  if (pathname === '/request-quote') return <header className="border-b border-zinc-200 bg-white"><div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
    <a href="https://thanda.solar" aria-label="Thanda Solar website" className="flex items-center gap-3"><img src="/logos/logo_icon_color.png" alt="" className="h-10 w-10 object-contain" /><span className="text-lg font-bold tracking-tight">THANDA SOLAR</span></a>
    <Link href="/login" className="text-sm font-semibold text-zinc-600 underline underline-offset-4">Trade sign in</Link>
  </div></header>;

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:min-h-16 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6 sm:gap-y-2 sm:px-6 sm:py-2">
        <Link href="/" className="flex min-w-0 shrink-0 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600" aria-label="Thanda Store home">
          <img src="/logos/logo_icon_color.png" alt="" className="h-10 w-10 shrink-0 object-contain" />
          <span className="truncate text-xl font-bold tracking-tight text-zinc-900">THANDA STORE</span>
        </Link>
        <form role="search" onSubmit={submitSearch} className="relative w-full sm:min-w-48 sm:max-w-xs sm:flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input id="store-product-search" type="search" placeholder="Search SKU or name..." aria-label="Search products" value={query} onChange={(event) => { setQuery(event.target.value); window.dispatchEvent(new Event('store-search-change')); }} className="h-11 w-full rounded-full border border-zinc-200 bg-zinc-50 pl-10 pr-4 text-sm focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-600 sm:h-9" />
        </form>
        <div aria-label={user?.impersonatedBy ? 'Customer being viewed' : 'Signed-in account'} className="min-w-0 w-full text-sm sm:ml-auto sm:w-auto sm:max-w-xs sm:text-right">
          {status === 'signed-in' && user ? <>
            <p className="break-words text-xs text-zinc-500">{user.organisationName}</p>
            <p className="mt-0.5 flex items-start gap-2 font-semibold text-zinc-800 sm:justify-end">
              <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="min-w-0 break-all">{user.email}</span>
            </p>
          </> : status === 'error' ? <div role="status" className="flex items-center gap-2 text-xs text-amber-800 sm:justify-end">
            <span>Sign-in details unavailable</span>
            <button type="button" onClick={reload} aria-label="Retry sign-in details" title="Retry sign-in details" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>
          </div> : status === 'loading' ? <p role="status" className="text-xs text-zinc-500">Checking sign-in...</p>
            : <Link href="/login" className="text-sm font-semibold text-zinc-600 underline underline-offset-4">Sign in</Link>}
        </div>
      </div>
    </header>
  );
}
