// SPDX-License-Identifier: MIT
// ADR-171: searchable, category-grouped multi-select for the Compose card.
// Replaces the flat chip wall (~67 agents) with a filter box + collapsible
// categories (derived from the templates). Pure client-side, no new deps.
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { Chip } from './ui';
import { groupedCatalog } from '../generator';
import type { CatalogItem } from '../generator';

export function CatalogPicker({
  label,
  kind,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  kind: 'agent' | 'skill' | 'command';
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupedCatalog(kind), [kind]);

  const needle = q.trim().toLowerCase();
  const match = (it: CatalogItem) =>
    !needle ||
    it.name.toLowerCase().includes(needle) ||
    it.id.toLowerCase().includes(needle) ||
    (it.description ?? '').toLowerCase().includes(needle);

  const visible = groups
    .map((g) => ({ category: g.category, items: g.items.filter(match) }))
    .filter((g) => g.items.length > 0);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const shown = visible.reduce((n, g) => n + g.items.length, 0);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="field-label">
          {label} <span className="text-slate-500">· {selected.length} selected</span>
        </div>
        {selected.length > 0 && (
          <button type="button" className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1" onClick={onClear}>
            <X size={12} /> clear
          </button>
        )}
      </div>

      <div className="relative mt-1">
        <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          className="input pl-7"
          placeholder={`Search ${total} ${label.toLowerCase()}…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={`Search ${label}`}
        />
        {needle && <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500">{shown}/{total}</span>}
      </div>

      <div className="mt-2 space-y-2">
        {visible.length === 0 && <div className="text-xs text-slate-500 px-1 py-2">No {label.toLowerCase()} match “{q}”.</div>}
        {visible.map((g) => {
          // When searching, force-expand; otherwise honor the collapse toggle.
          const isCollapsed = !needle && collapsed[g.category];
          const selCount = g.items.filter((it) => selected.includes(it.id)).length;
          return (
            <div key={g.category} className="rounded-lg border border-slate-800/60">
              <button
                type="button"
                className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
                onClick={() => setCollapsed((c) => ({ ...c, [g.category]: !c[g.category] }))}
                aria-expanded={!isCollapsed}
              >
                <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  {g.category} <span className="text-slate-600">({g.items.length}{selCount ? `, ${selCount}✓` : ''})</span>
                </span>
                {isCollapsed ? <ChevronRight size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
              </button>
              {!isCollapsed && (
                <div className="flex flex-wrap gap-2 px-2.5 pb-2.5">
                  {g.items.map((it) => (
                    <Chip key={it.id} title={it.description} active={selected.includes(it.id)} onClick={() => onToggle(it.id)}>
                      {it.name}
                    </Chip>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
