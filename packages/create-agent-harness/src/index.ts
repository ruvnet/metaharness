// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { walkTemplate, asFileMap } from './walker.js';
import { writeAtomic } from './writer.js';
import { emptyManifest, fingerprintFiles, sha256 } from './manifest.js';
import { validateHarnessName } from './renderer.js';
import { hostConfigFiles } from './host-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Templates live at packages/create-agent-harness/templates/, one level above dist/.
const TEMPLATES_ROOT = resolve(__dirname, '..', 'templates');

/**
 * Resolve `@metaharness/kernel`'s version at scaffold time so we can stamp it into
 * `manifest.meta.kernel_version` (ADR-027 diagnostic). Falls through three
 * lookup paths because the create-agent-harness package can run:
 *   - from a workspace checkout (`packages/kernel-js/package.json`)
 *   - from an installed npm tree (resolve `@metaharness/kernel/package.json`)
 *   - from the prebuilt dist with neither sibling (fall back to 'unknown')
 *
 * We never throw — a missing kernel version downgrades the meta block to
 * `kernel_version: undefined`, which `harness doctor` already handles as
 * a WARN line. The CLI must keep generating harnesses even if the local
 * kernel install is broken.
 */
function resolveKernelVersion(): string | undefined {
  const candidates = [
    // Workspace layout: packages/create-agent-harness/dist/ → ../../kernel-js/package.json
    resolve(__dirname, '..', '..', 'kernel-js', 'package.json'),
    // Installed layout: sibling node_modules/@metaharness/kernel/package.json
    resolve(__dirname, '..', '..', '@metaharness', 'kernel', 'package.json'),
    // Fallback: top-level node_modules
    resolve(__dirname, '..', '..', '..', '@metaharness', 'kernel', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string };
        // Guard: only trust a package.json that IS the kernel. Without this,
        // an ambiguous candidate path can resolve to the CLI's own
        // package.json (e.g. metaharness), leaking the CLI version into
        // manifest.meta.kernel_version and producing a phantom skew in
        // `harness diag` (iter 149 fix).
        if (pkg.name && pkg.name !== '@metaharness/kernel') continue;
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      }
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

const KERNEL_VERSION = resolveKernelVersion();

// iter 127 added copilot (ADR-032); iter 128 added opencode (ADR-036);
// iter 147 added github-actions (ADR-033, the first non-interactive host);
// prime-agent added per ADR-247 (skills-based, no MCP).
// HOSTS is the canonical 10-host catalog.
export const HOSTS = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm', 'copilot', 'opencode', 'github-actions', 'prime-agent'] as const;
export type Host = (typeof HOSTS)[number];

export const TEMPLATES = [
  'minimal',
  'vertical:devops',
  'vertical:support',
  'vertical:trading',
  'vertical:legal',
  'vertical:research',
  'vertical:coding',
  'vertical:business',
  'vertical:crm',
  'vertical:marketing',
  'vertical:advertising',
  'vertical:ai',
  'vertical:agentics',
  'vertical:ruview',
  'vertical:health',
  'vertical:education',  // iter 80 (milestone)
  'vertical:sales',      // iter 87
  'vertical:gaming',     // iter 96
  'vertical:repo-maintainer',  // iter 113 — best viral demo (user roadmap)
  'vertical:exotic',
] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export interface CatalogEntry {
  id: string;
  category: string;
  name: string;
  domain: string;
  description: string;
  quickStart: string;
  tags: string[];
  generate: boolean;
  agentCount: number;
  skillCount: number;
  commandCount: number;
}

/** Read the canonical template catalog shipped at templates/catalog.json. */
export function loadCatalog(): CatalogEntry[] {
  const p = join(TEMPLATES_ROOT, 'catalog.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { templates?: CatalogEntry[] };
    return parsed.templates ?? [];
  } catch {
    return [];
  }
}

/** Render the catalog as a human-readable table for `--list`. */
export function formatCatalog(entries: CatalogEntry[]): string[] {
  const lines: string[] = ['Available templates:', ''];
  let category = '';
  for (const e of entries) {
    if (e.category !== category) {
      category = e.category;
      lines.push(`  ${category}`);
    }
    const counts = `${e.agentCount}a/${e.skillCount}s/${e.commandCount}c`;
    lines.push(`    ${e.id.padEnd(22)} ${counts.padEnd(10)} ${e.quickStart}`);
  }
  lines.push('', `Scaffold with: metaharness <name> --template <id>`);
  return lines;
}

export interface CliArgs {
  name?: string;
  template?: string;
  templatePackage?: string;
  hosts?: string[];
  yes?: boolean;
  force?: boolean;
  description?: string;
  target?: string;
  fromExisting?: string;
  list?: boolean;
  wizard?: boolean;
  withWasm?: string;
  /** ADR-147: include Darwin Mode self-improvement (default on; --no-darwin to skip). */
  darwin?: boolean;
  /** ADR-246 §2.3: include the recoverable-session log scaffold (default OFF; --sessions to enable). */
  sessions?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--template' || a === '-t') {
      out.template = argv[++i];
    } else if (a === '--template-package') {
      out.templatePackage = argv[++i];
    } else if (a === '--host' || a === '-h') {
      const v = argv[++i];
      // GH #10: accept repeated --host AND comma-separated (--host a,b).
      if (v) for (const h of v.split(',').map(s => s.trim()).filter(Boolean)) (out.hosts ??= []).push(h);
    } else if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (a === '--force' || a === '-f') {
      out.force = true;
    } else if (a === '--darwin') {
      out.darwin = true;
    } else if (a === '--no-darwin') {
      out.darwin = false;
    } else if (a === '--sessions') {
      out.sessions = true;
    } else if (a === '--no-sessions') {
      out.sessions = false;
    } else if (a === '--description' || a === '-d') {
      out.description = argv[++i];
    } else if (a === '--target') {
      // GH issue #9: `--target <path>` writes the harness AT <path> (was
      // silently ignored; scaffold always landed in $CWD/<name>).
      out.target = argv[++i];
    } else if (a === '--with-wasm') {
      // GH #25: build a project's own wasm-pack crate into the harness as
      // loadable capability commands.
      out.withWasm = argv[++i];
    } else if (a === '--from-existing') {
      out.fromExisting = argv[++i] ?? process.cwd();
    } else if (a === '--list' || a === '--templates') {
      out.list = true;
    } else if (a === '--wizard' || a === '-w') {
      // iter 100: opt-in interactive flow. Off by default so CI scripts
      // calling no-args keep getting the usage message instead of hanging.
      out.wizard = true;
    } else if (!a.startsWith('-') && !out.name) {
      out.name = a;
    }
  }
  return out;
}

