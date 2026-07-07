// SPDX-License-Identifier: MIT
//
// `harness threat-model <path>` — 20th subcommand (iter 112). Priority 5 from
// the user's roadmap ("enterprise gold"). Surfaces the existing mcp-scan
// findings as a clean, scannable threat-model artifact ready for a PR review
// or security/compliance review.
//
// Output (the exact shape the user named):
//   MCP Threat Model
//   Allowed tools:        3
//   Denied tools:         14
//   Dangerous permissions: 0
//   Secrets reachable:    no
//   Network access:       no
//   Shell access:         no
//   File write:           no
//
// Modes: text (default) · --json · --bundle (ADR-031 schema-1 envelope) ·
//        --out <file>.
//
// Verdict + exit code:
//   - 0 — clean threat model (no dangerous perms, no secret exposure)
//   - 1 — medium concerns (network OR file-write granted, OR no audit log)
//   - 2 — high concerns (shell granted OR default-deny off OR secrets reachable)

import { existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanMcp, type Severity } from './mcp-scan.js';
import { redactSecretsDeep } from './redact.js';

export type SubcommandResult = { code: number; lines: string[] };

export interface ThreatModel {
  schema: 1;
  generatedAt: string;
  dir: string;
  mcpInUse: boolean;
  allowedTools: number;
  deniedTools: number;
  dangerousPermissions: number;
  secretsReachable: boolean;
  networkAccess: boolean;
  shellAccess: boolean;
  fileWrite: boolean;
  policyDefaultDeny: boolean | null; // null when no policy
  auditLog: boolean | null;
  findings: Array<{ id: string; severity: Severity; title: string }>;
  worst: Severity;
  verdict: 'clean' | 'medium' | 'high';
  exitCode: 0 | 1 | 2;
}

function safeReadJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function buildThreatModel(dir: string, generatedAt: string = new Date().toISOString()): ThreatModel {
  const root = resolve(dir);
  const policy = safeReadJson(join(root, '.harness', 'mcp-policy.json'));
  const settings = safeReadJson(join(root, '.claude', 'settings.json'));
  const mcpInUse = policy != null || safeReadJson(join(root, '.mcp.json')) != null;

  // mcp-scan returns the structured findings; we collapse to counters.
  const scan = scanMcp(root);

  const allow: string[] = settings?.permissions?.allow ?? [];
  const deny: string[] = settings?.permissions?.deny ?? [];

  const allowedTools = allow.length;
  const deniedTools = deny.length;

  const policyDefaultDeny = policy ? policy.defaultDeny === true : null;
  const auditLog = policy ? policy.auditLog === true : null;
  const shellAccess = policy?.allowShell === true;
  const networkAccess = policy?.allowNetwork === true;
  const fileWrite = policy?.allowFileWrite === true;
  // "Secrets reachable" = there is no .env-blocking deny rule AND tools have
  // some non-trivial read permission. Conservative: true if allow has any
  // Read(*) rule and deny doesn't block .env.
  const guardsEnv = deny.some((d) => /\.env/.test(d));
  const hasReadAllow = allow.some((a) => /^Read/.test(a));
  const secretsReachable = mcpInUse && !guardsEnv && hasReadAllow;

  // Count "dangerous permissions" = high-severity findings from mcp-scan +
  // the top-level boolean knobs the user named.
  let dangerousPermissions = 0;
  if (shellAccess) dangerousPermissions++;
  if (networkAccess) dangerousPermissions++;
  if (fileWrite) dangerousPermissions++;
  if (secretsReachable) dangerousPermissions++;
  if (policy && policyDefaultDeny === false) dangerousPermissions++;

  let verdict: 'clean' | 'medium' | 'high';
  let exitCode: 0 | 1 | 2;
  if (shellAccess || policyDefaultDeny === false || secretsReachable) {
    verdict = 'high';
    exitCode = 2;
  } else if (networkAccess || fileWrite || (mcpInUse && auditLog === false)) {
    verdict = 'medium';
    exitCode = 1;
  } else {
    verdict = 'clean';
    exitCode = 0;
  }

  return {
    schema: 1,
    generatedAt,
    dir: root,
    mcpInUse,
    allowedTools,
    deniedTools,
    dangerousPermissions,
    secretsReachable,
    networkAccess,
    shellAccess,
    fileWrite,
    policyDefaultDeny,
    auditLog,
    findings: scan.findings.map((f) => ({ id: f.id, severity: f.severity, title: f.title })),
    worst: scan.worst,
    verdict,
    exitCode,
  };
}

// --- formatting ------------------------------------------------------------

function yn(b: boolean): string {
  return b ? 'yes' : 'no';
}

