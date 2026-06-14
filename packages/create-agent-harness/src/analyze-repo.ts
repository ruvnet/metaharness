// SPDX-License-Identifier: MIT
//
// `harness analyze-repo [path]` — the Node-side counterpart to the Studio's
// Repo → Harness importer (ADR-023/026). It inventories a LOCAL repo, builds a
// deterministic profile, scores archetypes, and emits repo-profile.json +
// harness-plan.json (optionally scaffolding from the plan).
//
// Embeddings are OPT-IN (`--embed`) via @ruvector/ruvllm — a local, offline,
// deterministic embedder loaded through createRequire (its native CJS build),
// with a transparent lexical fallback when the optional dependency or its
// binary is absent. Same invariant as the browser: embeddings recommend, rules
// generate, tests prove parity. No repository code is ever executed; only
// high-signal text files are read.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { scaffold, type Host } from './index.js';
import { validateHarnessName } from './renderer.js';

// --- types -----------------------------------------------------------------

export interface RepoProfile {
  name: string;
  languages: string[];
  hasMcp: boolean;
  hasClaude: boolean;
  hasCodex: boolean;
  hasCi: boolean;
  buildCommands: string[];
  testCommands: string[];
  tokens: string[];
}

export interface PolicyProfile {
  defaultDeny: boolean;
  allowNetwork: boolean;
  allowShell: boolean;
  allowFileWrite: boolean;
  requireApprovalForDangerous: boolean;
  toolTimeoutMs: number;
  maxToolCallsPerTurn: number;
  auditLog: boolean;
}

export interface Archetype {
  id: string;
  label: string;
  description: string;
  requiredLang?: 'rust' | 'typescript' | 'python' | 'go';
  requiredSignal?: 'hasMcp';
  keywords: string[];
  manifestHints: string[];
  template: string;
  agents: string[];
  skills: string[];
  commands: string[];
  mcp: 'off' | 'local' | 'remote';
}

export interface HarnessPlan {
  name: string;
  hosts: Host[];
  template: string;
  archetypeId: string;
  confidence: number;
  engine: 'lexical' | 'ruvllm';
  agents: string[];
  skills: string[];
  commands: string[];
  mcp: 'off' | 'local' | 'remote';
  policy: PolicyProfile;
  riskProfile: string;
  suggestedCommands: { command: string; trust: 'inferred'; execution: 'disabled' }[];
}

const SAFE: PolicyProfile = {
  defaultDeny: true,
  allowNetwork: false,
  allowShell: false,
  allowFileWrite: false,
  requireApprovalForDangerous: true,
  toolTimeoutMs: 30_000,
  maxToolCallsPerTurn: 8,
  auditLog: true,
};

// --- archetype library (mirrors apps/web-ui/src/generator/repo.ts) ---------