/**
 * Resolve a template id to its on-disk directory. The "minimal" template
 * lives at templates/minimal; vertical templates use ":" as the separator
 * in their id and "_" as the on-disk separator (e.g. vertical:devops ->
 * templates/vertical_devops).
 */
export function templateDir(id: string): string {
  // CodeQL #2 (incomplete string escaping): use a global replace so EVERY
  // ':' is encoded, not just the first. Template ids only carry one colon
  // today (vertical:devops), but a single-occurrence replace is a latent
  // path-mapping bug if an id ever carries two.
  return join(TEMPLATES_ROOT, id.replace(/:/g, '_'));
}

export interface ScaffoldOptions {
  name: string;
  template: string;
  /** Primary host — drives the template ({{host}}, bin/init imports). */
  host: Host;
  /**
   * GH #10: full host set for a multi-host harness. Defaults to [host]. The
   * primary (host) drives the template; every host's native config + npm dep is
   * emitted, and manifest.hosts records the full set.
   */
  hosts?: Host[];
  description?: string;
  targetDir: string;
  force?: boolean;
  generatorVersion: string;
  /**
   * ADR-147: deep-integrate Darwin Mode (@metaharness/darwin) — the generated
   * harness gets `npm run evolve` (+ dry-run), a real `evolve` skill wired to
   * the darwin CLI, and the dependency. Default ON; opt out with `--no-darwin`.
   */
  darwin?: boolean;
  /**
   * ADR-246 §2.3: emit a crash-recoverable, forkable session log scaffold
   * (`src/sessions/log.ts`, dependency-free copy-in). Default OFF — sessions
   * are an *optional* primitive per the ADR; opt in with `--sessions`.
   */
  sessions?: boolean;
}

/** ADR-147: the darwin version a scaffolded harness depends on. */
const DARWIN_VERSION = '^0.8.0';

/** ADR-147: the real `evolve` skill emitted into every darwin-integrated harness. */
function darwinEvolveSkill(name: string): string {
  return `---
name: evolve
description: "Evolve this harness with Darwin Mode — frozen model, evolving harness (real, sandboxed, safety-gated)."
---

# evolve — Darwin Mode self-improvement

\`${name}\` ships with **Darwin Mode** (\`@metaharness/darwin\`, ADR-070…146): the model
is frozen; the *harness* evolves. Each generation mutates ONE of the 7 surface files
(planner, contextBuilder, reviewer, retry/tool/memory/score policy), sandboxes each
child, scores it, and keeps only variants that *measurably* improve — building an
archive of successful descendants.

## Run it

\`\`\`bash
npm run evolve        # real substrate: runs your test command per variant (deterministic mutator — no API key, no network)
npm run evolve:dry    # mock substrate: fast, fully offline, no test execution
\`\`\`

Or directly:

\`\`\`bash
npx metaharness-darwin evolve . --sandbox real --generations 3 --children 4
\`\`\`

## Safety (secure by default)

- **Deterministic mutator** is the default — **no network, no API key, air-gapped**.
- Every mutation passes the \`validateGeneratedCode\` gate: no new imports, network,
  filesystem, shell, env access, or dependencies — pure refactor/tuning only.
- Mutations run in a **sandbox**; only variants that pass your tests are archived.
- Nothing is promoted without measured improvement (guard against Goodharting).

See \`@metaharness/darwin\` for selection strategies (\`--selection\`, \`--crossover\`,
\`--curriculum\`), statistical gates (\`--fdr\`, \`--bench\`), and the real-LLM mutator (library API).

## What the benchmarks taught us (measured, full SWE-bench Lite 300)

Defaults worth carrying into how you evolve and run this harness (full evidence + CIs in
\`@metaharness/darwin\`'s \`LEARNINGS.md\` / \`bench/results/RESULTS.md\`):

1. **Closed-loop repair is the #1 lever (~2×).** Feeding test/compiler failure back and retrying took
   resolve-rate 7.7% → 15.3% on the *same cheap model*. Iterate against ground truth, don't single-shot.
2. **Cheap-first + cost-aware routing.** Track **$/resolve**, not just resolve-rate; a cheap model
   resolved 31× cheaper per fix than a frontier one. Reserve frontier for *measured* capability gaps.
3. **Tier the models (Barbarian & Scholar).** Cheap sweep + frontier on *only the residual* = 33.3%
   at ~6× lower cost than running frontier everywhere.
4. **Put the output-format contract in a system message + example**, and size prompts to the model's
   real context window — this alone took a weak local model from 0% to ~50% valid output.
5. **Only trust batch evaluation of the final artifact** — in-loop counters drift 1.5–5×.
6. **The harness multiplies the model; it can't rescue one below the task's reasoning floor.** Pick
   the smallest model *above* the floor, then let evolution do the rest.
`;
}

/**
 * ADR-246 §2.3: the copy-in recoverable-session log emitted with --sessions.
 * Deliberately self-contained: node builtins only, NO @metaharness/kernel
 * import, so the generated harness owns the file outright. The wire format
 * and hash fold match packages/kernel-js/src/session.ts byte-for-byte.
 * Emitted code avoids template literals so this template string stays simple.
 */
