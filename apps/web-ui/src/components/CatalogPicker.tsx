// SPDX-License-Identifier: MIT
// ADR-171: collapsible, category-grouped, searchable multi-select for Compose.
// Each picker (Agents/Skills/Commands) collapses to a one-line header + a summary
// of selected chips; expand to search across collapsible categories (derived from
// the templates). Categories start collapsed and auto-expand while searching.
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, X } from 'lucide-react';
import { Chip } from './ui';
import { groupedCatalog, findItem } from '../generator';
import type { CatalogItem } from '../generator';

export function CatalogPicker({
  label,
  kind,
  selected,
  onToggle,
  onClear,
  defaultOpen = false,
}: {
  label: string;
  kind: 'agent' | 'skill' | 'command';
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupedCatalog(kind), [kind]);
  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  const needle = q.trim().toLowerCase();
  const match = (it: CatalogItem) =>
    !needle ||
    it.name.toLowerCase().includes(needle) ||
    it.id.toLowerCase().includes(needle) ||
    (it.description ?? '').toLowerCase().includes(needle);

  const visible = groups
    .map((g) => ({ category: g.category, items: g.items.filter(match) }))
    .filter((g) => g.items.length > 0);
  const shown = visible.reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="rounded-lg border border-slate-800/60">
      {/* Header — always visible; the collapse handle. */}
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-sm font-medium text-slate-200">
          {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
          {label}
          <span className="text-xs font-normal text-slate-500">
            {selected.length ? `${selected.length} selected` : `${total} available`}
          </span>
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className="text-xs text-slate-400 hover:text-slate-200 inline-flex items-center gap-1"
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onClear(); } }}
          >
            <X size={12} /> clear
          </span>
        )}
      </button>

      {/* Collapsed summary: show what's selected without expanding. */}
      {!open && selected.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pb-2.5">
          {selected.map((id) => {
            const it = findItem(kind, id);
            return (
              <Chip key={id} title={it?.description} active onClick={() => onToggle(id)}>
                {it?.name ?? id}
              </Chip>
            );
          })}
        </div>
      )}

      {/* Expanded: search + collapsible categories. */}
      {open && (
        <div className="px-3 pb-3">
          <div className="relative">
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

          <div className="mt-2 space-y-1.5">
            {visible.length === 0 && <div className="px-1 py-2 text-xs text-slate-500">No {label.toLowerCase()} match “{q}”.</div>}
            {visible.map((g) => {
              const selCount = g.items.filter((it) => selected.includes(it.id)).length;
              // Auto-expand while searching or if the category holds a selection.
              const isOpen = !!needle || expanded[g.category] || selCount > 0;
              return (
                <div key={g.category} className="rounded-md border border-slate-800/40">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-2.5 py-1.5 text-left"
                    onClick={() => setExpanded((c) => ({ ...c, [g.category]: !isOpen }))}
                    aria-expanded={isOpen}
                  >
                    <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                      {g.category} <span className="text-slate-600">({g.items.length}{selCount ? `, ${selCount}✓` : ''})</span>
                    </span>
                    {isOpen ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                  </button>
                  {isOpen && (
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
      )}
    </div>
  );
}
