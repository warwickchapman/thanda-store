'use client';
import { formatCurrency } from "@/lib/utils";
import { Search, Package, ShoppingCart, Info } from "lucide-react";
import { useState, useEffect } from 'react';

// Client-side DB fetching isn't ideal, but for this B2B simplicity we'll use an API route or a fetch pattern.
// However, since we want to keep it simple, I'll move the data fetching to an API route and fetch it here.

interface Product {
  id: number;
  name: string;
  category: string;
  price: string | number;
  recommended_retail_ex_vat: number | null;
  your_price_ex_vat: number | null;
  b2b_discount_percent: number;
  sku: string;
  image_url: string;
  stock_on_hand: number;
  details: Record<string, string | number | null>;
}

function categoryLabel(category: string) {
  return category
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('');

  useEffect(() => {
    fetch('/api/products')
      .then(res => res.json())
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

  const filteredProducts = products.filter((product) => {
    const search = query.trim().toLowerCase();
    if (!search) return true;
    return product.sku.toLowerCase().includes(search)
      || product.name.toLowerCase().includes(search)
      || product.category.toLowerCase().includes(search);
  });
  const groupedProducts = filteredProducts.reduce<Record<string, Product[]>>((groups, product) => {
    const category = product.category || 'uncategorized';
    groups[category] = groups[category] || [];
    groups[category].push(product);
    return groups;
  }, {});
  const allCategories = Array.from(new Set(products.map((product) => product.category || 'uncategorized')));
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
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
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
          
          <div className="flex items-center gap-4">
            <div className="relative hidden sm:block">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <input 
                type="text" 
                placeholder="Search SKU or name..." 
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-64 rounded-full border border-zinc-200 bg-zinc-50 pl-10 pr-4 text-sm focus:border-amber-600 focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
            </div>
            <button className="flex h-9 items-center gap-2 rounded-lg border border-zinc-200 px-4 text-sm font-medium transition-colors hover:bg-zinc-50">
              <Info className="h-4 w-4" />
              Support
            </button>
            <button className="flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition-colors hover:bg-zinc-800">
              <ShoppingCart className="h-4 w-4" />
              Cart (0)
            </button>
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
        ) : visibleCategories.length === 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-8 text-sm text-zinc-500">
            No products match your search.
          </div>
        ) : (
          <div className="space-y-6">
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
                      <span>{categoryLabel(category)}</span>
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
                <h2 className="text-xl font-bold tracking-tight text-zinc-900">{categoryLabel(selectedCategory)}</h2>
                <span className="text-xs font-medium uppercase tracking-widest text-zinc-400">
                  {selectedProducts.length} {selectedProducts.length === 1 ? 'product' : 'products'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {selectedProducts.map((product) => (
                    <div key={product.id} className="group flex flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white transition-all duration-300 hover:shadow-2xl hover:-translate-y-1">
                      <div className="relative aspect-square w-full bg-zinc-50/50 overflow-hidden flex items-center justify-center p-6">
                        {product.image_url ? (
                          <img 
                            src={product.image_url} 
                            alt={product.name}
                            className="h-full w-full object-contain transition-all duration-700 group-hover:scale-105"
                            onError={(e) => {
                              (e.target as HTMLImageElement).src = ""; // Force fallback on error
                            }}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed border-zinc-100 bg-zinc-50/30">
                            <Package className="h-16 w-16 text-zinc-200" />
                          </div>
                        )}
                        
                        {/* Category Badge - Subtle Glassmorphism */}
                        <div className="absolute left-4 top-4 flex max-w-[calc(100%-2rem)] items-center gap-2">
                          <span className="rounded-full bg-white/60 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-600 shadow-sm backdrop-blur-md ring-1 ring-zinc-900/5">
                            {product.category}
                          </span>
                          <span className="rounded-full bg-white/80 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-zinc-700 shadow-sm backdrop-blur-md ring-1 ring-zinc-900/5">
                            {product.stock_on_hand > 0 ? `${product.stock_on_hand} in stock` : 'Out of stock'}
                          </span>
                        </div>
                      </div>
                      
                      <div className="flex flex-1 flex-col p-5">
                        <div className="mb-2 flex items-center justify-between">
                          <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{product.sku}</div>
                        </div>
                        
                        <h3 className="mb-4 min-h-[2.5rem] line-clamp-2 text-sm font-bold leading-tight text-zinc-900 transition-colors group-hover:text-amber-600">
                          {product.name}
                        </h3>
                        
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
