'use client';
import { formatCurrency } from "@/lib/utils";
import { Search, Package, ShoppingCart, Info, LogOut } from "lucide-react";
import { useState, useEffect, useRef } from 'react';

// Client-side DB fetching isn't ideal, but for this B2B simplicity we'll use an API route or a fetch pattern.
// However, since we want to keep it simple, I'll move the data fetching to an API route and fetch it here.

interface Product {
  id: number;
  name: string;
  supplier: string;
  category: string;
  price: string | number;
  recommended_retail_ex_vat: number | null;
  your_price_ex_vat: number | null;
  b2b_discount_percent: number;
  sku: string;
  image_url: string;
  thumbnail_url: string;
  stock_on_hand: number;
  details: Record<string, string | number | boolean | string[] | null>;
}

interface SessionUser {
  username: string;
  role: string;
  organisationName: string;
}

function displayLabel(value: string) {
  const label = value
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
  return label
    .replace(/\bAnd\b/g, '&')
    .replace(/\bDc\b/gi, 'DC')
    .replace(/\bSmartshunt\b/gi, 'SmartShunt')
    .replace(/\(ev\)/gi, '(EV)');
}

function supplierLabel(supplier: string) {
  const labels: Record<string, string> = {
    hubble: 'Hubble',
    eiot: 'eIoT',
    lora: 'LoRa',
  };
  return labels[supplier.toLowerCase()] || displayLabel(supplier);
}

function numberDetail(value: Product['details'][string]) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function supplierStockLabel(product: Product) {
  if (typeof product.details.supplierStockLabel === 'string') return product.details.supplierStockLabel;
  if (product.supplier === 'renogy') return 'Renogy Warehouse ZA';
  if (product.supplier === 'victron') return 'Victron Warehouse ZA';
  return '';
}

function stockLines(product: Product) {
  const supplier = product.supplier.toLowerCase();
  const localStock = numberDetail(product.details.localStockOnHand);
  const supplierLabelText = supplierStockLabel(product);

  if (supplier === 'lora') {
    return [`${localStock ?? 0} in stock (KZN)`];
  }

  if (supplier === 'hubble') {
    return [typeof product.details.manualAvailability === 'string' ? product.details.manualAvailability : 'Out of stock'];
  }

  const lines: string[] = [];
  if (localStock !== null && localStock > 0) lines.push(`${localStock} in stock (KZN)`);
  if (supplier === 'renogy') lines.push('Availability: 4-7 working days');
  if (supplier === 'victron') lines.push('Availability: 3-5 working days');
  if (supplierLabelText) lines.push(`${product.stock_on_hand} in stock at ${supplierLabelText}`);
  return lines;
}

function primaryStockBadge(product: Product) {
  const localStock = numberDetail(product.details.localStockOnHand);
  if (localStock !== null && localStock > 0) return `${localStock} in stock (KZN)`;
  if (product.supplier === 'hubble') return typeof product.details.manualAvailability === 'string' ? product.details.manualAvailability : 'Out of stock';
  if (product.supplier === 'lora') return `${localStock ?? 0} in stock (KZN)`;
  return product.supplier === 'renogy' ? '4-7 days' : product.supplier === 'victron' ? '3-5 days' : 'Check stock';
}

