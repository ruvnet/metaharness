// SPDX-License-Identifier: MIT
//
// Repo → Harness importer (ADR-023). Paste a GitHub URL; get a recommended,
// editable harness plan; emit a deterministic scaffold.
//
// INVARIANT: embeddings recommend, rules generate, tests prove parity. This
// module is the *rule-based* core and is intentionally PURE and deterministic:
// `analyzeFiles()` and `recommendPlan()` take data in and return data out with
// no I/O, so the same repo at the same commit yields the same plan and the same
// zip bytes. A local sentence-embedding pass (Transformers.js / MiniLM) can
// later refine the `semantic` term of the score without changing this contract;
// today that term is a transparent lexical-overlap proxy.
//
// No repository code is ever executed. We read manifests, docs, CI, and host
// configs only, and we emit suggested commands at an inferred trust level —
// never auto-trusted, never run.

import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY } from './types';
import type { HarnessConfig, HostId, McpMode, McpPolicy } from './types';
import { findTemplate } from './catalog';
import { toKebabCase } from './render';

/** The high-signal files we ask the browser/CLI to fetch. Cheap, public, safe. */
export const HIGH_SIGNAL_FILES = [
  'README.md',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'CONTRIBUTING.md',
  '.mcp.json',
];

export interface RepoInput {
  owner: string;
  repo: string;
  /** Map of path -> text content for whatever high-signal files were fetched. */
  files: Record<string, string>;
}

export interface RepoProfile {
  name: string;
  languages: string[];
  hasMcp: boolean;
  hasClaude: boolean;
  hasCodex: boolean;
  hasCi: boolean;
  buildCommands: string[];
  testCommands: string[];
  /** Lowercased token set drawn from README + manifests (for lexical scoring). */
  tokens: string[];
}

export interface PolicyProfile {
  mcp: McpMode;
  policy: McpPolicy;
}

export interface Archetype {
  id: string;
  label: string;
  description: string;
  /** Signals that must be present for this archetype to be eligible. */
  requiredSignals: Array<keyof RepoProfile | 'lang:rust' | 'lang:typescript' | 'lang:python' | 'lang:go'>;
  /** Keywords used for the lexical "semantic" overlap term. */
  keywords: string[];
  /** Manifest tokens that boost the manifest term. */
  manifestHints: string[];
  template: string;
  agents: string[];
  skills: string[];
  commands: string[];
  policy: PolicyProfile;
}

export interface ScoredArchetype {
  archetype: Archetype;
  score: number;
  confidence: number;
  breakdown: { semantic: number; manifest: number; ci: number; structure: number; intent: number };
}

export interface HarnessPlan {
  name: string;
  hosts: HostId[];
  template: string;
  archetypeId: string;
  confidence: number;
  agents: string[];
  skills: string[];
  commands: string[];
  mcp: McpMode;
  policy: McpPolicy;
  riskProfile: string;
  suggestedCommands: { command: string; trust: 'inferred' | 'unknown'; execution: 'disabled' }[];
}

// --- archetype library -----------------------------------------------------

const SAFE: McpPolicy = SAFE_MCP_POLICY;

