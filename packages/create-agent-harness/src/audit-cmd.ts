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

  const lines: string[] = [`harness audit — ${dir} (level=${level})`];

  if (!LEVELS.includes(level as any)) {
    lines.push(`  unknown --level=${level} (use one of ${LEVELS.join(', ')})`);
    return { code: 2, lines };
  }

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    lines.push(`  no package.json at ${dir}`);
    return { code: 1, lines };
  }
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) {
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
      lines.push('  no advisories at the configured level');
      return { code: 0, lines };
    }
    lines.push(`  npm audit produced non-JSON output (exit ${exitCode})`);
    return { code: 1, lines };
  }

  const counts = parsed.metadata?.vulnerabilities ?? {};
  const levelIdx = LEVELS.indexOf(level as any);
  const failCount = LEVELS.slice(levelIdx).reduce((s, l) => s + (counts[l] ?? 0), 0);
  const total = Object.values<number>(counts).reduce((s, n) => s + (n ?? 0), 0);
  lines.push(`  total advisories: ${total}`);
  lines.push(`  per severity: ${LEVELS.map(l => `${l}=${counts[l] ?? 0}`).join(', ')}`);
  if (failCount === 0) {
    lines.push(`  PASS: 0 advisories at ${level}+`);
    return { code: 0, lines };
  }
  const offenders = Object.entries<any>(parsed.vulnerabilities ?? {})
    .filter(([, v]) => LEVELS.indexOf((v as any).severity) >= levelIdx)
    .map(([name, v]) => `${name}(${(v as any).severity})`)
    .slice(0, 5);
  lines.push(`  FAIL: ${failCount} advisories at ${level}+: ${offenders.join(', ')}`);
  return { code: 1, lines };
}
