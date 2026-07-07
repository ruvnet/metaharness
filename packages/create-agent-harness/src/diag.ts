// SPDX-License-Identifier: MIT
//
// `harness diag` — single-question diagnostic: is the LOCAL @metaharness/kernel
// compatible with the version this harness was scaffolded against?
//
// Surfaces:
//   - manifest.meta.surface     (iter 56) — which surface produced it (cli/web-ui)
//   - manifest.meta.kernel_version (iter 58) — the version the scaffold was built against
//   - the locally-installed @metaharness/kernel version (resolved at runtime)
//   - drift verdict and actionable next step
//
// Why split this out of `harness doctor`?
//   doctor is the generic smoke check (does .harness/ exist? is the
//   manifest hash intact?). diag is the ONE cross-machine question
//   that almost every "support ticket" turns out to be — and the
//   answer needs to be loud, single-line, and copy-pasteable so users
//   can act on it without reading every doctor line.

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactSecretsDeep } from './redact.js';
/** Mirror of subcommands.ts's exported shape — kept local to avoid a
 *  cyclic import (subcommands.ts imports from diag.ts via diagCmd). */
export type SubcommandResult = { code: number; lines: string[] };

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse "X.Y.Z[-pre]" into a tuple. Returns null on unrecognised input
 * (e.g. "git+ssh://..." or "*"). We only need the major/minor/patch ints
 * for the skew verdict; pre-release suffixes are ignored.
 */
