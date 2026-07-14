'use client';

import { Minus, Plus, Trash2, X } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { useState } from 'react';

type CartLine = {
  quantity: number;
  product: { id: number; name: string; sku: string; your_price_ex_vat: number | null };
};

type Cart = { lines: CartLine[]; itemCount: number; subtotalExVat: number };

export function CartDrawer({ cart, open, onClose, onChange }: {
  cart: Cart;
  open: boolean;
  onClose: () => void;
  onChange: (cart: Cart) => void;
}) {
  const [quoteMessage, setQuoteMessage] = useState('');
  const [creatingQuote, setCreatingQuote] = useState(false);
  async function update(productId: number, quantity?: number) {
    const response = await fetch(quantity ? '/api/cart' : `/api/cart?productId=${productId}`, {
      method: quantity ? 'PATCH' : 'DELETE',
      headers: quantity ? { 'Content-Type': 'application/json' } : undefined,
      body: quantity ? JSON.stringify({ productId, quantity }) : undefined,
    });
    if (response.ok) onChange(await response.json());
  }

  async function createQuote() {
    setCreatingQuote(true);
    setQuoteMessage('');
    try {
      const response = await fetch('/api/quotes', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to create draft quote');
      onChange(data.cart);
      setQuoteMessage(data.quoteNumber ? `Draft quote ${data.quoteNumber} has been created in Xero.` : 'Draft quote has been created in Xero.');
    } catch (error) {
      setQuoteMessage(error instanceof Error ? error.message : 'Unable to create draft quote');
    } finally { setCreatingQuote(false); }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Shopping cart">
      <button aria-label="Close cart" onClick={onClose} className="absolute inset-0 bg-zinc-950/30" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-4">
          <div><h2 className="text-lg font-bold">Cart</h2><p className="text-xs text-zinc-500">Prices exclude VAT</p></div>
          <button aria-label="Close cart" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-md hover:bg-zinc-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {cart.lines.length === 0 ? <p className="text-sm text-zinc-500">Your cart is empty.</p> : <div className="space-y-4">
            {cart.lines.map(({ product, quantity }) => <div key={product.id} className="border-b border-zinc-100 pb-4">
              <p className="text-xs font-semibold text-zinc-400">{product.sku}</p>
              <p className="mt-1 text-sm font-semibold">{product.name}</p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center rounded-md border border-zinc-200">
                  <button onClick={() => quantity === 1 ? update(product.id) : update(product.id, quantity - 1)} className="grid h-8 w-8 place-items-center" aria-label="Decrease quantity"><Minus className="h-3 w-3" /></button>
                  <span className="w-8 text-center text-sm font-semibold">{quantity}</span>
                  <button onClick={() => update(product.id, quantity + 1)} className="grid h-8 w-8 place-items-center" aria-label="Increase quantity"><Plus className="h-3 w-3" /></button>
                </div>
                <div className="text-right text-sm font-bold">{product.your_price_ex_vat === null ? 'POA' : formatCurrency(product.your_price_ex_vat * quantity)}</div>
                <button onClick={() => update(product.id)} className="grid h-8 w-8 place-items-center text-zinc-500 hover:text-red-700" aria-label="Remove from cart"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>)}
          </div>}
        </div>
        <div className="border-t border-zinc-200 p-5">
          <div className="flex items-center justify-between text-sm"><span className="font-semibold">Subtotal excl. VAT</span><span className="text-lg font-black text-amber-600">{formatCurrency(cart.subtotalExVat)}</span></div>
          {quoteMessage && <p className="mt-3 text-xs font-medium text-zinc-700">{quoteMessage}</p>}
          <button disabled={cart.lines.length === 0 || creatingQuote} onClick={createQuote} className="mt-4 h-10 w-full rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-zinc-300">
            {creatingQuote ? 'Creating draft quote...' : 'Create draft quote'}
          </button>
          <p className="mt-2 text-xs text-zinc-500">This creates a draft quote in Xero. Your cart is kept if Xero rejects the request.</p>
        </div>
      </aside>
    </div>
  );
}
