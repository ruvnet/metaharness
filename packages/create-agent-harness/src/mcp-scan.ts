// SPDX-License-Identifier: MIT
//
// `harness mcp-scan [path]` — a security scanner for a scaffolded harness's MCP
// surface. "npm audit for agent tools" (ADR-022): it reads the harness's MCP
// policy + host configs + package manifest and flags the patterns that make MCP
// servers risky — broad shell/network/file-write grants, missing timeouts,
// missing audit log, wildcard tool permissions, unpinned deps, and secret-read
// exposure.
//
// Pure + dependency-light on purpose: `scanMcp()` takes a directory and returns
// structured findings, so it is unit-testable without the kernel and reusable
// from CI. The CLI wrapper just formats + sets the exit code.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface ScanReport {
  dir: string;
  mcpEnabled: boolean;
  findings: Finding[];
  /** Highest severity present, or 'info' when clean. */
  worst: Severity;
}

const SEV_ORDER: Severity[] = ['info', 'low', 'medium', 'high'];

function readJson(path: string): unknown | undefined {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Scan a harness directory for MCP security issues. Never executes anything —
 * static inspection of policy + config + manifest files only.
 */
export function scanMcp(dir: string): ScanReport {
  const root = resolve(dir);
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  const policy = readJson(join(root, '.harness', 'mcp-policy.json')) as Record<string, unknown> | undefined;
  const settings = readJson(join(root, '.claude', 'settings.json')) as
    | { permissions?: { allow?: string[]; deny?: string[] }; mcpServers?: Record<string, unknown> }
    | undefined;
  const pkg = readJson(join(root, 'package.json')) as
    | { dependencies?: Record<string, string> }
    | undefined;

  const mcpEnabled =
    !!policy || !!(settings && settings.mcpServers && Object.keys(settings.mcpServers).length > 0);

  if (!mcpEnabled) {
    add({ id: 'mcp-disabled', severity: 'info', title: 'No MCP surface', detail: 'No MCP policy or server registered — nothing to scan.' });
    return { dir: root, mcpEnabled: false, findings, worst: worstOf(findings) };
  }

  // --- policy checks -------------------------------------------------------
  if (!policy) {
    add({ id: 'no-policy', severity: 'high', title: 'MCP server with no policy', detail: 'An MCP server is registered but .harness/mcp-policy.json is missing — execution is ungoverned.' });
  } else {
    if (policy.defaultDeny !== true) {
      add({ id: 'no-default-deny', severity: 'high', title: 'Policy is not default-deny', detail: 'defaultDeny should be true so ungranted capabilities are refused, not silently allowed.' });
    }
    if (policy.allowShell === true) {
      add({ id: 'allow-shell', severity: 'high', title: 'Shell access granted', detail: 'allowShell=true lets tools run arbitrary commands. Gate behind approval or disable.' });
    }
    if (policy.allowNetwork === true) {
      add({ id: 'allow-network', severity: 'medium', title: 'Network access granted', detail: 'allowNetwork=true widens the exfiltration surface. Scope to specific hosts if possible.' });
    }
    if (policy.allowFileWrite === true) {
      add({ id: 'allow-file-write', severity: 'medium', title: 'File-write access granted', detail: 'allowFileWrite=true lets tools modify the filesystem. Confirm this is intended.' });
    }
    if (policy.requireApprovalForDangerous !== true) {
      add({ id: 'no-approval-gate', severity: 'medium', title: 'No approval gate for dangerous tools', detail: 'requireApprovalForDangerous should be true so dangerous tools need explicit consent.' });
    }
    if (policy.auditLog !== true) {
      add({ id: 'no-audit-log', severity: 'medium', title: 'Audit log disabled', detail: 'auditLog=false means tool calls are not recorded — required for enterprise trust.' });
    }
    const timeout = Number(policy.toolTimeoutMs ?? 0);
    if (!timeout || timeout <= 0) {
      add({ id: 'no-timeout', severity: 'medium', title: 'No tool timeout', detail: 'toolTimeoutMs must be a positive number so a hung tool cannot stall the agent.' });
    }
    const maxCalls = Number(policy.maxToolCallsPerTurn ?? 0);
    if (!maxCalls || maxCalls <= 0) {
      add({ id: 'no-call-budget', severity: 'low', title: 'No per-turn tool-call budget', detail: 'maxToolCallsPerTurn bounds runaway loops; set a positive limit.' });
    }
  }

  // --- host permission checks ---------------------------------------------
  const allow = settings?.permissions?.allow ?? [];
  const deny = settings?.permissions?.deny ?? [];
  for (const a of allow) {
    if (a === '*' || a === 'mcp__*' || a === 'mcp__*__*') {
      add({ id: 'wildcard-tool-perm', severity: 'high', title: `Over-broad tool permission: ${a}`, detail: 'Wildcard MCP permissions grant every tool on every server. Scope to mcp__<server>__*.' });
    }
    if (/^Bash\((rm|curl|wget|sudo|chmod|ssh)\b/i.test(a) && !a.includes('status') && !a.includes('--dry-run')) {
      add({ id: 'risky-bash-allow', severity: 'medium', title: `Risky shell allow-rule: ${a}`, detail: 'Allowing rm/curl/wget/sudo/ssh broadly is dangerous; narrow the glob.' });
    }
  }
  const guardsEnv = deny.some((d) => /\.env/.test(d));
  if (!guardsEnv) {
    add({ id: 'no-secret-guard', severity: 'medium', title: 'Secrets not denied', detail: 'permissions.deny should block Read(./.env*) so tools cannot read credentials.' });
  }

  // --- dependency pinning --------------------------------------------------
  const deps = pkg?.dependencies ?? {};
  const unpinned = Object.entries(deps).filter(([, v]) => /^[\^~]/.test(v) || v === 'latest' || v.includes('*'));
  if (unpinned.length > 0) {
    add({
      id: 'unpinned-deps',
      severity: 'low',
      title: `${unpinned.length} unpinned dependency range(s)`,
      detail: `Floating ranges weaken supply-chain reproducibility: ${unpinned.map(([k]) => k).join(', ')}.`,
    });
  }

  if (findings.length === 0) {
    add({ id: 'clean', severity: 'info', title: 'No MCP security issues found', detail: 'Policy is default-deny with safe capability grants and an audit log.' });
  }

  return { dir: root, mcpEnabled: true, findings, worst: worstOf(findings) };
}

function worstOf(findings: Finding[]): Severity {
  let worst: Severity = 'info';
  for (const f of findings) {
    if (SEV_ORDER.indexOf(f.severity) > SEV_ORDER.indexOf(worst)) worst = f.severity;
  }
  return worst;
}

/** CLI wrapper. Exit code 1 if any HIGH finding, else 0. */
export function mcpScanCmd(args: string[]): { code: number; lines: string[] } {
  // Honor --json (issue #16): emit the structured report so downstream code can
  // read report.findings[] instead of parsing text. Flags are ignored when
  // resolving the scan path, so `mcp-scan --json` (no path) defaults to cwd.
  const json = args.includes('--json');
  const dir = args.find((a) => !a.startsWith('-')) ?? process.cwd();
  const report = scanMcp(dir);
  const highsCount = report.findings.filter((f) => f.severity === 'high').length;
  if (json) {
    return { code: highsCount > 0 ? 1 : 0, lines: [JSON.stringify(report, null, 2)] };
  }
  const lines: string[] = [`harness mcp-scan — ${report.dir}`, ''];
  if (!report.mcpEnabled) {
    lines.push('MCP: not enabled (no policy or server). Nothing to scan.');
    return { code: 0, lines };
  }
  const order: Severity[] = ['high', 'medium', 'low', 'info'];
  const tag: Record<Severity, string> = { high: 'HIGH', medium: 'MED ', low: 'LOW ', info: 'INFO' };
  for (const sev of order) {
    for (const f of report.findings.filter((x) => x.severity === sev)) {
      lines.push(`  [${tag[sev]}] ${f.title}`);
      lines.push(`         ${f.detail}`);
    }
  }
  const highs = report.findings.filter((f) => f.severity === 'high').length;
  lines.push('', `Result: ${report.worst.toUpperCase()} (${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}, ${highs} high)`);
  return { code: highs > 0 ? 1 : 0, lines };
}
