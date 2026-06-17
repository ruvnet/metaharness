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
// iter 147 added github-actions (ADR-033, the first non-interactive host).
// HOSTS is the canonical 9-host catalog as of iter 147.
export const HOSTS = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm', 'copilot', 'opencode', 'github-actions'] as const;
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
    console.log('       --with-wasm <crate-path>   build a wasm-pack crate into the harness as commands (GH #25)');
    console.log('       npx metaharness score <repo> [--json]   (scorecard: fit/cost/safety for a repo — ADR-041)');
    console.log('       npx metaharness analyze <repo>           (recommend a harness plan, no-exec)');
    console.log('       npx metaharness genome <repo>            (7-section repo readiness)');
    console.log('       npx metaharness --from-existing [./path]');
    console.log('       npx metaharness --wizard          (iter 100 — interactive picker)');
    console.log('       npx metaharness --list            (browse all templates)');
    console.log('');
    console.log(`Templates: ${TEMPLATES.join(', ')}`);
    console.log(`Hosts: ${HOSTS.join(', ')}`);
    return 2;
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