function sessionsLogTemplate(): string {
  return `// SPDX-License-Identifier: MIT
//
// Recoverable session log — copy-in scaffold from ADR-246 §2.3
// (metaharness docs/adrs/ADR-246-prime-agent-continual-harness-refine.md).
// Self-contained: node builtins only, no @metaharness/kernel dependency.
//
// Append-only JSONL: one event per line, per-branch 0-based monotonic
// indexes; a forked branch's first event carries parent {branch, index}.
// Wire key order is EXACTLY index, branch, parent, kind, payload (parent
// omitted when absent).
//
// State-hash fold (mirrors @metaharness/kernel SessionLog exactly):
//   hexPrev = ''; for each lineage event (root -> tip):
//     hexPrev = lowercaseHex(sha256(utf8(hexPrev + canonicalJson(event))))
// where canonicalJson is recursively key-sorted (UTF-8 byte order),
// whitespace-free JSON.
//
// Session state lives wherever you point the constructor (suggested:
// .harness/sessions/<id>.jsonl). Prune old logs by deleting files.

import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface SessionEvent {
  index: number;
  branch: string;
  parent?: { branch: string; index: number };
  kind: string;
  payload: unknown;
}

// Keys sort by UTF-8 BYTE order (not UTF-16 code-unit order, which default
// .sort() uses) to match the Rust mirror's byte-wise &str ordering.
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).filter(k => rec[k] !== undefined)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(rec[k])).join(',') + '}';
}

// A raw unpaired surrogate — not valid UTF-8; a Rust mirror (serde_json)
// cannot parse it, so both append and read reject it.
const LONE_SURROGATE =
  /(?:[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF])/;
// Well-formed JSON.stringify renders a lone surrogate as a \\udXXX escape
// (paired surrogates pass through raw), preceded by an even backslash run.
const LONE_SURROGATE_ESCAPE = /(?<=(?:^|[^\\\\])(?:\\\\\\\\)*)\\\\u[dD][89abAB]/;

// Read-path check on DECODED data (string values AND object keys): a valid
// \\udXXX pair decodes to an astral character, a lone surrogate stays lone.
function containsLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return LONE_SURROGATE.test(v);
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(containsLoneSurrogate);
  return Object.entries(v).some(([k, val]) => LONE_SURROGATE.test(k) || containsLoneSurrogate(val));
}

function serialize(e: SessionEvent): string {
  return JSON.stringify(e.parent === undefined
    ? { index: e.index, branch: e.branch, kind: e.kind, payload: e.payload }
    : { index: e.index, branch: e.branch,
        parent: { branch: e.parent.branch, index: e.parent.index },
        kind: e.kind, payload: e.payload });
}

export class SessionLog {
  private events: SessionEvent[] = [];
  private nextIndex = new Map<string, number>();
  private branchParent = new Map<string, { branch: string; index: number }>();
  private rootBranch: string;

  constructor(readonly path: string, readonly branch: string = 'main') {
    this.rootBranch = branch;
  }

  /** Resume: read + validate the JSONL log; throws on the first error. */
  static async open(path: string, branch = 'main'): Promise<SessionLog> {
    const log = new SessionLog(path, branch);
    if (!existsSync(path)) return log;
    const raw = await readFile(path, 'utf-8');
    const errors = log.load(raw);
    if (errors.length > 0) throw new Error(errors[0]);
    return log;
  }

  private load(raw: string): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    const lines = raw.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === '') continue; // blank/whitespace-only separators (still counted for line numbers)
      const n = i + 1;
      let e: SessionEvent;
      try { e = JSON.parse(lines[i]!); } catch {
        errors.push('session: line ' + n + ': corrupted line (invalid JSON)'); continue;
      }
      // Mirror serde_json's accept/reject: a lone surrogate decoded from a
      // \\udXXX escape is not representable as UTF-8, so reject the line.
      if (containsLoneSurrogate(e)) {
        errors.push('session: line ' + n + ': corrupted line (contains an unpaired surrogate, not valid UTF-8)'); continue;
      }
      if (typeof e?.index !== 'number' || typeof e?.branch !== 'string' || typeof e?.kind !== 'string' ||
          (e.parent !== undefined && (typeof e.parent !== 'object' || e.parent === null ||
            typeof e.parent.branch !== 'string' || typeof e.parent.index !== 'number'))) {
        errors.push('session: line ' + n + ': corrupted line (not a valid session event)'); continue;
      }
      const key = e.branch + '\\u0000' + e.index;
      if (seen.has(key)) { errors.push('session: line ' + n + ': duplicate event (' + e.branch + ', ' + e.index + ')'); continue; }
      const expected = this.nextIndex.get(e.branch) ?? 0;
      if (e.index !== expected) {
        errors.push('session: line ' + n + ': branch "' + e.branch + '" index ' + e.index + ' is not monotonic (expected ' + expected + ')');
        // Resync like the Rust mirror: after reporting index X, expect X+1
        // next, so a single gap yields exactly ONE error, not a cascade.
        seen.add(key);
        this.nextIndex.set(e.branch, e.index + 1);
        continue;
      }
      if (expected === 0) {
        if (this.events.length === 0) {
          // Root branch (first branch in the file) must not carry a parent.
          this.rootBranch = e.branch;
          if (e.parent !== undefined) {
            errors.push("session: line " + n + ": root branch '" + e.branch + "' must not carry a parent"); continue;
          }
        } else {
          if (!e.parent) { errors.push('session: line ' + n + ': first event of branch "' + e.branch + '" must carry a parent reference'); continue; }
          if (!seen.has(e.parent.branch + '\\u0000' + e.parent.index)) {
            errors.push('session: line ' + n + ': parent (' + e.parent.branch + ', ' + e.parent.index + ') does not exist'); continue;
          }
          this.branchParent.set(e.branch, e.parent);
        }
      }
      seen.add(key);
      this.events.push(e);
      this.nextIndex.set(e.branch, expected + 1);
    }
    return errors;
  }

  /** Append an event on the active branch (next monotonic index). The first
   * event of a forked branch carries the fork's parent ref. */
  async append(kind: string, payload: unknown,
      opts?: { parent?: { branch: string; index: number } }): Promise<SessionEvent> {
    const index = this.nextIndex.get(this.branch) ?? 0;
    const parent = opts?.parent;
    const isRoot = this.events.length === 0 || this.branch === this.rootBranch;
    if (index === 0 && !isRoot && parent === undefined) {
      throw new Error('session: first event of branch "' + this.branch + '" must carry a parent reference');
    }
    const event: SessionEvent = parent === undefined
      ? { index, branch: this.branch, kind, payload }
      : { index, branch: this.branch, parent, kind, payload };
    const line = serialize(event);
    // Reject events a Rust mirror cannot parse: a lone surrogate is not
    // valid UTF-8 (raw form), and serde_json also rejects its escaped form.
    if (LONE_SURROGATE.test(line) || LONE_SURROGATE_ESCAPE.test(line)) {
      throw new Error('session: event contains an unpaired surrogate (not valid UTF-8)');
    }
    await appendFile(this.path, line + '\\n', 'utf-8');
    if (this.events.length === 0) this.rootBranch = this.branch;
    if (index === 0 && parent !== undefined) this.branchParent.set(this.branch, parent);
    this.events.push(event);
    this.nextIndex.set(this.branch, index + 1);
    return event;
  }

  /** Fork at atIndex on the active branch: a sibling log over the same file.
   * Immediately appends the new branch's synthetic first event: index 0,
   * parent {branch: this.branch, index: atIndex}, kind 'fork', payload null. */
  async fork(atIndex: number, newBranch: string): Promise<SessionLog> {
    const count = this.nextIndex.get(this.branch) ?? 0;
    if (atIndex < 0 || atIndex >= count) throw new Error('session: cannot fork at index ' + atIndex);
    if ((this.nextIndex.get(newBranch) ?? 0) > 0 || newBranch === this.branch) {
      throw new Error('session: branch "' + newBranch + '" already exists');
    }
    const log = new SessionLog(this.path, newBranch);
    log.events = this.events; log.nextIndex = this.nextIndex; log.branchParent = this.branchParent;
    log.rootBranch = this.rootBranch;
    await log.append('fork', null, { parent: { branch: this.branch, index: atIndex } });
    return log;
  }

  private lineage(branch: string): SessionEvent[] {
    const own = this.events.filter(e => e.branch === branch).sort((a, b) => a.index - b.index);
    const p = this.branchParent.get(branch);
    if (!p) return own;
    return [...this.lineage(p.branch).filter(e => e.branch !== p.branch || e.index <= p.index), ...own];
  }

  /** Lowercase-hex state hash of the branch lineage ('' when empty). */
  stateHash(branch: string = this.branch): string {
    let hexPrev = '';
    for (const e of this.lineage(branch)) {
      hexPrev = createHash('sha256').update(hexPrev + canonicalJson(e), 'utf-8').digest('hex');
    }
    return hexPrev;
  }

  /** Deterministic replay: lineage event count + integrity hash. */
  replay(branch: string = this.branch): { eventCount: number; stateHash: string } {
    return { eventCount: this.lineage(branch).length, stateHash: this.stateHash(branch) };
  }

  /** Re-read the file and report all validation errors (empty = valid). */
  async validate(): Promise<string[]> {
    if (!existsSync(this.path)) return [];
    return new SessionLog(this.path, this.branch).load(await readFile(this.path, 'utf-8'));
  }
}
`;
}