export const ARCHETYPES: Archetype[] = [
  {
    id: 'ai-agent-framework-harness',
    label: 'AI agent framework',
    description: 'multi agent orchestration framework swarm planner worker tools llm',
    requiredSignals: [],
    keywords: ['agent', 'agents', 'mcp', 'llm', 'orchestration', 'swarm', 'tool', 'autonomous'],
    manifestHints: ['@modelcontextprotocol', 'openai', 'anthropic', 'langchain'],
    template: 'vertical:agentics',
    agents: ['orchestrator', 'planner', 'worker', 'critic'],
    skills: ['run-swarm', 'memory-inspect'],
    commands: ['doctor'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'mcp-server-harness',
    label: 'MCP server',
    description: 'mcp server tools protocol json rpc stdio streamable http resources prompts',
    requiredSignals: ['hasMcp'],
    keywords: ['mcp', 'tool', 'server', 'protocol', 'stdio', 'resource', 'prompt'],
    manifestHints: ['@modelcontextprotocol', 'mcp'],
    template: 'vertical:coding',
    agents: ['reviewer', 'test-writer'],
    skills: ['plan-change'],
    commands: ['doctor', 'review-diff'],
    policy: { mcp: 'remote', policy: SAFE },
  },
  {
    id: 'rust-crate-harness',
    label: 'Rust crate',
    description: 'rust crate cargo wasm systems performance library',
    requiredSignals: ['lang:rust'],
    keywords: ['rust', 'cargo', 'crate', 'wasm', 'no_std', 'clippy'],
    manifestHints: ['[package]', '[dependencies]', 'edition'],
    template: 'vertical:coding',
    agents: ['architect', 'implementer', 'reviewer', 'test-writer'],
    skills: ['plan-change'],
    commands: ['doctor', 'review-diff'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'typescript-sdk-harness',
    label: 'TypeScript SDK',
    description: 'typescript javascript sdk npm package library node esm',
    requiredSignals: ['lang:typescript'],
    keywords: ['typescript', 'sdk', 'npm', 'node', 'library', 'api', 'client'],
    manifestHints: ['typescript', 'tsc', 'vitest', 'jest'],
    template: 'vertical:coding',
    agents: ['architect', 'implementer', 'reviewer', 'test-writer'],
    skills: ['plan-change'],
    commands: ['doctor', 'review-diff'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'data-pipeline-harness',
    label: 'Data / ML pipeline',
    description: 'data pipeline machine learning training model evaluation dataset python',
    requiredSignals: ['lang:python'],
    keywords: ['data', 'ml', 'model', 'training', 'dataset', 'pipeline', 'pandas', 'torch', 'sklearn'],
    manifestHints: ['numpy', 'pandas', 'torch', 'scikit', 'tensorflow'],
    template: 'vertical:ai',
    agents: ['data-curator', 'trainer', 'evaluator', 'deployer'],
    skills: ['eval-report'],
    commands: ['doctor'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'research-harness',
    label: 'Research / docs',
    description: 'research documentation knowledge synthesis citations literature review',
    requiredSignals: [],
    keywords: ['research', 'docs', 'documentation', 'paper', 'knowledge', 'citation', 'wiki'],
    manifestHints: ['mkdocs', 'docusaurus', 'sphinx'],
    template: 'vertical:research',
    agents: ['scout', 'synthesizer', 'fact-checker', 'citer'],
    skills: [],
    commands: ['doctor'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'devops-harness',
    label: 'DevOps / infra',
    description: 'devops infrastructure kubernetes terraform ci incident on call deploy',
    requiredSignals: [],
    keywords: ['devops', 'kubernetes', 'k8s', 'terraform', 'docker', 'ci', 'deploy', 'infra', 'helm'],
    manifestHints: ['dockerfile', 'helm', 'terraform'],
    template: 'vertical:devops',
    agents: ['responder', 'runbook-runner', 'escalator', 'postmortem'],
    skills: [],
    commands: ['doctor'],
    policy: { mcp: 'local', policy: SAFE },
  },
  {
    id: 'consulting-harness',
    label: 'Business / consulting',
    description: 'business strategy consulting product analytics metrics roadmap operations',
    requiredSignals: [],
    keywords: ['business', 'strategy', 'product', 'analytics', 'metrics', 'roadmap', 'consulting'],
    manifestHints: [],
    template: 'vertical:business',
    agents: ['analyst', 'strategist', 'ops-coordinator'],
    skills: [],
    commands: ['doctor'],
    policy: { mcp: 'local', policy: SAFE },
  },
];

// --- analysis (pure) -------------------------------------------------------

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .replace(/\.git$/, '')
    .match(/github\.com[/:]([^/\s]+)\/([^/\s?#]+)/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'are', 'you', 'our', 'use', 'using', 'from', 'into', 'has']);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#./_-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

export function analyzeFiles(input: RepoInput): RepoProfile {
  const f = input.files;
  const get = (p: string) => f[p] ?? '';
  const languages: string[] = [];
  if (get('Cargo.toml')) languages.push('rust');
  if (get('package.json')) languages.push('typescript');
  if (get('pyproject.toml') || get('requirements.txt')) languages.push('python');
  if (get('go.mod')) languages.push('go');

  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  // package.json scripts are the most reliable command source.
  try {
    const pkg = get('package.json') ? JSON.parse(get('package.json')) : null;
    if (pkg?.scripts?.build) buildCommands.push('npm run build');
    if (pkg?.scripts?.test) testCommands.push('npm test');
  } catch {
    /* malformed manifest — ignore */
  }
  if (languages.includes('rust')) {
    buildCommands.push('cargo build');
    testCommands.push('cargo test');
  }
  if (languages.includes('python')) testCommands.push('pytest');
  if (languages.includes('go')) testCommands.push('go test ./...');

  const text = [get('README.md'), get('package.json'), get('Cargo.toml'), get('pyproject.toml'), get('CONTRIBUTING.md')].join('\n');
  const tokens = tokenize(text);

  return {
    name: input.repo,
    languages,
    hasMcp: !!get('.mcp.json') || /modelcontextprotocol|mcp server/i.test(text),
    hasClaude: Object.keys(f).some((k) => k.startsWith('.claude')) || /claude/i.test(text),
    hasCodex: Object.keys(f).some((k) => k.startsWith('.codex')) || /codex/i.test(text),
    hasCi: Object.keys(f).some((k) => k.includes('.github/workflows')) || /github actions|workflow/i.test(text),
    buildCommands,
    testCommands,
    tokens,
  };
}

function signalPresent(p: RepoProfile, sig: Archetype['requiredSignals'][number]): boolean {
  if (sig.startsWith('lang:')) return p.languages.includes(sig.slice('lang:'.length));
  return !!(p as unknown as Record<string, unknown>)[sig];
}

function overlap(tokens: string[], keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const set = new Set(tokens);
  const hits = keywords.filter((k) => set.has(k)).length;
  return hits / keywords.length;
}

/**
 * Score every archetype with the auditable weighted formula. Deterministic.
 *
 * `semantic` lets an embedding pass (Transformers.js MiniLM, embeddings.ts)
 * supply the semantic term as a per-archetype map. When omitted, a transparent
 * lexical keyword-overlap proxy is used — the deterministic default that needs
 * no model download. Either way generation stays rule-based.
 */
export function scoreArchetypes(profile: RepoProfile, semanticScores?: Record<string, number>): ScoredArchetype[] {
  const manifestText = profile.tokens.join(' ');
  const scored = ARCHETYPES.map((a) => {
    const eligible = a.requiredSignals.every((s) => signalPresent(profile, s));
    const semantic = semanticScores ? (semanticScores[a.id] ?? 0) : overlap(profile.tokens, a.keywords);
    const manifest = a.manifestHints.length
      ? a.manifestHints.filter((h) => manifestText.includes(h.toLowerCase())).length / a.manifestHints.length
      : 0;
    const ci = profile.hasCi && (a.template === 'vertical:devops' || a.commands.includes('review-diff')) ? 1 : profile.hasCi ? 0.4 : 0;
    const structure =
      (profile.hasClaude ? 0.34 : 0) + (profile.hasMcp && a.id === 'mcp-server-harness' ? 0.5 : 0) + (profile.languages.length ? 0.33 : 0);
    const intent = a.requiredSignals.some((s) => s.startsWith('lang:')) && a.requiredSignals.every((s) => signalPresent(profile, s)) ? 1 : 0;
    const raw = 0.45 * semantic + 0.25 * manifest + 0.15 * ci + 0.1 * Math.min(1, structure) + 0.05 * intent;
    const score = eligible ? raw : raw * 0.25; // ineligible archetypes are heavily penalised, not excluded
    return { archetype: a, score, confidence: Math.round(Math.min(0.99, score) * 100) / 100, breakdown: { semantic, manifest, ci, structure: Math.min(1, structure), intent } };
  });
  return scored.sort((x, y) => y.score - x.score);
}

// --- recommendation (pure) -------------------------------------------------

export function recommendPlan(profile: RepoProfile, semanticScores?: Record<string, number>): HarnessPlan {
  const ranked = scoreArchetypes(profile, semanticScores);
  const top = ranked[0]!;
  const a = top.archetype;

  const hosts: HostId[] = ['claude-code'];
  if (profile.hasCodex) hosts.push('codex');

  const suggested = [...profile.buildCommands, ...profile.testCommands].map((command) => ({
    command,
    trust: 'inferred' as const,
    execution: 'disabled' as const,
  }));

  return {
    name: toKebabCase(`${profile.name}-harness`),
    hosts,
    template: a.template,
    archetypeId: a.id,
    confidence: top.confidence,
    agents: a.agents,
    skills: a.skills,
    commands: a.commands,
    mcp: a.policy.mcp,
    policy: a.policy.policy,
    riskProfile: describeRisk(a.policy.policy),
    suggestedCommands: suggested,
  };
}

function describeRisk(p: McpPolicy): string {
  const parts = [
    p.allowShell ? 'shell ON' : 'shell gated',
    p.allowNetwork ? 'network ON' : 'network gated',
    p.allowFileWrite ? 'file-write ON' : 'file-write read-scoped',
  ];
  return parts.join(', ');
}

/** Materialise a plan into a full, editable HarnessConfig. */
export function planToConfig(plan: HarnessPlan): HarnessConfig {
  const tmpl = findTemplate(plan.template);
  return {
    name: plan.name,
    description: tmpl?.harnessDesc ?? `Agent harness for ${plan.name}`,
    hosts: plan.hosts,
    template: plan.template,
    memory: 'agentdb',
    routing: '3-tier',
    marketplace: 'powered-by',
    agents: plan.agents,
    skills: plan.skills,
    commands: plan.commands,
    primitives: { ...DEFAULT_PRIMITIVES, mcp: plan.mcp },
    mcpPolicy: plan.policy,
  };
}

/** Convenience end-to-end (pure): files -> plan. */
export function planFromFiles(input: RepoInput): { profile: RepoProfile; plan: HarnessPlan; ranked: ScoredArchetype[] } {
  const profile = analyzeFiles(input);
  return { profile, plan: recommendPlan(profile), ranked: scoreArchetypes(profile) };
}