export const ARCHETYPES: Archetype[] = [
  { id: 'ai-agent-framework-harness', label: 'AI agent framework', description: 'multi agent orchestration framework swarm planner worker tools llm', keywords: ['agent', 'agents', 'mcp', 'llm', 'orchestration', 'swarm', 'tool', 'autonomous'], manifestHints: ['@modelcontextprotocol', 'openai', 'anthropic', 'langchain'], template: 'vertical:agentics', agents: ['orchestrator', 'planner', 'worker', 'critic'], skills: ['run-swarm', 'memory-inspect'], commands: ['doctor'], mcp: 'local' },
  { id: 'mcp-server-harness', label: 'MCP server', description: 'mcp server tools protocol json rpc stdio streamable http resources prompts', requiredSignal: 'hasMcp', keywords: ['mcp', 'tool', 'server', 'protocol', 'stdio', 'resource', 'prompt'], manifestHints: ['@modelcontextprotocol', 'mcp'], template: 'vertical:coding', agents: ['reviewer', 'test-writer'], skills: ['plan-change'], commands: ['doctor', 'review-diff'], mcp: 'remote' },
  { id: 'rust-crate-harness', label: 'Rust crate', description: 'rust crate cargo wasm systems performance library', requiredLang: 'rust', keywords: ['rust', 'cargo', 'crate', 'wasm', 'no_std', 'clippy'], manifestHints: ['[package]', '[dependencies]', 'edition'], template: 'vertical:coding', agents: ['architect', 'implementer', 'reviewer', 'test-writer'], skills: ['plan-change'], commands: ['doctor', 'review-diff'], mcp: 'local' },
  { id: 'typescript-sdk-harness', label: 'TypeScript SDK', description: 'typescript javascript sdk npm package library node esm', requiredLang: 'typescript', keywords: ['typescript', 'sdk', 'npm', 'node', 'library', 'api', 'client'], manifestHints: ['typescript', 'tsc', 'vitest', 'jest'], template: 'vertical:coding', agents: ['architect', 'implementer', 'reviewer', 'test-writer'], skills: ['plan-change'], commands: ['doctor', 'review-diff'], mcp: 'local' },
  { id: 'data-pipeline-harness', label: 'Data / ML pipeline', description: 'data pipeline machine learning training model evaluation dataset python', requiredLang: 'python', keywords: ['data', 'ml', 'model', 'training', 'dataset', 'pipeline', 'pandas', 'torch', 'sklearn'], manifestHints: ['numpy', 'pandas', 'torch', 'scikit', 'tensorflow'], template: 'vertical:ai', agents: ['data-curator', 'trainer', 'evaluator', 'deployer'], skills: ['eval-report'], commands: ['doctor'], mcp: 'local' },
  { id: 'research-harness', label: 'Research / docs', description: 'research documentation knowledge synthesis citations literature review', keywords: ['research', 'docs', 'documentation', 'paper', 'knowledge', 'citation', 'wiki'], manifestHints: ['mkdocs', 'docusaurus', 'sphinx'], template: 'vertical:research', agents: ['scout', 'synthesizer', 'fact-checker', 'citer'], skills: [], commands: ['doctor'], mcp: 'local' },
  { id: 'devops-harness', label: 'DevOps / infra', description: 'devops infrastructure kubernetes terraform ci incident on call deploy', keywords: ['devops', 'kubernetes', 'k8s', 'terraform', 'docker', 'ci', 'deploy', 'infra', 'helm'], manifestHints: ['dockerfile', 'helm', 'terraform'], template: 'vertical:devops', agents: ['responder', 'runbook-runner', 'escalator', 'postmortem'], skills: [], commands: ['doctor'], mcp: 'local' },
  { id: 'consulting-harness', label: 'Business / consulting', description: 'business strategy consulting product analytics metrics roadmap operations', keywords: ['business', 'strategy', 'product', 'analytics', 'metrics', 'roadmap', 'consulting'], manifestHints: [], template: 'vertical:business', agents: ['analyst', 'strategist', 'ops-coordinator'], skills: [], commands: ['doctor'], mcp: 'local' },
];

// --- file inventory (safe, analysis-only) ----------------------------------

const HIGH_SIGNAL = ['README.md', 'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'CONTRIBUTING.md', '.mcp.json'];
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'target', 'build', 'coverage', '.next', '.cache', 'vendor']);

/** Read high-signal files + cheap structural probes. Never reads arbitrary source. */
export function inventory(dir: string): Record<string, string> {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  for (const name of HIGH_SIGNAL) {
    const p = join(root, name);
    if (existsSync(p)) {
      try {
        files[name] = readFileSync(p, 'utf-8');
      } catch {
        /* unreadable — skip */
      }
    }
  }
  if (existsSync(join(root, '.github', 'workflows'))) files['.github/workflows/ci.yml'] = '# present';
  if (existsSync(join(root, '.claude'))) files['.claude/settings.json'] = '{}';
  if (existsSync(join(root, '.codex'))) files['.codex/config.toml'] = '';
  // Cheap top-level dir scan so structure signals work without deep walks.
  try {
    for (const e of readdirSync(root)) {
      if (IGNORE_DIRS.has(e)) continue;
      if (e === 'crates' || e === 'docs') files[`${e}/`] = 'dir';
    }
  } catch {
    /* ignore */
  }
  return files;
}

// --- profiling (pure) ------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'are', 'you', 'our', 'use', 'using', 'from', 'into', 'has']);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9+#./_-]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