export interface ScaffoldResult {
  paths: string[];
  manifestPath: string;
  unresolved: string[];
}

/**
 * Run the full scaffold pipeline:
 *   1. Validate the name
 *   2. Walk the template dir + render
 *   3. Compute fingerprints
 *   4. Build .harness/manifest.json
 *   5. Atomically write everything to targetDir
 *
 * Returns the list of paths written + the manifest path + any unresolved
 * template variables (should be empty for a clean run).
 */

/** Standard MIT license text for a scaffolded harness (GH #23). */
function mitLicense(name: string): string {
  const year = new Date().getFullYear();
  return `MIT License

Copyright (c) ${year} ${name} authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const nameCheck = validateHarnessName(opts.name);
  if (!nameCheck.valid) {
    throw new Error(`invalid harness name: ${nameCheck.reason}`);
  }
  const dir = templateDir(opts.template);
  if (!existsSync(dir)) {
    throw new Error(`unknown template: ${opts.template} (expected at ${dir})`);
  }

  const vars = {
    name: opts.name,
    description: opts.description ?? 'My AI agent harness',
    host: opts.host,
  };
  let rendered = await walkTemplate(dir, vars, { strict: false });

  // GH #10: a harness may target multiple hosts. The primary (opts.host) drives
  // the claude-shaped template; every host in the set gets its native config
  // overlaid + its npm dep added + recorded in manifest.hosts.
  const allHosts = (opts.hosts && opts.hosts.length ? opts.hosts : [opts.host]);
  const hostSet = Array.from(new Set(allHosts));

  // GH #11: the templates always emit Claude-Code files. When claude-code is
  // NOT among the selected hosts, drop the Claude-Code-specific runtime config
  // (`.claude/settings.json` + `.claude-plugin/**`) so an rvm/hermes/… harness
  // isn't littered with Claude noise. CLAUDE.md + skills/commands stay (they're
  // useful cross-host instructions).
  if (!hostSet.includes('claude-code' as Host)) {
    rendered = rendered.filter(r =>
      r.path !== '.claude/settings.json' && !r.path.startsWith('.claude-plugin/'));
  }

  // ADR-045 + GH #10: emit EVERY selected host's native config.
  for (const h of hostSet) {
    for (const f of hostConfigFiles(h, { name: opts.name, description: vars.description, mcp: 'local' })) {
      if (rendered.some(r => r.path === f.path)) continue; // never clobber a template/earlier file
      rendered.push({ path: f.path, content: f.content, rendered: false, unresolved: [] });
    }
  }

  // GH #10: add an npm dep for every selected host (the template only declares
  // the primary {{host}}). Edit the rendered package.json in place.
  if (hostSet.length > 1) {
    const pkgIdx = rendered.findIndex(r => r.path === 'package.json');
    if (pkgIdx !== -1) {
      try {
        const pkg = JSON.parse(rendered[pkgIdx]!.content);
        pkg.dependencies = pkg.dependencies || {};
        for (const h of hostSet) {
          const dep = `@metaharness/host-${h}`;
          if (!pkg.dependencies[dep]) pkg.dependencies[dep] = '^0.1.1';
        }
        rendered[pkgIdx]!.content = JSON.stringify(pkg, null, 2) + '\n';
      } catch { /* leave package.json untouched if it doesn't parse */ }
    }
  }

  // GH #23: every scaffold must carry a license. The bin/cli.js template already
  // ships an `SPDX-License-Identifier: MIT` header and package.json `files`
  // lists "LICENSE", but neither the `license` field nor the LICENSE file were
  // emitted — so `npm publish` warned and the published package showed
  // "license: undefined". Inject both here, single-sourced for every template.
  {
    const pkgIdx = rendered.findIndex(r => r.path === 'package.json');
    if (pkgIdx !== -1) {
      try {
        const pkg = JSON.parse(rendered[pkgIdx]!.content) as Record<string, unknown>;
        if (!pkg.license) {
          // place `license` right after `description` for conventional ordering
          const ordered: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(pkg)) {
            ordered[k] = v;
            if (k === 'description') ordered.license = 'MIT';
          }
          if (!ordered.license) ordered.license = 'MIT';
          rendered[pkgIdx]!.content = JSON.stringify(ordered, null, 2) + '\n';
        }
      } catch { /* leave package.json untouched if it doesn't parse */ }
    }
  }
  if (!rendered.some(r => r.path === 'LICENSE')) {
    rendered.push({ path: 'LICENSE', content: mitLicense(opts.name), rendered: false, unresolved: [] });
  }

  // ADR-147: deep-integrate Darwin Mode. Default ON (opt out with --no-darwin).
  // Adds the @metaharness/darwin devDependency + `evolve`/`evolve:dry` scripts to
  // the generated package.json, and emits a real `evolve` skill wired to the darwin
  // CLI. Secure by default: the darwin CLI uses the DETERMINISTIC mutator (no network,
  // no API key) behind the validateGeneratedCode safety gate + sandbox.
  if (opts.darwin !== false) {
    const pkgIdx = rendered.findIndex(r => r.path === 'package.json');
    if (pkgIdx !== -1) {
      try {
        const pkg = JSON.parse(rendered[pkgIdx]!.content) as Record<string, any>;
        pkg.devDependencies = pkg.devDependencies || {};
        if (!pkg.devDependencies['@metaharness/darwin']) pkg.devDependencies['@metaharness/darwin'] = DARWIN_VERSION;
        pkg.scripts = pkg.scripts || {};
        if (!pkg.scripts.evolve) pkg.scripts.evolve = 'metaharness-darwin evolve . --sandbox real --generations 3 --children 4';
        if (!pkg.scripts['evolve:dry']) pkg.scripts['evolve:dry'] = 'metaharness-darwin evolve . --sandbox mock --generations 2 --children 3';
        rendered[pkgIdx]!.content = JSON.stringify(pkg, null, 2) + '\n';
      } catch { /* leave package.json untouched if it doesn't parse */ }
    }
    // Emit the real darwin-wired evolve skill (overwrites any template stub).
    const skillPath = '.claude/skills/evolve/SKILL.md';
    const skillIdx = rendered.findIndex(r => r.path === skillPath);
    const skill = { path: skillPath, content: darwinEvolveSkill(opts.name), rendered: false, unresolved: [] };
    if (skillIdx !== -1) rendered[skillIdx] = skill; else rendered.push(skill);
  }

  // ADR-246 §2.3: recoverable-session scaffold. Default OFF (opt in with
  // --sessions) — the ADR ships sessions as an *optional* primitive, unlike
  // darwin's default-on. The emitted src/sessions/log.ts is a dependency-free
  // copy-in (no @metaharness/kernel import); session state is host-agnostic
  // scaffold code, NOT host config, so host-config.ts is deliberately
  // untouched.
  //
  // ADR-027 asymmetric-feature note: --sessions is CLI-only this pass; the
  // web-ui surface intentionally does NOT mirror this toggle yet. If/when it
  // does, the manifest `surface` field distinguishes the emitters.
  if (opts.sessions === true) {
    const logPath = 'src/sessions/log.ts';
    if (!rendered.some(r => r.path === logPath)) {
      rendered.push({ path: logPath, content: sessionsLogTemplate(), rendered: false, unresolved: [] });
    }
    // Append a sessions note to the generated README (best-effort, darwin-style
    // error swallowing: a README that isn't there or isn't text just skips).
    const readmeIdx = rendered.findIndex(r => r.path === 'README.md');
    if (readmeIdx !== -1) {
      try {
        let readme = rendered[readmeIdx]!.content;
        while (readme.endsWith('\n')) readme = readme.slice(0, -1);
        rendered[readmeIdx]!.content = readme + '\n' +
          `\n## Recoverable sessions (ADR-246 §2.3)\n\n` +
          `This harness includes \`src/sessions/log.ts\` — a crash-recoverable, forkable\n` +
          `JSONL session log (append-only events, deterministic replay, integrity state\n` +
          `hash). Session state lives where you point the log (suggested:\n` +
          `\`.harness/sessions/<id>.jsonl\`); prune by deleting old files.\n`;
      } catch { /* leave README untouched if the note can't be appended */ }
    }
  }

  const fileMap = asFileMap(rendered);

  // iter 58: stamp kernel_version at scaffold time (ADR-027 diagnostic).
  // surface defaults to 'cli' inside emptyManifest; we override only
  // kernel_version here so the web-UI port can still set surface='web-ui'.
  const manifest = emptyManifest(opts.template, opts.generatorVersion, {
    meta: KERNEL_VERSION ? { kernel_version: KERNEL_VERSION } : {},
  });
  manifest.vars = vars;
  manifest.hosts = hostSet; // GH #10: full host set, not just the primary
  manifest.files = fingerprintFiles(fileMap);
  // Self-hash the manifest itself so `harness upgrade` can detect a hand-
  // edited manifest.
  const manifestJson = JSON.stringify(manifest, null, 2);

  rendered.push({
    path: '.harness/manifest.json',
    content: manifestJson,
    rendered: false,
    unresolved: [],
  });
  // Also record the manifest's own hash inside the manifest file's directory
  // sibling (`.harness/manifest.sha256`) so a corrupt download is obvious.
  rendered.push({
    path: '.harness/manifest.sha256',
    content: sha256(manifestJson) + '\n',
    rendered: false,
    unresolved: [],
  });

  const paths = await writeAtomic(opts.targetDir, rendered, { force: opts.force });
  return {
    paths,
    manifestPath: join(opts.targetDir, '.harness', 'manifest.json'),
    unresolved: rendered.flatMap(f => f.unresolved),
  };
}