export function formatThreatModel(tm: ThreatModel): string[] {
  const out: string[] = [];
  out.push('MCP Threat Model');
  out.push('');
  if (!tm.mcpInUse) {
    out.push('  mcp surface:         off (no .mcp.json, no .harness/mcp-policy.json)');
    out.push('  threat surface:      none — MCP is not in use');
    out.push('');
    out.push('Verdict: clean (exit 0)');
    return out;
  }
  out.push(`  Allowed tools:        ${tm.allowedTools}`);
  out.push(`  Denied tools:         ${tm.deniedTools}`);
  out.push(`  Dangerous permissions: ${tm.dangerousPermissions}`);
  out.push(`  Secrets reachable:    ${yn(tm.secretsReachable)}`);
  out.push(`  Network access:       ${yn(tm.networkAccess)}`);
  out.push(`  Shell access:         ${yn(tm.shellAccess)}`);
  out.push(`  File write:           ${yn(tm.fileWrite)}`);
  if (tm.policyDefaultDeny !== null) {
    out.push(`  Default-deny policy:  ${yn(tm.policyDefaultDeny)}`);
  }
  if (tm.auditLog !== null) {
    out.push(`  Audit log:            ${yn(tm.auditLog)}`);
  }
  if (tm.findings.length > 0) {
    out.push('');
    out.push('Findings:');
    for (const f of tm.findings) {
      out.push(`  [${f.severity.toUpperCase().padEnd(6)}] ${f.id} — ${f.title}`);
    }
  }
  out.push('');
  out.push(`Verdict: ${tm.verdict} (exit ${tm.exitCode})`);
  if (tm.verdict !== 'clean') {
    out.push('Run: harness mcp-scan ' + tm.dir + '   # for the full finding list');
  }
  return out;
}

// --- sanitisation (ADR-031) ------------------------------------------------

const SECRET_RE = /(secret|token|key|password|passphrase)/i;

// GH #4 (HIGH-2): redact by KEY name AND by VALUE shape (redact.ts — single source of truth, #7).
function sanitise(v: unknown): unknown {
  return redactSecretsDeep(v, { keyRe: SECRET_RE, replacement: '[REDACTED]' });
}

// --- dispatch --------------------------------------------------------------

function usage(): string[] {
  return [
    'Usage: harness threat-model <path> [--out <file>] [--json] [--bundle]',
    '',
    '  MCP threat-model artifact — scannable in a PR or compliance review.',
    '  Reports allowed/denied tools, dangerous permissions, secret reachability,',
    '  network/shell/file-write grants, default-deny policy posture.',
    '',
    '  --out <file>   Write the JSON artifact to <file>.',
    '  --json         Emit JSON to stdout instead of text.',
    '  --bundle       Emit the full report as an ADR-031 schema-1 envelope.',
  ];
}

export async function threatModelCmd(args: string[]): Promise<SubcommandResult> {
  const bundle = args.includes('--bundle');
  const json = args.includes('--json');
  let outPath: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') {
      outPath = args[++i] ?? null;
      if (!outPath) {
        const err = { schema: 1 as const, error: 'missing-out-path', exitCode: 2 };
        return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : '--out requires a file path'] };
      }
    } else if (a === '--bundle' || a === '--json') {
      /* handled */
    } else if (a === '--help' || a === '-h') {
      return { code: 0, lines: usage() };
    } else if (a && !a.startsWith('--')) {
      positional.push(a);
    } else if (a) {
      const err = { schema: 1 as const, error: `unknown-flag-${a.replace(/^--?/, '')}`, exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `Unknown flag: ${a}`] };
    }
  }

  if (positional.length === 0) {
    return { code: 2, lines: usage() };
  }

  const dir = resolve(positional[0]!);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    const generatedAt = new Date().toISOString();
    const err = { schema: 1 as const, generatedAt, error: 'not-a-directory', dir, exitCode: 2 };
    if (bundle || json) return { code: 2, lines: [JSON.stringify(err, null, 2)] };
    return { code: 2, lines: [`harness threat-model: not a directory: ${dir}`] };
  }

  const tm = buildThreatModel(dir);

  if (outPath) {
    try {
      writeFileSync(resolve(outPath), JSON.stringify(tm, null, 2) + '\n', 'utf-8');
    } catch (e) {
      const err = { schema: 1 as const, error: 'out-write-failed', detail: String(e), exitCode: 2 };
      return { code: 2, lines: [bundle || json ? JSON.stringify(err, null, 2) : `harness threat-model: failed to write --out: ${String(e)}`] };
    }
  }

  if (bundle) {
    return { code: tm.exitCode, lines: [JSON.stringify(sanitise(tm), null, 2)] };
  }
  if (json) {
    return { code: tm.exitCode, lines: [JSON.stringify(tm, null, 2)] };
  }
  return { code: tm.exitCode, lines: formatThreatModel(tm) };
}
