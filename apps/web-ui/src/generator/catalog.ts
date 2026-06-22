// SPDX-License-Identifier: MIT
//
// The pickable catalog: hosts + the templates / agents / skills / commands a
// harness author can compose. The templates and the agent/skill/command pools
// are GENERATED from the canonical source of truth
// (packages/create-agent-harness/templates/catalog.def.mjs) via
// `npm run gen:templates`, so the UI never drifts from what the CLI scaffolds
// or what the Rust template-catalog crate validates. Only HOSTS and the small
// lookup helpers are hand-maintained here.

import type { CatalogItem, HostInfo, TemplateInfo } from './types';
import { GEN_AGENTS, GEN_COMMANDS, GEN_SKILLS, GEN_TEMPLATES } from '../generated/catalog';

export const HOSTS: HostInfo[] = [
  { id: 'claude-code', name: 'Claude Code', shape: 'MCP + 5-handler hooks + 3-scope settings', color: '#D97757' },
  { id: 'codex', name: 'OpenAI Codex', shape: 'MCP via ~/.codex/config.toml tables', color: '#412991' },
  { id: 'pi-dev', name: 'pi.dev', shape: 'Pi extension — pi.registerTool() (no MCP)', color: '#8b5cf6' },
  { id: 'hermes', name: 'Hermes Agent', shape: 'MCP runtime + <think> scrubbing', color: '#06b6d4' },
  { id: 'openclaw', name: 'OpenClaw', shape: 'MCP via ~/.openclaw/openclaw.json + skills', color: '#ef4444' },
  { id: 'rvm', name: 'RVM', shape: 'Bare-metal microhypervisor + witness', color: '#64748b' },
  // iter 127 — ADR-032
  { id: 'copilot', name: 'GitHub Copilot', shape: 'MCP via .vscode/mcp.json (VSCode 1.99+)', color: '#1f883d' },
  // iter 128 — ADR-036
  { id: 'opencode', name: 'OpenCode', shape: 'MCP via .opencode/opencode.json (sst/opencode)', color: '#f59e0b' },
  // iter 147 — ADR-033 (first non-interactive host)
  { id: 'github-actions', name: 'GitHub Actions', shape: 'CI/CD — .github/workflows + composite action.yml', color: '#2088ff' },
];

export const TEMPLATES: TemplateInfo[] = GEN_TEMPLATES;
export const AGENTS: CatalogItem[] = GEN_AGENTS;
export const SKILLS: CatalogItem[] = GEN_SKILLS;
export const COMMANDS: CatalogItem[] = GEN_COMMANDS;

/** Templates grouped by their gallery category, in first-seen order. */
export function templatesByCategory(): { category: string; templates: TemplateInfo[] }[] {
  const groups: { category: string; templates: TemplateInfo[] }[] = [];
  for (const t of TEMPLATES) {
    let g = groups.find((x) => x.category === t.category);
    if (!g) {
      g = { category: t.category, templates: [] };
      groups.push(g);
    }
    g.templates.push(t);
  }
  return groups;
}

export const CATALOG_BY_KIND = {
  agent: AGENTS,
  skill: SKILLS,
  command: COMMANDS,
} as const;

/**
 * Group a kind's catalog into categories for the searchable Compose picker.
 * Catalog items don't carry a category, so we derive one: an item's category is
 * the gallery category of the FIRST template (in catalog order) whose defaults
 * include it. Items used by no template fall under "General". Returns groups in
 * first-seen order, each with its items sorted by name.
 */
export function groupedCatalog(
  kind: 'agent' | 'skill' | 'command',
): { category: string; items: CatalogItem[] }[] {
  const field = kind === 'agent' ? 'defaultAgents' : kind === 'skill' ? 'defaultSkills' : 'defaultCommands';
  const catOf = new Map<string, string>();
  for (const t of TEMPLATES) {
    for (const id of (t[field] as string[]) ?? []) {
      if (!catOf.has(id)) catOf.set(id, t.category);
    }
  }
  const order: string[] = [];
  const byCat = new Map<string, CatalogItem[]>();
  for (const it of CATALOG_BY_KIND[kind]) {
    const cat = catOf.get(it.id) ?? 'General';
    if (!byCat.has(cat)) { byCat.set(cat, []); order.push(cat); }
    byCat.get(cat)!.push(it);
  }
  // "General" sinks to the end if present.
  order.sort((a, b) => (a === 'General' ? 1 : 0) - (b === 'General' ? 1 : 0));
  return order.map((category) => ({
    category,
    items: byCat.get(category)!.slice().sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export function findItem(kind: 'agent' | 'skill' | 'command', id: string): CatalogItem | undefined {
  return CATALOG_BY_KIND[kind].find((i) => i.id === id);
}

export function findTemplate(id: string): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