/** Try to detect an existing ruflo project at the given path. */
export function detectRufloProject(dir: string): {
  found: boolean;
  signals: string[];
} {
  const signals: string[] = [];
  if (existsSync(join(dir, 'CLAUDE.md'))) signals.push('CLAUDE.md');
  if (existsSync(join(dir, '.claude'))) signals.push('.claude/');
  if (existsSync(join(dir, '.claude-flow'))) signals.push('.claude-flow/');
  if (existsSync(join(dir, '.mcp.json'))) signals.push('.mcp.json');
  return { found: signals.length >= 2, signals };
}

/**
 * iter 117 — subcommand router. Per the user's directive:
 *
 *   Before generation: `metaharness`
 *   Inside generated harness: `harness`
 *
 * The factory side gains 4 explicit verbs (new / from-repo / analyze / genome)
 * so the surface reads as a tool, not as "the thing that takes a name". The
 * legacy bare-name form (`metaharness my-bot`) still works as a back-compat
 * shortcut for `metaharness new my-bot`.
 */
async function runMetaHarnessSubcommand(sub: string, rest: string[]): Promise<number | null> {
  switch (sub) {
    case 'new': {
      // `metaharness new <name> [--template <id>] [--host <id>]`
      // Just an explicit alias for the bare-name form. Falls through to the
      // legacy scaffold pipeline so semantics stay byte-identical.
      return null; // signal "not handled — fall through to main()"
    }
    case 'from-repo': {
      // `metaharness from-repo <url> <name> [--template <id>] [--host <id>]`
      // Clones a public GitHub repo to a tempdir, runs analyze-repo on it,
      // and scaffolds the recommended harness as <name>. NO repository code
      // is executed during analysis — same invariant as `analyze`.
      const url = rest[0];
      const name = rest[1];
      if (!url || !name) {
        console.error('Usage: npx metaharness from-repo <repo-url> <harness-name> [--template <id>] [--host <id>]');
        return 2;
      }
      // CodeQL #4 (second-order command injection): `url` is user-controlled.
      // Even with spawnSync's array form (no shell), git interprets a leading
      // '-' as an OPTION — e.g. `--upload-pack=...` or `-c core.fsmonitor=...`
      // would run arbitrary commands during clone. Two defenses:
      //   1. Allowlist the URL scheme to https/http/ssh/git before cloning.
      //   2. Pass `--` so everything after is treated as a positional, never
      //      an option, regardless of how it starts.
      if (!/^(https?:\/\/|git:\/\/|ssh:\/\/|git@)/.test(url)) {
        console.error(
          `Refusing to clone "${url}": only https://, http://, git://, ssh://, or git@ URLs are allowed.`,
        );
        return 2;
      }
      const { spawnSync } = await import('node:child_process');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: pathJoin } = await import('node:path');
      const tmp = mkdtempSync(pathJoin(tmpdir(), 'metaharness-fromrepo-'));
      console.log(`Cloning ${url} → ${tmp} (depth=1, code never executed)`);
      const clone = spawnSync('git', ['clone', '--depth=1', '--quiet', '--', url, tmp], { stdio: 'inherit' });
      if (clone.status !== 0) {
        console.error(`git clone failed (exit ${clone.status}). Is the URL public, is git installed?`);
        return 2;
      }
      // Delegate to analyze-repo with --scaffold.
      const { analyzeRepoCmd } = await import('./analyze-repo.js');
      const remaining = rest.slice(2);
      const analyzeArgs = [tmp, '--scaffold', name, ...remaining];
      const r = await analyzeRepoCmd(analyzeArgs);
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'analyze': {
      // `metaharness analyze <path> [--scaffold <name>] [--embed]`
      // Alias for `harness analyze-repo`. Surface unification per the
      // user's command-model directive.
      const { analyzeRepoCmd } = await import('./analyze-repo.js');
      const r = await analyzeRepoCmd(rest);
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'genome': {
      // `metaharness genome <path>` — flagship feature per the user.
      // Same code path as `harness genome`.
      const { genomeCmd } = await import('./genome.js');
      const r = await genomeCmd(rest);
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'score': {
      // `metaharness score <repo> [--json]` — ADR-041 scorecard (the killer
      // feature). No-exec repo analysis → 6-line fit/cost/safety card.
      const { scoreRepoCmd } = await import('./repo-scorecard.js');
      const r = await scoreRepoCmd(rest);
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'weight-eft': {
      // `metaharness weight-eft <export|train|eval|status>` (ADR-198) — delegates
      // to @metaharness/weight-eft: evolutionary fine-tuning. Distil the archive
      // into the open cheap tier via LoRA so the cost-cascade escalates to a
      // frontier model less often. $0 by default (export + dry-run plan); a real
      // train is GPU-gated behind --train.
      const { dispatch } = await import('@metaharness/weight-eft/cli');
      const r = await dispatch(rest[0], rest.slice(1));
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'learn': {
      // `metaharness learn --host <h> --model <m> --slice <manifest> [--seed cand6]
      //  [--train-first N] [--max-cost $] [--via-gateway] [--run]` — ADR-235: cheap-tier
      // optimization as a managed learning service. Delegates to the repo's GEPA harness
      // (gepa/learn.mjs); REPO-CHECKOUT-GATED (the harness needs bench scripts + Docker +
      // SWE-bench and cannot ship in the tarball). $0 by default: --dry-run is always
      // forwarded unless --run is passed. `--seed cand6` resolves to the packaged
      // holdout-confirmed cand-6 genome (genomes/).
      const { learnCmd } = await import('./learn.js');
      return learnCmd(rest);
    }
    case 'redblue': {
      // `metaharness redblue <init|run|attack|patch|retest|report>` — delegates to
      // @metaharness/redblue: defensive red/blue adversarial testing of an AI
      // agent/workflow/prompt/toolchain you own. Operationalizes NIST AI RMF +
      // OWASP LLM Top-10 as repeatable tests; capability-contained (no real
      // creds / live targets / shell / network). $0 with --mock-judge; the real
      // model judge gates on OPENROUTER_API_KEY.
      const { dispatch } = await import('@metaharness/redblue/cli');
      const r = await dispatch(rest[0], rest.slice(1));
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'flywheel': {
      // `metaharness flywheel <run|replay|graph>` — delegates to @metaharness/flywheel: the reusable
      // promotion loop (run→measure→mutate→verify→promote). `run <config.mjs>` turns the wheel from a
      // user config; `replay <bundle.json>` independently verifies a proof bundle (receipts + lineage +
      // frozen-gate fingerprint); `graph <bundle.json>` prints the compounding lift curve. Host- and
      // benchmark-agnostic — the flywheel knows only candidates, scores, gates, receipts, and lineage.
      const { dispatch } = await import('@metaharness/flywheel/cli');
      const r = await dispatch(rest[0], rest.slice(1));
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'turn-credit': {
      // `metaharness turn-credit <process|report>` — delegates to @metaharness/turn-credit
      // (ADR-248): offline recursive turn-level credit for recorded trajectories
      // (AgentOPSD, arXiv:2608.05987). Converts sparse terminal outcomes into bounded
      // per-turn weights (belief revisions) — advisory signals for routing, retry
      // policy, retrieval feedback, and Darwin mutation attribution. $0 and pure:
      // the (single) teacher scoring pass that produces the input happens upstream.
      const { dispatch } = await import('@metaharness/turn-credit/cli');
      const r = await dispatch(rest[0], rest.slice(1));
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'avo': {
      // `metaharness avo <trusted-key|gate-build|gate-submit>` — delegates to @metaharness/avo
      // (ADR-251 governed autonomous variation runtime + ADR-271 flywheel-gate receipt contract).
      // Turns an AVO run summary into the five Ed25519-signed gate receipts and submits them to
      // POST /v1/flywheel/gate for a governed promotion verdict; `trusted-key` prints the SPKI-DER
      // public key to register in the gateway's FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON allowlist. The
      // GovernedVariationOperator itself stays a library import — the gateway is never a runtime dep.
      const { dispatch } = await import('@metaharness/avo/cli');
      const r = await dispatch(rest[0], rest.slice(1));
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    case 'proxy': {
      // Optional Meta-Proxy integration. The signed Rust sidecar is downloaded
      // only through its explicit `install --yes` command, never while scaffolding.
      const { metaProxyCmd } = await import('./meta-proxy.js');
      const r = await metaProxyCmd(rest);
      for (const line of r.lines) console.log(line);
      return r.code;
    }
    default:
      return null; // not a known subcommand
  }
}

export async function main(argv: string[]): Promise<number> {
  // iter 117 — subcommand router runs BEFORE flag parsing so positional
  // verbs win over the legacy bare-name form. The router returns null when
  // the first arg isn't a recognised subcommand, letting us fall through.
  const first = argv[0];
  if (first && !first.startsWith('-')) {
    const subResult = await runMetaHarnessSubcommand(first, argv.slice(1));
    if (subResult !== null) return subResult;
    // `new <name>` — strip the verb and fall through to the legacy scaffold.
    if (first === 'new') {
      argv = argv.slice(1);
    }
  }

  const args = parseArgs(argv);

  if (args.list) {
    for (const line of formatCatalog(loadCatalog())) console.log(line);
    return 0;
  }

  if (args.wizard) {
    // iter 100 (MILESTONE) — interactive wizard. Errors immediately
    // on non-TTY environments (no point running the wizard in CI;
    // arg-driven scaffold is what CI should use).
    if (!process.stdin.isTTY) {
      console.error('--wizard requires an interactive TTY. Use the arg-driven form in CI:');
      console.error('  npx metaharness <name> --template <id> --host <id>');
      return 2;
    }
    const { runWizard, makeReadlineAsker, answersToInvocation } = await import('./wizard.js');
    const catalogEntries = loadCatalog().map(t => ({ id: t.id, name: t.name, description: t.description }));
    const wizardCatalog = { templates: catalogEntries, hosts: HOSTS };
    const { ask, close } = makeReadlineAsker();
    try {
      const answers = await runWizard(wizardCatalog, ask);
      // Fall through to the same scaffold path the arg-driven form
      // uses — single source of truth for the scaffold semantics.
      args.name = answers.name;
      args.template = answers.template;
      args.hosts = [answers.host];
      args.description = answers.description;
      // Print the equivalent CLI invocation so the user can re-run
      // without the wizard next time.
      process.stdout.write('\nNext time, you can skip the wizard with:\n');
      process.stdout.write(`  ${answersToInvocation(answers)}\n\n`);
    } finally {
      close();
    }
  }

  if (args.fromExisting !== undefined) {
    const root = args.fromExisting || process.cwd();
    const d = detectRufloProject(root);
    if (d.found) {
      console.log(`Detected ruflo project at ${root}`);
      console.log(`Signals: ${d.signals.join(', ')}`);
      console.log('Eject mode will lift agents/skills/commands into a renamed harness.');
      console.log('(Full eject pipeline lands in iter 5.)');
      return 0;
    } else {
      console.log(`No ruflo project detected at ${root}`);
      console.log(`Signals seen: ${d.signals.length === 0 ? 'none' : d.signals.join(', ')}`);
      return 1;
    }
  }

  if (!args.name) {
    console.log('Usage: npx metaharness <name> [--template <id>] [--host claude-code|codex|pi-dev|hermes] [--description "..."] [--target <path>] [--force]');
    console.log('       --target <path>   write the harness to <path> instead of ./<name>');
    console.log('       --no-darwin       skip Darwin Mode self-improvement (default: integrated; adds `npm run evolve`)');
    console.log('       --sessions        add a crash-recoverable session log (src/sessions/log.ts — ADR-246 §2.3; default: off)');
    console.log('       --with-wasm <crate-path>   build a wasm-pack crate into the harness as commands (GH #25)');
    console.log('       npx metaharness score <repo> [--json]   (scorecard: fit/cost/safety for a repo — ADR-041)');
    console.log('       npx metaharness analyze <repo>           (recommend a harness plan, no-exec)');
    console.log('       npx metaharness genome <repo>            (7-section repo readiness)');
    console.log('       npx metaharness learn --host <h> --model <m> --slice <manifest>   (ADR-235 GEPA learning run — $0 dry-run by default, --run to spend; needs a repo checkout)');
    console.log('       npx metaharness avo <trusted-key|gate-build|gate-submit>  (ADR-271 flywheel-gate receipts from an AVO run summary)');
    console.log('       npx metaharness proxy <install|status|start|stop|enable|disable|path|login|logout>  (optional signed Cognitum Meta-Proxy sidecar)');
    console.log('       npx metaharness --from-existing [./path]');
    console.log('       npx metaharness --wizard          (iter 100 — interactive picker)');
    console.log('       npx metaharness --list            (browse all templates)');
    console.log('');
    console.log(`Templates: ${TEMPLATES.join(', ')}`);
    console.log(`Hosts: ${HOSTS.join(', ')}`);
    // #73: bare `metaharness` prints help/usage — that is a successful
    // invocation, not a failure, so it exits 0. (An invoked *subcommand*
    // missing required args, e.g. `from-repo`/`analyze`, still returns a
    // non-zero usage code from its own branch — those are genuine errors.)
    return 0;
  }

  // GH #10: support a multi-host harness. The first --host is primary (drives
  // the template); all are validated + emitted.
  const hostList = (args.hosts && args.hosts.length ? args.hosts : ['claude-code']) as Host[];
  for (const h of hostList) {
    if (!HOSTS.includes(h)) {
      console.error(`Unknown host: ${h}. Choose from: ${HOSTS.join(', ')}`);
      return 2;
    }
  }
  const host = hostList[0]!;

  const template = args.template ?? 'minimal';
  // GH issue #9: honor `--target <path>` (write the harness AT <path>); default
  // remains $CWD/<name>. Both are resolved against CWD so relative paths work.
  const targetDir = args.target
    ? resolve(process.cwd(), args.target)
    : resolve(process.cwd(), args.name);

  try {
    const result = await scaffold({
      name: args.name,
      template,
      host,
      hosts: hostList,
      description: args.description,
      targetDir,
      force: args.force,
      darwin: args.darwin !== false, // ADR-147: deep darwin integration, default on
      sessions: args.sessions === true, // ADR-246 §2.3: sessions scaffold, default off
      generatorVersion: '0.1.0',
    });
    console.log(`Scaffolded ${args.name} into ${targetDir}`);
    if (hostList.length > 1) console.log(`Hosts: ${hostList.join(', ')}`);
    console.log(`Files: ${result.paths.length}`);
    console.log(`Manifest: ${result.manifestPath}`);
    if (result.unresolved.length > 0) {
      console.log(`Warning: unresolved vars in template: ${result.unresolved.join(', ')}`);
    }
    // GH #25: wire the project's own wasm-pack crate as harness commands.
    if (args.withWasm) {
      const { wireWasm } = await import('./with-wasm.js');
      const w = wireWasm(args.withWasm, targetDir);
      for (const line of w.lines) console.log(line);
      if (!w.ok) console.log('(--with-wasm did not complete; the harness scaffold itself is fine.)');
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export type { TemplateVars } from './renderer.js';
export { render, extractVarReferences, validateHarnessName } from './renderer.js';
export { walkTemplate, asFileMap } from './walker.js';
export { writeAtomic } from './writer.js';
export { emptyManifest, sha256, fingerprintFiles, diffFingerprints } from './manifest.js';
