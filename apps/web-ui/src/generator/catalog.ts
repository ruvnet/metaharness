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

export function findItem(kind: 'agent' | 'skill' | 'command', id: string): CatalogItem | undefined {
  return CATALOG_BY_KIND[kind].find((i) => i.id === id);
}

export function findTemplate(id: string): TemplateInfo | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
