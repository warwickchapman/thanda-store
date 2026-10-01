'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';

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

  return (
    <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-4 py-3 sm:min-h-16 sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:py-2">
        <Link href="/" className="flex min-w-0 shrink-0 items-center gap-3 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600" aria-label="Thanda Store home">
          <img src="/logos/logo_icon_color.png" alt="" className="h-10 w-10 shrink-0 object-contain" />
          <span className="truncate text-xl font-bold tracking-tight text-zinc-900">THANDA STORE</span>
        </Link>
        <form role="search" onSubmit={submitSearch} className="relative w-full sm:max-w-xs">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input id="store-product-search" type="search" placeholder="Search SKU or name..." aria-label="Search products" value={query} onChange={(event) => { setQuery(event.target.value); window.dispatchEvent(new Event('store-search-change')); }} className="h-11 w-full rounded-full border border-zinc-200 bg-zinc-50 pl-10 pr-4 text-sm focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-600 sm:h-9" />
        </form>
      </div>
    </header>
  );
}