export function analyzeFiles(name: string, files: Record<string, string>): RepoProfile {
  const get = (p: string) => files[p] ?? '';
  const languages: string[] = [];
  if (get('Cargo.toml')) languages.push('rust');
  if (get('package.json')) languages.push('typescript');
  if (get('pyproject.toml') || get('requirements.txt')) languages.push('python');
  if (get('go.mod')) languages.push('go');

  const buildCommands: string[] = [];
  const testCommands: string[] = [];
  try {
    const pkg = get('package.json') ? JSON.parse(get('package.json')) : null;
    if (pkg?.scripts?.build) buildCommands.push('npm run build');
    if (pkg?.scripts?.test) testCommands.push('npm test');
  } catch {
    /* malformed manifest */
  }
  if (languages.includes('rust')) {
    buildCommands.push('cargo build');
    testCommands.push('cargo test');
  }
  if (languages.includes('python')) testCommands.push('pytest');
  if (languages.includes('go')) testCommands.push('go test ./...');

  const text = [get('README.md'), get('package.json'), get('Cargo.toml'), get('pyproject.toml'), get('CONTRIBUTING.md')].join('\n');
  return {
    name,
    languages,
    hasMcp: !!get('.mcp.json') || /modelcontextprotocol|mcp server/i.test(text),
    hasClaude: !!files['.claude/settings.json'] || /claude/i.test(text),
    hasCodex: !!files['.codex/config.toml'] || /codex/i.test(text),
    hasCi: !!files['.github/workflows/ci.yml'] || /github actions|workflow/i.test(text),
    buildCommands,
    testCommands,
    tokens: tokenize(text),
  };
}

// --- scoring (pure) --------------------------------------------------------

function overlap(tokens: string[], keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const set = new Set(tokens);
  return keywords.filter((k) => set.has(k)).length / keywords.length;
}

function eligible(profile: RepoProfile, a: Archetype): boolean {
  if (a.requiredLang && !profile.languages.includes(a.requiredLang)) return false;
  if (a.requiredSignal === 'hasMcp' && !profile.hasMcp) return false;
  return true;
}

export interface Scored {
  archetype: Archetype;
  score: number;
  confidence: number;
}

export function scoreArchetypes(profile: RepoProfile, semantic?: Record<string, number>): Scored[] {
  const manifestText = profile.tokens.join(' ');
  return ARCHETYPES.map((a) => {
    const sem = semantic ? (semantic[a.id] ?? 0) : overlap(profile.tokens, a.keywords);
    const manifest = a.manifestHints.length ? a.manifestHints.filter((h) => manifestText.includes(h.toLowerCase())).length / a.manifestHints.length : 0;
    const ci = profile.hasCi && (a.template === 'vertical:devops' || a.commands.includes('review-diff')) ? 1 : profile.hasCi ? 0.4 : 0;
    const structure = Math.min(1, (profile.hasClaude ? 0.34 : 0) + (profile.hasMcp && a.id === 'mcp-server-harness' ? 0.5 : 0) + (profile.languages.length ? 0.33 : 0));
    const intent = a.requiredLang && profile.languages.includes(a.requiredLang) ? 1 : 0;
    const raw = 0.45 * sem + 0.25 * manifest + 0.15 * ci + 0.1 * structure + 0.05 * intent;
    const score = eligible(profile, a) ? raw : raw * 0.25;
    return { archetype: a, score, confidence: Math.round(Math.min(0.99, score) * 100) / 100 };
  }).sort((x, y) => y.score - x.score);
}

function describeRisk(p: PolicyProfile): string {
  return [p.allowShell ? 'shell ON' : 'shell gated', p.allowNetwork ? 'network ON' : 'network gated', p.allowFileWrite ? 'file-write ON' : 'file-write read-scoped'].join(', ');
}

function kebab(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
}

export function recommendPlan(profile: RepoProfile, semantic?: Record<string, number>): HarnessPlan {
  const ranked = scoreArchetypes(profile, semantic);
  const top = ranked[0]!;
  const a = top.archetype;
  const hosts: Host[] = ['claude-code'];
  if (profile.hasCodex) hosts.push('codex');
  return {
    name: kebab(`${profile.name}-harness`),
    hosts,
    template: a.template,
    archetypeId: a.id,
    confidence: top.confidence,
    engine: semantic ? 'ruvllm' : 'lexical',
    agents: a.agents,
    skills: a.skills,
    commands: a.commands,
    mcp: a.mcp,
    policy: SAFE,
    riskProfile: describeRisk(SAFE),
    suggestedCommands: [...profile.buildCommands, ...profile.testCommands].map((command) => ({ command, trust: 'inferred' as const, execution: 'disabled' as const })),
  };
}

// --- embeddings (opt-in, @ruvector/ruvllm, deterministic, offline) ---------

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Compute per-archetype semantic scores with @ruvector/ruvllm. Returns
 * undefined (→ lexical fallback) if the optional dependency or its native build
 * is unavailable. Deterministic: ruvllm.embed() is a pure function of its text.
 */