function parseSemver(v: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

/** Compute the skew verdict between two semvers. */
export type SkewVerdict = 'match' | 'patch-diff' | 'minor-diff' | 'major-diff' | 'unparseable';

export function skewVerdict(manifestVer: string | undefined, localVer: string | undefined): SkewVerdict {
  if (!manifestVer || !localVer) return 'unparseable';
  const m = parseSemver(manifestVer);
  const l = parseSemver(localVer);
  if (!m || !l) return 'unparseable';
  if (m.major !== l.major) return 'major-diff';
  if (m.minor !== l.minor) return 'minor-diff';
  if (m.patch !== l.patch) return 'patch-diff';
  return 'match';
}

/** GH #22: the kernel backend that actually answered on this machine. */
export type KernelBackendTier = 'native' | 'wasm' | 'js';

/**
 * GH #22: resolve WHICH kernel backend the harness actually loads on this
 * machine (native > wasm > js), the backend explicitly requested via
 * METAHARNESS_KERNEL_BACKEND (if any), and the reason each higher tier was
 * unavailable. The version diagnostic above answers "is the kernel the right
 * VERSION?"; this answers "am I getting the FAST kernel, and if not, why not?"
 * — the #1 support question after version skew (silent js fallback, GH #22).
 *
 * Never throws — consistent with the rest of diag. Two ways the fast path is
 * absent are BOTH captured: (a) auto mode fell through to js → `kernelDiagnostics`
 * carries the per-tier reasons; (b) a specific backend was REQUESTED but can't
 * load → `loadKernel` throws, and we surface that throw under the requested tier
 * (that throw message IS the diagnostic the operator asked for).
 */
async function resolveKernelBackend(harnessDir: string): Promise<{
  backend: KernelBackendTier | undefined;
  requested: string | null;
  reasons: { native?: string; wasm?: string };
}> {
  const requested = (process.env.METAHARNESS_KERNEL_BACKEND || '').trim().toLowerCase() || null;
  const entry = resolveKernelEntry(harnessDir);
  if (!entry) return { backend: undefined, requested, reasons: {} };
  try {
    const mod = (await import(pathToFileURL(entry).href)) as {
      kernelDiagnostics?: () => Promise<{
        resolved: KernelBackendTier;
        requested: string | null;
        reasons: { native?: string; wasm?: string };
      }>;
    };
    if (typeof mod.kernelDiagnostics === 'function') {
      const d = await mod.kernelDiagnostics();
      return { backend: d.resolved, requested: d.requested ?? requested, reasons: d.reasons ?? {} };
    }
    // Kernel present but predates kernelDiagnostics() (GH #22) — can't report the backend.
    return { backend: undefined, requested, reasons: {} };
  } catch (e) {
    // A REQUESTED-but-unavailable backend makes loadKernel throw — capture that
    // reason under the requested tier so the operator sees exactly why.
    const reasons: { native?: string; wasm?: string } = {};
    if (requested === 'native' || requested === 'wasm') reasons[requested] = (e as Error).message;
    return { backend: undefined, requested, reasons };
  }
}

/**
 * Resolve the @metaharness/kernel entry module the same way we resolve its
 * version — from the harness's own node_modules first, then the workspace
 * checkout — so the reported backend matches the kernel the harness loads.
 */
function resolveKernelEntry(harnessDir: string): string | undefined {
  try {
    const require = createRequire(join(harnessDir, 'package.json'));
    return require.resolve('@metaharness/kernel');
  } catch {
    const wsEntry = resolve(__dirname, '..', '..', 'kernel-js', 'dist', 'index.js');
    return existsSync(wsEntry) ? wsEntry : undefined;
  }
}

/**
 * Resolve the locally-installed @metaharness/kernel version. Uses createRequire
 * so it follows real Node resolution from the harness's package.json. We
 * never throw — a missing kernel is the WHOLE POINT of this diagnostic
 * (it gets reported as such).
 */
function resolveLocalKernelVersion(harnessDir: string): string | undefined {
  try {
    const require = createRequire(join(harnessDir, 'package.json'));
    const pkgPath = require.resolve('@metaharness/kernel/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    // Fall back to the workspace's kernel package if running uninstalled
    // (e.g. dev work inside the monorepo before publish).
    const wsPath = resolve(__dirname, '..', '..', 'kernel-js', 'package.json');
    if (existsSync(wsPath)) {
      try {
        const pkg = JSON.parse(readFileSync(wsPath, 'utf-8'));
        // Guard: must be the kernel package (iter 149 — symmetry with
        // resolveKernelVersion's name check).
        if (pkg.name && pkg.name !== '@metaharness/kernel') return undefined;
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * iter 71: resolve the version of create-agent-harness this process is
 * running from. Used to compare against `manifest.generator`. Falls
 * through the same 3-path lookup as the kernel resolver: workspace
 * checkout, installed sibling, top-level node_modules.
 */
function resolveLocalGeneratorVersion(): string | undefined {
  const candidates = [
    // Workspace: packages/create-agent-harness/dist/ → ../package.json
    resolve(__dirname, '..', 'package.json'),
    // Installed: node_modules/metaharness/package.json (post iter 108 rename)
    resolve(__dirname, '..', '..', 'metaharness', 'package.json'),
    // Legacy: node_modules/create-agent-harness/package.json (pre-rename installs)
    resolve(__dirname, '..', '..', 'create-agent-harness', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string };
        // Accept either name — `create-agent-harness` is the legacy resolved-from-sibling
        // case, `metaharness` is the current publishable name (iter 108).
        if ((pkg.name === 'metaharness' || pkg.name === 'create-agent-harness') && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export interface DiagReport {
  dir: string;
  surface: string | undefined;
  manifestKernelVersion: string | undefined;
  localKernelVersion: string | undefined;
  verdict: SkewVerdict;
  actionable: string | undefined;
  // iter 71: also surface generator-version skew. The manifest's
  // `generator` field records the create-agent-harness version at
  // scaffold time. If the user installed a newer create-agent-harness
  // since, `harness upgrade` may produce different output than they'd
  // expect — that's exactly the kind of cross-machine surprise diag is
  // designed to surface.
  manifestGeneratorVersion: string | undefined;
  localGeneratorVersion: string | undefined;
  generatorVerdict: SkewVerdict;
  // GH #22: which kernel backend actually answers on this machine (native/wasm/js),
  // the backend requested via METAHARNESS_KERNEL_BACKEND (null if unset), and why a
  // higher tier was unavailable. `kernelBackend` is undefined when the kernel can't
  // be loaded at all (not installed, or a requested backend that threw).
  kernelBackend: KernelBackendTier | undefined;
  requestedBackend: string | null;
  backendReasons: { native?: string; wasm?: string };
}

export async function buildDiagReport(harnessDir: string): Promise<DiagReport> {
  const manifestPath = join(harnessDir, '.harness', 'manifest.json');
  let surface: string | undefined;
  let manifestKernelVersion: string | undefined;
  let manifestGeneratorVersion: string | undefined;
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
      surface = m.meta?.surface;
      manifestKernelVersion = m.meta?.kernel_version;
      // iter 71: manifest.generator is the top-level field stamped by
      // emptyManifest() — predates the meta block, present in every
      // scaffold from iter 4 onward.
      manifestGeneratorVersion = typeof m.generator === 'string' ? m.generator : undefined;
    } catch {
      /* leave both undefined */
    }
  }
  const localKernelVersion = resolveLocalKernelVersion(harnessDir);
  const verdict = skewVerdict(manifestKernelVersion, localKernelVersion);
  const localGeneratorVersion = resolveLocalGeneratorVersion();
  const generatorVerdict = skewVerdict(manifestGeneratorVersion, localGeneratorVersion);
  const kb = await resolveKernelBackend(harnessDir);
  let actionable: string | undefined;
  if (verdict === 'major-diff') {
    actionable = `Run: npm install @metaharness/kernel@${manifestKernelVersion} (major skew — APIs may break)`;
  } else if (verdict === 'minor-diff') {
    actionable = `Run: npm install @metaharness/kernel@${manifestKernelVersion} (minor skew — new features may be missing)`;
  } else if (verdict === 'patch-diff') {
    actionable = `Optional: npm install @metaharness/kernel@${manifestKernelVersion} (patch skew — usually safe)`;
  } else if (verdict === 'unparseable' && manifestKernelVersion && !localKernelVersion) {
    actionable = `Run: npm install @metaharness/kernel@${manifestKernelVersion} (kernel not installed locally)`;
  }
  return {
    dir: harnessDir,
    surface,
    manifestKernelVersion,
    localKernelVersion,
    verdict,
    actionable,
    manifestGeneratorVersion,
    localGeneratorVersion,
    generatorVerdict,
    kernelBackend: kb.backend,
    requestedBackend: kb.requested,
    backendReasons: kb.reasons,
  };
}

/**
 * Format a diag report for human reading. Returns the lines + an exit
 * code suitable for the CLI: 0 on match/patch, 1 on minor/major, 2 if
 * the manifest is missing entirely.
 */
export function formatDiagReport(report: DiagReport): SubcommandResult {
  const lines: string[] = [];
  lines.push(`harness diag — checking ${report.dir}`);
  lines.push('');
  if (!report.manifestKernelVersion && !existsSync(join(report.dir, '.harness', 'manifest.json'))) {
    lines.push('  FAIL no .harness/manifest.json found at this path');
    lines.push('       (this directory is not a scaffolded harness — run harness diag from a harness root)');
    return { code: 2, lines };
  }
  lines.push(`  surface:              ${report.surface ?? '(unknown — pre-iter-56 manifest)'}`);
  lines.push(`  manifest kernel:      ${report.manifestKernelVersion ?? '(unset — pre-iter-58 manifest)'}`);
  lines.push(`  installed kernel:     ${report.localKernelVersion ?? '(not installed)'}`);
  // GH #22: which backend actually answers + (if a specific one was requested) that request.
  const reqSuffix = report.requestedBackend ? `  [requested: ${report.requestedBackend}]` : '';
  // When no backend resolved, the reason differs: a REQUESTED tier that threw
  // (kernel is installed, that tier just isn't) vs. the kernel not resolving at all.
  const unresolvedLabel = report.requestedBackend
    ? '(requested backend unavailable — see below)'
    : '(not loadable — kernel not installed?)';
  lines.push(`  kernel backend:       ${report.kernelBackend ?? unresolvedLabel}${reqSuffix}`);
  // GH #22: WHY the faster tiers didn't answer — the whole point of the issue
  // (a silent js fallback with no explanation). Only show a tier that failed
  // AND isn't the one that ended up answering.
  if (report.backendReasons.native && report.kernelBackend !== 'native') {
    lines.push(`     native unavailable — ${report.backendReasons.native}`);
  }
  if (report.backendReasons.wasm && report.kernelBackend !== 'wasm') {
    lines.push(`     wasm unavailable — ${report.backendReasons.wasm}`);
  }
  lines.push(`  manifest generator:   ${report.manifestGeneratorVersion ?? '(unset)'}`);
  lines.push(`  installed generator:  ${report.localGeneratorVersion ?? '(not installed)'}`);
  lines.push('');
  const tag: Record<SkewVerdict, string> = {
    'match':         'PASS',
    'patch-diff':    'WARN',
    'minor-diff':    'WARN',
    'major-diff':    'FAIL',
    'unparseable':   'WARN',
  };
  const blurb: Record<SkewVerdict, string> = {
    'match':         'kernel versions match exactly',
    'patch-diff':    'patch-level skew (usually safe; may include bugfixes)',
    'minor-diff':    'minor-level skew (new kernel features may be missing)',
    'major-diff':    'MAJOR skew — APIs may have changed; expect breakage',
    'unparseable':   'could not parse one or both kernel versions',
  };
  lines.push(`  ${tag[report.verdict]} ${blurb[report.verdict]}`);
  // iter 71: generator-skew is informational — never fails. The
  // generator can change without the harness becoming incompatible
  // (templates evolve, but the *generated* harness is self-contained).
  // Surfacing it just lets `harness upgrade` users predict whether
  // they'll see new template files after re-run.
  const genBlurb: Record<SkewVerdict, string> = {
    'match':         'generator versions match exactly',
    'patch-diff':    'patch-level generator skew (template fixes since this scaffold)',
    'minor-diff':    'minor-level generator skew (new template features available)',
    'major-diff':    'MAJOR generator skew (template may have moved — re-run `harness upgrade` to preview drift)',
    'unparseable':   'generator version unknown',
  };
  const genTag: Record<SkewVerdict, string> = {
    'match':         'PASS',
    'patch-diff':    'INFO',
    'minor-diff':    'INFO',
    'major-diff':    'WARN',
    'unparseable':   'INFO',
  };
  lines.push(`  ${genTag[report.generatorVerdict]} ${genBlurb[report.generatorVerdict]}`);
  if (report.actionable) {
    lines.push('');
    lines.push(`  → ${report.actionable}`);
  }
  // Exit codes:
  //   0 — match (always)
  //   0 — patch-diff (informational)
  //   1 — minor-diff or major-diff (action needed)
  //   1 — unparseable when manifest version is set but local isn't
  // generatorVerdict NEVER fails — it's informational only.
  let code = 0;
  if (report.verdict === 'minor-diff' || report.verdict === 'major-diff') code = 1;
  if (report.verdict === 'unparseable' && report.manifestKernelVersion && !report.localKernelVersion) code = 1;
  return { code, lines };
}

/**
 * Format a report as JSON for programmatic consumers. Includes the full
 * report shape + the resolved exit code (delegated to formatDiagReport
 * so the verdict-to-exit-code mapping has exactly ONE definition) so
 * callers can gate on either the structured data or the exit code.
 */
export function formatDiagReportJson(report: DiagReport): SubcommandResult {
  const human = formatDiagReport(report);
  return {
    code: human.code,
    lines: [
      JSON.stringify({ ...report, exitCode: human.code }, null, 2),
    ],
  };
}

/**
 * iter 90 — support-bundle JSON. Single-command snapshot of every
 * diagnostic surface a maintainer would need to triage an issue:
 *
 *   - The diag report (skew verdict + versions)
 *   - The manifest contents (sanitised — vars stay since they're chosen
 *     by the user, but anything starting with `secret_`/`token_`/`key_`
 *     is replaced with "<redacted>" so users can paste this without
 *     leaking credentials they typed into prompts)
 *   - The harness's package.json name + version + @metaharness/* deps
 *   - Node version, platform, arch (for cross-OS bug repro)
 *   - Last 3 .harness/* file paths (presence/absence proves which
 *     lifecycle steps the user has run)
 *
 * Users run `harness diag --bundle` and paste the output into a GitHub
 * issue. Maintainers get every load-bearing fact in one block.
 */
export interface SupportBundle {
  schema: 1;
  generatedAt: string;
  diag: DiagReport & { exitCode: number };
  harness: {
    packageName: string | undefined;
    packageVersion: string | undefined;
    rufloDeps: Record<string, string>;
  };
  manifest: { present: boolean; content: unknown | undefined };
  harnessFiles: string[];
  env: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
}

const REDACT_KEY_RE = /^(secret|token|key|password|api[-_]?key)/i;

// GH #4 (HIGH-2): redact by KEY name AND by VALUE shape — a secret-shaped value in a non-secret-named
// field (e.g. a token pasted into a `vars` entry) must not survive into a bundle a user pastes into an
// issue. Value-aware detection lives in redact.ts (single source of truth, finding #7).
function sanitiseManifest(m: unknown): unknown {
  return redactSecretsDeep(m, { keyRe: REDACT_KEY_RE, replacement: '<redacted>' });
}

export async function buildSupportBundle(harnessDir: string): Promise<SupportBundle> {
  const report = await buildDiagReport(harnessDir);
  const human = formatDiagReport(report);
  const exitCode = human.code;

  let packageName: string | undefined;
  let packageVersion: string | undefined;
  const rufloDeps: Record<string, string> = {};
  const pkgPath = join(harnessDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      packageName = typeof pkg.name === 'string' ? pkg.name : undefined;
      packageVersion = typeof pkg.version === 'string' ? pkg.version : undefined;
      for (const block of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies] as Array<Record<string, string> | undefined>) {
        if (block && typeof block === 'object') {
          for (const [name, version] of Object.entries(block)) {
            if (name.startsWith('@metaharness/') || name === 'create-agent-harness' || name === 'metaharness') {
              rufloDeps[name] = version;
            }
          }
        }
      }
    } catch {
      /* unreadable package.json — harnessDir not a real harness */
    }
  }

  const manifestPath = join(harnessDir, '.harness', 'manifest.json');
  let manifestContent: unknown = undefined;
  if (existsSync(manifestPath)) {
    try {
      manifestContent = sanitiseManifest(JSON.parse(readFileSync(manifestPath, 'utf-8')));
    } catch {
      manifestContent = '<unreadable>';
    }
  }

  const harnessFiles: string[] = [];
  if (existsSync(join(harnessDir, '.harness'))) {
    try {
      for (const ent of readdirSync(join(harnessDir, '.harness'))) {
        harnessFiles.push(`.harness/${ent}`);
      }
    } catch {
      /* swallow — read failure isn't fatal for the bundle */
    }
  }

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    diag: { ...report, exitCode },
    harness: { packageName, packageVersion, rufloDeps },
    manifest: { present: !!manifestContent, content: manifestContent },
    harnessFiles,
    env: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  };
}

export async function diagCmd(args: string[]): Promise<SubcommandResult> {
  // iter 73: --json emits machine-readable output. Useful for CI
  // scripts that want to gate on the structured verdict rather than
  // parsing the human text.
  // iter 90: --bundle emits a complete support-bundle JSON with
  // diag + manifest + ruflo deps + env. For "paste this into the
  // issue" workflows.
  const json = args.includes('--json');
  const bundle = args.includes('--bundle');
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  if (bundle) {
    const b = await buildSupportBundle(dir);
    return {
      // Exit code follows the diag verdict so CI scripts can still
      // gate on the bundle output (you can `harness diag --bundle > b.json`
      // and use `$?` to know whether to alert).
      code: b.diag.exitCode,
      lines: [JSON.stringify(b, null, 2)],
    };
  }
  const report = await buildDiagReport(dir);
  return json ? formatDiagReportJson(report) : formatDiagReport(report);
}
