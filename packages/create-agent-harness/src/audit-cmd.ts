// SPDX-License-Identifier: MIT
//
// `harness audit [path] [--level=high|critical|moderate]` CLI subcommand.
//
// Wraps `npm audit --omit=dev --audit-level=<level>` against a harness's
// package-lock.json + reports the per-severity advisory count. Like
// scripts/audit-deps.mjs but per-harness.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const execFile = promisify(execFileCb);

export type SubcommandResult = { code: number; lines: string[] };

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export async function auditCmd(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  const level = args.find(a => a.startsWith('--level='))?.slice('--level='.length) ?? 'high';
  const includeDev = args.includes('--include-dev');
  // iter 102: --bundle emits the full audit JSON (npm audit raw output +
  // harness metadata) so users can paste it into a security review or
  // attach to a GitHub issue. Same pattern as iter-90 diag --bundle.
  const bundle = args.includes('--bundle');

  const lines: string[] = [`harness audit — ${dir} (level=${level})`];

  if (!LEVELS.includes(level as any)) {
    if (bundle) {
      return {
        code: 2,
        lines: [JSON.stringify({ schema: 1, error: 'unknown-level', level, validLevels: LEVELS }, null, 2)],
      };
    }
    lines.push(`  unknown --level=${level} (use one of ${LEVELS.join(', ')})`);
    return { code: 2, lines };
  }

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    if (bundle) {
      return {
        code: 1,
        lines: [JSON.stringify({ schema: 1, error: 'no-package-json', dir }, null, 2)],
      };
    }
    lines.push(`  no package.json at ${dir}`);
    return { code: 1, lines };
  }
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) {
    if (bundle) {
      return {
        code: 1,
        lines: [JSON.stringify({ schema: 1, error: 'no-lockfile', dir }, null, 2)],
      };
    }
    lines.push(`  no package-lock.json at ${dir} — run \`npm install --package-lock-only\` first`);
    return { code: 1, lines };
  }

  const npmArgs = ['audit', '--json', `--audit-level=${level}`];
  if (!includeDev) npmArgs.push('--omit=dev');

  const npmCmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const finalArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm', ...npmArgs]
    : npmArgs;

  let stdout = '', stderr = '', exitCode = 0;
  try {
    const r = await execFile(npmCmd, finalArgs, {
      cwd: dir, maxBuffer: 1024 * 1024 * 16, windowsHide: true,
    });
    stdout = r.stdout; stderr = r.stderr;
  } catch (e: any) {
    stdout = e.stdout ?? ''; stderr = e.stderr ?? ''; exitCode = e.code ?? 1;
  }

  let parsed: any = null;
  try { parsed = JSON.parse(stdout); } catch { /* */ }
  if (!parsed) {
    if (exitCode === 0) {
      if (bundle) {
        return {
          code: 0,
          lines: [JSON.stringify({
            schema: 1, generatedAt: new Date().toISOString(),
            harnessDir: dir, level, total: 0, counts: {},
            offenders: [], failCount: 0, exitCode: 0,
          }, null, 2)],
        };
      }
      lines.push('  no advisories at the configured level');
      return { code: 0, lines };
    }
    if (bundle) {
      return {
        code: 1,
        lines: [JSON.stringify({ schema: 1, error: 'non-json-audit-output', exitCode, stderr }, null, 2)],
      };
    }
    lines.push(`  npm audit produced non-JSON output (exit ${exitCode})`);
    return { code: 1, lines };
  }

  const counts = parsed.metadata?.vulnerabilities ?? {};
  const levelIdx = LEVELS.indexOf(level as any);
  const failCount = LEVELS.slice(levelIdx).reduce((s, l) => s + (counts[l] ?? 0), 0);
  // npm's `metadata.vulnerabilities` object carries a `total` key alongside
  // the per-severity keys — summing Object.values() double-counts it. Sum
  // only the known severities.
  const total = LEVELS.reduce((s, l) => s + (counts[l] ?? 0), 0);
  const offenders = Object.entries<any>(parsed.vulnerabilities ?? {})
    .filter(([, v]) => LEVELS.indexOf((v as any).severity) >= levelIdx)
    .map(([name, v]) => ({ name, severity: (v as any).severity, advisory: (v as any).via?.[0]?.title ?? null }));
  const code = failCount === 0 ? 0 : 1;

  // iter: `--omit=dev` is the default (matches the standard two-tier CI
  // pattern — gate on prod, report on everything), but a bare "PASS: 0
  // advisories" gave no signal that devDependencies were excluded from the
  // count at all, even when they carry a critical advisory. devDependencies
  // execute during npm ci/test/build (CI/build-time attack surface — see
  // the 2026 node-ipc and Shai-Hulud npm supply-chain incidents, both of
  // which exfiltrated CI credentials via compromised build-time packages)
  // so a silent PASS here can look cleaner than the real dependency tree
  // is. Surface the suppressed count without changing default pass/fail
  // semantics — a second `npm audit` scoped to metadata only, best-effort.
  let suppressed: { total: number; atLevelOrAbove: number } | null = null;
  if (!includeDev) {
    try {
      const allArgs = ['audit', '--json', `--audit-level=${level}`];
      // Like the primary call above: `npm audit` exits non-zero once
      // advisories at-or-above --audit-level exist, but still writes the
      // real report JSON to stdout — that's the expected, common case here
      // (it's exactly why the primary call has its own catch), so pull
      // stdout from the rejection instead of discarding it.
      let allStdout: string;
      try {
        const r = await execFile(npmCmd, process.platform === 'win32'
          ? ['/d', '/s', '/c', 'npm', ...allArgs] : allArgs,
          { cwd: dir, maxBuffer: 1024 * 1024 * 16, windowsHide: true });
        allStdout = r.stdout;
      } catch (e: any) {
        allStdout = e.stdout ?? '';
      }
      const allParsed = JSON.parse(allStdout);
      const allCounts = allParsed.metadata?.vulnerabilities ?? {};
      const allTotal = LEVELS.reduce((s, l) => s + (allCounts[l] ?? 0), 0);
      const allFailCount = LEVELS.slice(levelIdx).reduce((s, l) => s + (allCounts[l] ?? 0), 0);
      if (allTotal >= total && allFailCount >= failCount) {
        suppressed = { total: allTotal - total, atLevelOrAbove: allFailCount - failCount };
      }
    } catch { /* best-effort disclosure only — never fails the command */ }
  }

  if (bundle) {
    return {
      code,
      lines: [JSON.stringify({
        schema: 1,
        generatedAt: new Date().toISOString(),
        harnessDir: dir,
        level,
        total,
        counts,
        offenders,
        failCount,
        exitCode: code,
        ...(suppressed ? { devDependenciesSuppressed: suppressed } : {}),
      }, null, 2)],
    };
  }

  lines.push(`  total advisories: ${total}`);
  lines.push(`  per severity: ${LEVELS.map(l => `${l}=${counts[l] ?? 0}`).join(', ')}`);
  if (suppressed && (suppressed.total > 0 || suppressed.atLevelOrAbove > 0)) {
    lines.push(`  devDependencies not counted: ${suppressed.total} advisories (${suppressed.atLevelOrAbove} at ${level}+) — re-run with --include-dev to see them`);
  }
  if (failCount === 0) {
    lines.push(`  PASS: 0 advisories at ${level}+`);
    return { code: 0, lines };
  }
  const offenderText = offenders.slice(0, 5).map(o => `${o.name}(${o.severity})`);
  lines.push(`  FAIL: ${failCount} advisories at ${level}+: ${offenderText.join(', ')}`);
  return { code: 1, lines };
}