function ProductImage({ product }: { product: Product }) {
  const [imageIndex, setImageIndex] = useState(0);
  const sources = [product.thumbnail_url, product.image_url].filter(Boolean);
  const src = sources[imageIndex];

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed border-zinc-100 bg-zinc-50/30">
        <Package className="h-16 w-16 text-zinc-200" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={product.name}
      className="h-full w-full object-contain transition-all duration-700 group-hover:scale-105"
      loading="lazy"
      decoding="async"
      onError={() => {
        setImageIndex(imageIndex < sources.length - 1 ? imageIndex + 1 : sources.length);
      }}
    />
  );
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeSupplier, setActiveSupplier] = useState('');
  const [activeCategory, setActiveCategory] = useState('');
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/session')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.user) setSessionUser(data.user);
      })
      .catch(() => {});

    fetch('/api/products')
      .then(res => {
        if (res.status === 401) {
          window.location.href = '/login';
          return null;
        }
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          setProducts(data);
        }
        setLoading(false);
      })
      .catch(err => {
        console.error('Fetch error:', err);
        setLoading(false);
      });
  }, []);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  }

  useEffect(() => {
    const handleGlobalSearch = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditable = target?.tagName === 'INPUT'
        || target?.tagName === 'TEXTAREA'
        || target?.isContentEditable;
      if (isEditable || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        setQuery('');
        searchInputRef.current?.blur();
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        searchInputRef.current?.focus();
        setQuery((current) => current.slice(0, -1));
        return;
      }

      if (event.key.length !== 1) return;
      event.preventDefault();
      searchInputRef.current?.focus();
      setQuery((current) => `${current}${event.key}`);
    };

    window.addEventListener('keydown', handleGlobalSearch);
    return () => window.removeEventListener('keydown', handleGlobalSearch);
  }, []);

  const filteredProducts = products.filter((product) => {
    const search = query.trim().toLowerCase();
    if (!search) return true;
    return product.sku.toLowerCase().includes(search)
      || product.name.toLowerCase().includes(search)
      || product.supplier.toLowerCase().includes(search)
      || product.category.toLowerCase().includes(search);
  });
  const supplierProducts = filteredProducts.reduce<Record<string, Product[]>>((groups, product) => {
    const supplier = product.supplier || 'unknown';
    groups[supplier] = groups[supplier] || [];
    groups[supplier].push(product);
    return groups;
  }, {});
  const allSuppliers = Array.from(new Set(products.map((product) => product.supplier || 'unknown')));
  const supplierTabs = allSuppliers.map((supplier) => ({
    supplier,
    count: supplierProducts[supplier]?.length || 0,
  }));
  const visibleSuppliers = supplierTabs.filter((tab) => tab.count > 0);
  const selectedSupplier = activeSupplier && supplierProducts[activeSupplier]
    ? activeSupplier
    : visibleSuppliers[0]?.supplier || '';
  const productsInSupplier = selectedSupplier ? supplierProducts[selectedSupplier] || [] : [];
  const groupedProducts = productsInSupplier.reduce<Record<string, Product[]>>((groups, product) => {
    const category = product.category || 'uncategorized';
    groups[category] = groups[category] || [];
    groups[category].push(product);
    return groups;
  }, {});
  const allCategories = Array.from(new Set(productsInSupplier.map((product) => product.category || 'uncategorized')));
  const categoryTabs = allCategories.map((category) => ({
    category,
    count: groupedProducts[category]?.length || 0,
  }));
  const visibleCategories = categoryTabs.filter((tab) => tab.count > 0);
  const selectedCategory = activeCategory && groupedProducts[activeCategory]
    ? activeCategory
    : visibleCategories[0]?.category || '';
  const selectedProducts = selectedCategory ? groupedProducts[selectedCategory] || [] : [];
  const priceLabel = (amount: number | null) => amount === null ? 'POA' : formatCurrency(amount);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 font-sans text-zinc-900">
      {/* Top Bar - Minimal */}
      <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:h-16 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-0">
          <div className="flex items-center gap-4">
            <img 
              src="/logos/logo_icon_color.png" 
              alt="Thanda Store Icon" 
              className="h-10 w-10 object-contain"
            />
            <span className="text-xl font-bold tracking-tight text-zinc-900">
              THANDA STORE
            </span>
          </div>
          
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-4">
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input 
                ref={searchInputRef}
                type="text" 
                placeholder="Search SKU or name..." 
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-full border border-zinc-200 bg-zinc-50 pl-10 pr-4 text-sm focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {sessionUser && (
                <div className="flex h-9 items-center rounded-lg border border-zinc-200 px-3 text-xs font-semibold text-zinc-600">
                  {sessionUser.organisationName}
                </div>
              )}
              {sessionUser?.role === 'admin' && (
                <a href="/admin/users" className="flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-50">
                  <Info className="h-4 w-4" />
                  Admin
                </a>
              )}
              <button className="flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800">
                <ShoppingCart className="h-4 w-4" />
                Cart (0)
              </button>
              <button onClick={logout} className="flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-3 text-sm font-medium transition-colors hover:bg-zinc-50">
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
        <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Dealer Portal</h1>
            <p className="text-zinc-500">Premium inventory from top-tier brands.</p>
          </div>
          <div className="text-right">
            <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
              Warehouse Live
            </span>
          </div>
        </div>

        {/* Product Grid */}
        {loading ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-sm text-zinc-500">
            Loading products...
          </div>
        ) : visibleSuppliers.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-sm text-zinc-500">
            No products match your search.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <div className="flex min-w-max gap-2 border-b border-zinc-200">
                {visibleSuppliers.map(({ supplier, count }) => {
                  const isActive = supplier === selectedSupplier;
                  return (
                    <button
                      key={supplier}
                      type="button"
                      onClick={() => {
                        setActiveSupplier(supplier);
                        setActiveCategory('');
                      }}
                      className={`flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
                        isActive
                          ? 'border-zinc-950 text-zinc-950'
                          : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900'
                      }`}
                    >
                      <span>{supplierLabel(supplier)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        isActive ? 'bg-zinc-900 text-white' : 'bg-zinc-100 text-zinc-500'
                      }`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
              <div className="flex min-w-max gap-2 border-b border-zinc-200">
                {visibleCategories.map(({ category, count }) => {
                  const isActive = category === selectedCategory;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => setActiveCategory(category)}
                      className={`flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-semibold transition-colors ${
                        isActive
                          ? 'border-amber-600 text-zinc-950'
                          : 'border-transparent text-zinc-500 hover:border-zinc-300 hover:text-zinc-900'
                      }`}
                    >
                      <span>{displayLabel(category)}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        isActive ? 'bg-amber-50 text-amber-700' : 'bg-zinc-100 text-zinc-500'
                      }`}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <section className="space-y-4">
              <div className="flex items-end justify-between border-b border-zinc-200 pb-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400">{supplierLabel(selectedSupplier)}</p>
                  <h2 className="text-xl font-bold tracking-tight text-zinc-900">{displayLabel(selectedCategory)}</h2>
                </div>
                <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">
                  {selectedProducts.length} {selectedProducts.length === 1 ? 'product' : 'products'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {selectedProducts.map((product) => (
                    <div key={product.id} className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white transition-all duration-300 hover:shadow-2xl hover:-translate-y-1">
                      <div className="relative aspect-square w-full bg-zinc-50/50 overflow-hidden flex items-center justify-center p-6">
                        <ProductImage product={product} />
                        
                        {/* Category Badge - Subtle Glassmorphism */}
                        <div className="absolute left-4 top-4 flex max-w-[calc(100%-2rem)] items-center gap-2">
                          <span className="rounded-full bg-white/60 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-600 shadow-sm backdrop-blur-md ring-1 ring-zinc-900/5">
                            {displayLabel(product.category)}
                          </span>
                          <span className="rounded-full bg-white/80 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-700 shadow-sm backdrop-blur-md ring-1 ring-zinc-900/5">
                            {primaryStockBadge(product)}
                          </span>
                          {product.details.is120vAc === true && (
                            <span className="rounded-full bg-white/90 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-700 shadow-sm backdrop-blur-md ring-1 ring-zinc-900/5">
                              🇺🇸 120V AC
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex flex-1 flex-col p-5">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{product.sku}</div>
                        </div>
                        
                        <h3 className="mb-4 min-h-[2.5rem] line-clamp-2 text-sm font-bold leading-tight text-zinc-900 transition-colors group-hover:text-amber-600">
                          {product.name}
                        </h3>
                        <div className="mb-4 space-y-1 text-xs font-medium text-zinc-500">
                          {stockLines(product).map((line) => (
                            <div key={line}>{line}</div>
                          ))}
                          {product.details.is120vAc === true && (
                            <div className="font-semibold text-amber-700">🇺🇸 Note: 120V AC</div>
                          )}
                        </div>
                        
                        <div className="mt-auto flex flex-col gap-4 pt-5 border-t border-zinc-100/50">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-zinc-400 uppercase">Recommended Retail Excl. VAT</span>
                            <div className="text-xl font-black tracking-tight text-zinc-900">
                              {priceLabel(product.recommended_retail_ex_vat)}
                            </div>
                          </div>
                          
                          <div className="flex items-center justify-between">
                            <div className="flex flex-col">
                              <span className="text-[10px] font-bold text-zinc-400 uppercase">Your Price Excl. VAT</span>
                              <div className="text-sm font-bold text-amber-600">
                                {priceLabel(product.your_price_ex_vat)}
                              </div>
                            </div>
                            <button className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-white transition-all hover:bg-amber-600 hover:scale-110 shadow-lg shadow-zinc-900/10">
                              <ShoppingCart className="h-5 w-5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>

      <footer className="mt-12 bg-white">
        <div className="w-full h-24 overflow-hidden opacity-50 grayscale hover:grayscale-0 transition-all duration-700">
          <img 
            src="/banners/banner_wide.png" 
            alt="Thanda Brand Banner" 
            className="w-full h-full object-cover"
          />
        </div>
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 flex flex-col items-center gap-6">
          <img 
            src="/logos/logo_wordmark.png" 
            alt="Thanda Store" 
            className="h-12 object-contain brightness-0"
          />
          <p className="text-sm text-zinc-500">
            &copy; {new Date().getFullYear()} Thanda Store Dealer Portal. 
            Warehouse: 1000m² Operations Hub.
          </p>
        </div>
      </footer>
    </div>
  );
}
