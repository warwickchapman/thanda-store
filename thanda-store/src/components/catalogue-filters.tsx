'use client';

import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

export type SelectedFilters = Record<string, string[]>;
type Props = {
  categories: Array<{ category: string; label: string; count: number }>;
  category: string;
  onCategory: (category: string) => void;
  facets: Array<{ key: string; label: string; options: Array<{ value: string; count: number }> }>;
  selected: SelectedFilters;
  onSelected: (filters: SelectedFilters) => void;
  availabilityOptions: Array<{ key: string; label: string; count: number }>;
  availability: string[];
  onAvailability: (values: string[]) => void;
  resultCount: number;
};

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function CatalogueFilters(props: Props) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const totalFilters = Object.values(props.selected).flat().length + props.availability.length;

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const triggerElement = trigger.current;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      desktop.removeEventListener('change', closeOnDesktop);
      triggerElement?.focus();
    };
  }, [open]);

  const panel = () => (
    <div className="space-y-6">
      <nav aria-label="Product categories" className="max-h-80 space-y-1 overflow-y-auto pr-1">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-zinc-500">Categories</h3>
        {props.categories.map(({ category, label, count }) => (
          <button key={category} type="button" aria-pressed={props.category === category}
            onClick={() => props.onCategory(category)}
            className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm ${props.category === category ? 'bg-amber-50 font-semibold text-amber-800' : 'text-zinc-600 hover:bg-zinc-100'}`}>
            <span>{label}</span><span className="tabular-nums text-xs">{count}</span>
          </button>
        ))}
      </nav>
      <fieldset className="min-w-0 space-y-2 border-t border-zinc-200 pt-4">
        <legend className="pt-4 text-sm font-semibold">Availability</legend>
        {props.availabilityOptions.map(({ key, label, count }) => (
          <label key={key} className="flex cursor-pointer items-center gap-2 py-1 pr-3 text-sm text-zinc-700">
            <input type="checkbox" className="h-4 w-4 accent-amber-600" checked={props.availability.includes(key)}
              onChange={() => props.onAvailability(toggle(props.availability, key))} />
            <span className="flex-1">{label}</span><span className="min-w-[3ch] shrink-0 text-right text-xs tabular-nums text-zinc-500">{count}</span>
          </label>
        ))}
      </fieldset>
      {props.facets.map(({ key, label, options }) => (
        <fieldset key={key} className="min-w-0 space-y-2 border-t border-zinc-200 pt-4">
          <legend className="pt-4 text-sm font-semibold">{label}</legend>
          {options.map(({ value, count }) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 py-1 pr-3 text-sm text-zinc-700">
              <input type="checkbox" className="h-4 w-4 accent-amber-600" checked={(props.selected[key] || []).includes(value)}
                onChange={() => props.onSelected({ ...props.selected, [key]: toggle(props.selected[key] || [], value) })} />
              <span className="flex-1">{value}</span><span className="min-w-[3ch] shrink-0 text-right text-xs tabular-nums text-zinc-500">{count}</span>
            </label>
          ))}
        </fieldset>
      ))}
      {totalFilters > 0 && <button type="button" onClick={() => { props.onSelected({}); props.onAvailability([]); }}
        className="text-sm font-semibold text-amber-800 underline underline-offset-4">Clear filters</button>}
    </div>
  );

  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold lg:hidden">
        <SlidersHorizontal className="h-4 w-4" /> Categories &amp; filters{totalFilters > 0 ? ` (${totalFilters})` : ''}
      </button>
      <aside className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 lg:block">
        {panel()}
      </aside>
      <dialog ref={dialog} aria-labelledby="catalogue-filter-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        className="fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-[min(90vw,24rem)] max-w-none bg-white p-0 text-zinc-900 backdrop:bg-black/40">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-zinc-200 p-4">
            <h2 id="catalogue-filter-title" className="font-bold">Categories &amp; filters</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close categories and filters" className="rounded-lg p-2 hover:bg-zinc-100"><X className="h-5 w-5" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{panel()}</div>
          <div className="border-t border-zinc-200 p-4">
            <button type="button" onClick={() => setOpen(false)} className="w-full rounded-lg bg-zinc-900 p-3 text-sm font-semibold text-white">
              Show {props.resultCount} {props.resultCount === 1 ? 'product' : 'products'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
