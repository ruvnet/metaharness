// SPDX-License-Identifier: MIT
//
// `harness diag` — single-question diagnostic: is the LOCAL @ruflo/kernel
// compatible with the version this harness was scaffolded against?
//
// Surfaces:
//   - manifest.meta.surface     (iter 56) — which surface produced it (cli/web-ui)
//   - manifest.meta.kernel_version (iter 58) — the version the scaffold was built against
//   - the locally-installed @ruflo/kernel version (resolved at runtime)
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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * Resolve the locally-installed @ruflo/kernel version. Uses createRequire
 * so it follows real Node resolution from the harness's package.json. We
 * never throw — a missing kernel is the WHOLE POINT of this diagnostic
 * (it gets reported as such).
 */
function resolveLocalKernelVersion(harnessDir: string): string | undefined {
  try {
    const require = createRequire(join(harnessDir, 'package.json'));
    const pkgPath = require.resolve('@ruflo/kernel/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    // Fall back to the workspace's kernel package if running uninstalled
    // (e.g. dev work inside the monorepo before publish).
    const wsPath = resolve(__dirname, '..', '..', 'kernel-js', 'package.json');
    if (existsSync(wsPath)) {
      try {
        const pkg = JSON.parse(readFileSync(wsPath, 'utf-8'));
        return typeof pkg.version === 'string' ? pkg.version : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export interface DiagReport {
  dir: string;
  surface: string | undefined;
  manifestKernelVersion: string | undefined;
  localKernelVersion: string | undefined;
  verdict: SkewVerdict;
  actionable: string | undefined;
}

export async function buildDiagReport(harnessDir: string): Promise<DiagReport> {
  const manifestPath = join(harnessDir, '.harness', 'manifest.json');
  let surface: string | undefined;
  let manifestKernelVersion: string | undefined;
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
      surface = m.meta?.surface;
      manifestKernelVersion = m.meta?.kernel_version;
    } catch {
      /* leave both undefined */
    }
  }
  const localKernelVersion = resolveLocalKernelVersion(harnessDir);
  const verdict = skewVerdict(manifestKernelVersion, localKernelVersion);
  let actionable: string | undefined;
  if (verdict === 'major-diff') {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (major skew — APIs may break)`;
  } else if (verdict === 'minor-diff') {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (minor skew — new features may be missing)`;
  } else if (verdict === 'patch-diff') {
    actionable = `Optional: npm install @ruflo/kernel@${manifestKernelVersion} (patch skew — usually safe)`;
  } else if (verdict === 'unparseable' && manifestKernelVersion && !localKernelVersion) {
    actionable = `Run: npm install @ruflo/kernel@${manifestKernelVersion} (kernel not installed locally)`;
  }
  return {
    dir: harnessDir,
    surface,
    manifestKernelVersion,
    localKernelVersion,
    verdict,
    actionable,
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
  if (report.actionable) {
    lines.push('');
    lines.push(`  → ${report.actionable}`);
  }
  // Exit codes:
  //   0 — match (always)
  //   0 — patch-diff (informational)
  //   1 — minor-diff or major-diff (action needed)
  //   1 — unparseable when manifest version is set but local isn't
  let code = 0;
  if (report.verdict === 'minor-diff' || report.verdict === 'major-diff') code = 1;
  if (report.verdict === 'unparseable' && report.manifestKernelVersion && !report.localKernelVersion) code = 1;
  return { code, lines };
}

export async function diagCmd(args: string[]): Promise<SubcommandResult> {
  const dir = resolve(args[0] ?? process.cwd());
  const report = await buildDiagReport(dir);
  return formatDiagReport(report);
}
