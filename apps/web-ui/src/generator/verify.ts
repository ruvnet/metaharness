// SPDX-License-Identifier: MIT
//
// Browser-side harness verifier — the engine behind the Studio's "Verify" tab.
// Takes a file map (either the live scaffold or an unzipped download) and runs
// the same class of checks the CLI's `harness validate` + `harness mcp-scan`
// run, but purely in-memory so it works on GitHub Pages with no backend and no
// upload. Pure + deterministic; unit-tested.

import type { GenFile } from './types';

export type Severity = 'high' | 'medium' | 'low' | 'info' | 'pass';

export interface Check {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface VerifyReport {
  checks: Check[];
  passed: number;
  failed: number;
  /** true when there are no high/medium failures. */
  ok: boolean;
}

function find(files: GenFile[], path: string): GenFile | undefined {
  return files.find((f) => f.path === path);
}

export function verifyFileMap(files: GenFile[]): VerifyReport {
  const checks: Check[] = [];
  const pass = (id: string, title: string) => checks.push({ id, severity: 'pass', title, detail: 'OK' });
  const fail = (id: string, severity: Severity, title: string, detail: string) => checks.push({ id, severity, title, detail });

  // --- structure ----------------------------------------------------------
  const pkg = find(files, 'package.json');
  if (!pkg) {
    fail('pkg-missing', 'high', 'package.json present', 'No package.json — not a publishable harness.');
  } else {
    try {
      const parsed = JSON.parse(pkg.content);
      if (parsed.name && typeof parsed.name === 'string') pass('pkg-name', 'package.json has a name');
      else fail('pkg-name', 'high', 'package.json has a name', 'Missing or non-string name.');
      if (parsed.dependencies?.['@ruflo/kernel']) pass('kernel-dep', 'declares @ruflo/kernel');
      else fail('kernel-dep', 'medium', 'declares @ruflo/kernel', 'Harness should depend on @ruflo/kernel.');
    } catch {
      fail('pkg-json', 'high', 'package.json is valid JSON', 'package.json does not parse.');
    }
  }

  if (find(files, '.harness/manifest.json')) pass('manifest', '.harness/manifest.json present');
  else fail('manifest', 'medium', '.harness/manifest.json present', 'Missing generator manifest (drift detection).');

  const hostArtifacts = ['.claude/settings.json', '.codex/config.toml', 'AGENTS.md', 'cli-config.yaml', '.openclaw/openclaw.json', 'rvm.manifest.toml'];
  if (hostArtifacts.some((p) => find(files, p))) pass('host', 'at least one host adapter wired');
  else fail('host', 'medium', 'at least one host adapter wired', 'No host config (.claude/.codex/AGENTS.md/…).');

  // --- no unresolved template vars ----------------------------------------
  const unresolved = files.filter((f) => /\{\{[a-zA-Z_][\w]*\}\}/.test(f.content) && !f.path.endsWith('.json'));
  if (unresolved.length === 0) pass('no-unresolved', 'no unresolved {{template vars}}');
  else fail('no-unresolved', 'medium', 'no unresolved {{template vars}}', `Unresolved vars in: ${unresolved.map((f) => f.path).join(', ')}`);

  // --- MCP policy (if an MCP surface is present) ---------------------------
  const policyFile = find(files, '.harness/mcp-policy.json');
  const settings = find(files, '.claude/settings.json');
  let mcpServer = false;
  try {
    mcpServer = !!(settings && JSON.parse(settings.content).mcpServers);
  } catch {
    /* ignore */
  }
  if (policyFile || mcpServer) {
    if (!policyFile) {
      fail('mcp-no-policy', 'high', 'MCP server has a policy', 'MCP registered but no .harness/mcp-policy.json — ungoverned.');
    } else {
      try {
        const p = JSON.parse(policyFile.content);
        if (p.defaultDeny === true) pass('mcp-default-deny', 'MCP policy is default-deny');
        else fail('mcp-default-deny', 'high', 'MCP policy is default-deny', 'defaultDeny is not true.');
        if (p.allowShell === true) fail('mcp-shell', 'high', 'shell access gated', 'allowShell=true grants arbitrary commands.');
        else pass('mcp-shell', 'shell access gated');
        if (p.auditLog === true) pass('mcp-audit', 'audit log enabled');
        else fail('mcp-audit', 'medium', 'audit log enabled', 'auditLog=false — tool calls are not recorded.');
        if (Number(p.toolTimeoutMs) > 0) pass('mcp-timeout', 'tool timeout set');
        else fail('mcp-timeout', 'medium', 'tool timeout set', 'toolTimeoutMs missing or <= 0.');
      } catch {
        fail('mcp-policy-json', 'high', 'MCP policy is valid JSON', 'mcp-policy.json does not parse.');
      }
    }
  } else {
    checks.push({ id: 'mcp-off', severity: 'info', title: 'MCP not enabled', detail: 'No MCP surface to verify.' });
  }

  // --- secrets guard ------------------------------------------------------
  try {
    const deny: string[] = settings ? JSON.parse(settings.content).permissions?.deny ?? [] : [];
    if (!settings || deny.some((d) => /\.env/.test(d))) pass('secrets', 'secret reads denied');
    else fail('secrets', 'medium', 'secret reads denied', 'permissions.deny should block Read(./.env*).');
  } catch {
    /* ignore */
  }

  const failed = checks.filter((c) => c.severity === 'high' || c.severity === 'medium').length;
  const passed = checks.filter((c) => c.severity === 'pass').length;
  return { checks, passed, failed, ok: failed === 0 };
}