export function ruvllmSemantic(profile: RepoProfile): Record<string, number> | undefined {
  try {
    const require = createRequire(import.meta.url);
    // ruvllm's ESM entry has extensionless imports node can't resolve; load CJS.
    const mod = require('@ruvector/ruvllm');
    const RuvLLM = mod.RuvLLM ?? mod.default?.RuvLLM;
    if (!RuvLLM) return undefined;
    const llm = new RuvLLM({ embeddingDim: 384 });
    const qText = [profile.name, profile.languages.join(' '), profile.tokens.join(' ')].join(' ').slice(0, 4000);
    const q = Array.from(llm.embed(qText) as number[]);
    const out: Record<string, number> = {};
    for (const a of ARCHETYPES) {
      const v = Array.from(llm.embed(`${a.label}. ${a.description} ${a.keywords.join(' ')}`) as number[]);
      out[a.id] = round3(Math.max(0, Math.min(1, cosine(q, v))));
    }
    return out;
  } catch {
    return undefined;
  }
}

// --- CLI command -----------------------------------------------------------

export async function analyzeRepoCmd(args: string[]): Promise<{ code: number; lines: string[] }> {
  let dir = '.';
  let embed = false;
  let outDir: string | null = null;
  let json = false;
  let scaffoldName: string | null = null;
  let host: Host = 'claude-code';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--embed') embed = true;
    else if (a === '--json') json = true;
    else if (a === '--out') outDir = args[++i] ?? null;
    else if (a === '--scaffold') scaffoldName = args[++i] ?? null;
    else if (a === '--host') host = (args[++i] ?? 'claude-code') as Host;
    else if (a && !a.startsWith('-')) dir = a;
  }
  const root = resolve(dir);
  const lines: string[] = [`harness analyze-repo — ${root}`, ''];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { code: 1, lines: [`Not a directory: ${root}`] };
  }

  const files = inventory(root);
  const profile = analyzeFiles(basename(root), files);
  const semantic = embed ? ruvllmSemantic(profile) : undefined;
  const usedEmbed = embed && !!semantic;
  const plan = recommendPlan(profile, semantic);

  const out = resolve(outDir ?? root);
  const profilePath = join(out, 'repo-profile.json');
  const planPath = join(out, 'harness-plan.json');
  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf-8');

  if (json) {
    return { code: 0, lines: [JSON.stringify({ profile, plan }, null, 2)] };
  }

  lines.push(`Languages: ${profile.languages.join(', ') || '(none detected)'}`);
  lines.push(`Signals: ${[profile.hasMcp && 'mcp', profile.hasClaude && 'claude', profile.hasCodex && 'codex', profile.hasCi && 'ci'].filter(Boolean).join(', ') || 'none'}`);
  lines.push('');
  lines.push(`Best archetype: ${plan.archetypeId}  (${Math.round(plan.confidence * 100)}% · ${usedEmbed ? 'ruvllm embeddings' : 'lexical'})`);
  if (embed && !semantic) lines.push('  (note: --embed requested but @ruvector/ruvllm unavailable — used lexical)');
  lines.push(`Harness:  ${plan.name}  ·  template ${plan.template}  ·  hosts ${plan.hosts.join(', ')}`);
  lines.push(`MCP: ${plan.mcp}  ·  risk: ${plan.riskProfile}`);
  lines.push(`Agents:   ${plan.agents.join(', ')}`);
  lines.push(`Commands: ${plan.commands.join(', ')}`);
  if (plan.suggestedCommands.length) {
    lines.push('Suggested commands (execution disabled, never run):');
    for (const c of plan.suggestedCommands) lines.push(`  - ${c.command}  [trust: ${c.trust}]`);
  }
  lines.push('');
  lines.push(`Wrote: ${profilePath}`);
  lines.push(`Wrote: ${planPath}`);

  if (scaffoldName) {
    const nameCheck = validateHarnessName(scaffoldName);
    if (!nameCheck.valid) {
      lines.push('', `Cannot scaffold: ${nameCheck.reason}`);
      return { code: 1, lines };
    }
    // Scaffold next to the analysis output (--out, default: the analyzed repo).
    const target = join(out, scaffoldName);
    const r = await scaffold({ name: scaffoldName, template: plan.template, host, targetDir: target, description: `Harness for ${profile.name}`, generatorVersion: '0.1.0' });
    lines.push('', `Scaffolded ${scaffoldName} (${r.paths.length} files) from the plan into ${target}`);
  } else {
    lines.push('', `Scaffold it:  harness analyze-repo ${dir} --scaffold ${plan.name}`);
  }

  return { code: 0, lines };
}
