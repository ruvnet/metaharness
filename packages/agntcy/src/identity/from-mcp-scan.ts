// SPDX-License-Identifier: MIT
//
// ADR-240 S2.1 operationalized: "badges are task-specific verifiable
// credentials. The natural source is the harness's own tool-policy
// allowlist, already computed by mcp-scan/threat-model -- every allowed
// tool scope becomes a candidate badge, not an arbitrary string a
// generator invents."
//
// The REAL mcp-scan / threat-model output shapes (verified via grep of
// this repo, not guessed) are:
//
//   packages/create-agent-harness/src/mcp-scan.ts
//     export type Severity = 'high' | 'medium' | 'low' | 'info';
//     export interface Finding { id: string; severity: Severity; title: string; detail: string; }
//     export interface ScanReport { dir: string; mcpEnabled: boolean; findings: Finding[]; worst: Severity; }
//
//   packages/create-agent-harness/src/threat-model.ts
//     export interface ThreatModel {
//       schema: 1; generatedAt: string; dir: string; mcpInUse: boolean;
//       allowedTools: number; deniedTools: number; dangerousPermissions: number;
//       secretsReachable: boolean; networkAccess: boolean; shellAccess: boolean;
//       fileWrite: boolean; policyDefaultDeny: boolean | null; auditLog: boolean | null;
//       findings: Array<{ id: string; severity: Severity; title: string }>;
//       worst: Severity; verdict: 'clean' | 'medium' | 'high'; exitCode: 0 | 1 | 2;
//     }
//
// Neither type literally carries a `string[]` of granted tool-permission
// scopes -- that raw list (`.claude/settings.json`'s
// `permissions.allow`) is read internally by scanMcp()/buildThreatModel()
// but is not part of either function's *returned* shape. What IS returned,
// and what genuinely signals "this scope is allowed" rather than "this
// scope is denied/risky," are:
//
//   - ThreatModel's capability-grant booleans: `shellAccess`,
//     `networkAccess`, `fileWrite` (computed directly from
//     `.harness/mcp-policy.json`'s `allowShell`/`allowNetwork`/
//     `allowFileWrite`), plus `mcpInUse` as the baseline read/tool-
//     invocation grant.
//   - ScanReport's `findings[]`, which scanMcp() only emits with id
//     'allow-shell' / 'allow-network' / 'allow-file-write' when the
//     corresponding policy.allow* flag is true (mcp-scan.ts lines
//     73-90 in this checkout) -- i.e. presence of that specific finding
//     IS the "this scope is granted" signal, not a risk to omit.
//     ('wildcard-tool-perm', 'risky-bash-allow', 'no-secret-guard', etc.
//     are deliberately NOT mapped to a badge -- they are risk findings
//     about ungoverned/dangerous grants, not "an allowed tool scope" in
//     the ADR-240 S2.1 sense.)
//
// This module reads exactly those real, already-computed signals -- no
// invented strings, no re-parsing of raw policy files this package
// (a dependency-free optional peer package, per its own package.json
// description and ADR-002's kernel-boundary discipline) has no path to.
// The input is typed `unknown` and narrowed structurally against the two
// shapes above, since this package must not import
// @metaharness/create-agent-harness as a hard dependency.

/**
 * Canonical badge scope strings this module emits. Stable across calls --
 * that stability is the whole point of ADR-240 S2.1's "candidate badge,"
 * not an arbitrary string a generator invents.
 */
export const MCP_SCAN_BADGE = {
  /** An MCP surface is enabled/in-use -- the baseline read/tool-invocation grant. */
  MCP_READ: 'mcp.read',
  SHELL_EXECUTE: 'shell.execute',
  NETWORK_ACCESS: 'network.access',
  FILE_WRITE: 'file.write',
} as const;

export type McpScanBadge = (typeof MCP_SCAN_BADGE)[keyof typeof MCP_SCAN_BADGE];

interface FindingLike {
  id?: unknown;
}

function isFindingArray(value: unknown): value is FindingLike[] {
  return Array.isArray(value) && value.every((f) => f !== null && typeof f === 'object');
}

/**
 * True when `value` structurally matches ThreatModel (buildThreatModel()'s
 * real return type) -- distinguished by the shellAccess/networkAccess/
 * fileWrite boolean triplet that only ThreatModel has.
 */
function looksLikeThreatModel(value: Record<string, unknown>): boolean {
  return (
    typeof value.shellAccess === 'boolean' &&
    typeof value.networkAccess === 'boolean' &&
    typeof value.fileWrite === 'boolean'
  );
}

/**
 * True when `value` structurally matches ScanReport (scanMcp()'s real
 * return type) -- has mcpEnabled + a findings array but not ThreatModel's
 * capability-grant booleans.
 */
function looksLikeScanReport(value: Record<string, unknown>): boolean {
  return typeof value.mcpEnabled === 'boolean' && isFindingArray(value.findings);
}

/**
 * Derive candidate AGNTCY badges (ADR-240 S2.1) from a real mcp-scan
 * (`scanMcp()`) or threat-model (`buildThreatModel()`) result.
 *
 * Every badge returned corresponds to a real granted-capability signal
 * already present in the harness's own tool-policy allowlist, as computed
 * by those existing functions -- never an arbitrary string this module
 * invents. Returns a de-duplicated, sorted array; empty when no capability
 * signal is present, or when `mcpScanResult` doesn't structurally match
 * either known shape.
 */
export function deriveBadgesFromMcpScan(mcpScanResult: unknown): string[] {
  if (!mcpScanResult || typeof mcpScanResult !== 'object') {
    return [];
  }
  const v = mcpScanResult as Record<string, unknown>;
  const badges = new Set<string>();

  if (looksLikeThreatModel(v)) {
    if (v.mcpInUse === true) badges.add(MCP_SCAN_BADGE.MCP_READ);
    if (v.shellAccess === true) badges.add(MCP_SCAN_BADGE.SHELL_EXECUTE);
    if (v.networkAccess === true) badges.add(MCP_SCAN_BADGE.NETWORK_ACCESS);
    if (v.fileWrite === true) badges.add(MCP_SCAN_BADGE.FILE_WRITE);
    return [...badges].sort();
  }

  if (looksLikeScanReport(v)) {
    if (v.mcpEnabled === true) badges.add(MCP_SCAN_BADGE.MCP_READ);
    const findings = v.findings as FindingLike[];
    for (const f of findings) {
      if (f.id === 'allow-shell') badges.add(MCP_SCAN_BADGE.SHELL_EXECUTE);
      if (f.id === 'allow-network') badges.add(MCP_SCAN_BADGE.NETWORK_ACCESS);
      if (f.id === 'allow-file-write') badges.add(MCP_SCAN_BADGE.FILE_WRITE);
    }
    return [...badges].sort();
  }

  return [];
}
