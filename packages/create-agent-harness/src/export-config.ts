// SPDX-License-Identifier: MIT
//
// `harness export-config` — emit the harness's security-relevant config
// as a single JSON for sharing or auditing without zipping the whole
// repo.
//
// Use case: "is my MCP policy reasonable? what about my Bash allowlist?"
// Users paste the export-config output into a discussion / GitHub
// issue / security review without having to scrub the rest of their
// harness.
//
// Sanitisation is the same contract as iter-90's diag --bundle:
// object keys matching /^(secret|token|key|password|api[-_]?key)/i
// are replaced with "<redacted>".

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redactSecretsDeep } from './redact.js';

export type SubcommandResult = { code: number; lines: string[] };

// iter 97: deliberately less anchored than iter-90's bundle regex.
// Export-config is meant for security/audit sharing, where the cost of
// over-redacting is much lower than the cost of leaking. We match the
// pattern ANYWHERE in the key — `OPENAI_API_KEY`, `GITHUB_TOKEN`,
// `db_password`, and the iter-90-style `secret_token` all redact.
// False positive: a key named literally `notakey` redacts. Acceptable
// for an audit-share artefact.
const REDACT_KEY_RE = /(secret|token|key|password|passphrase)/i;

// GH #4 (HIGH-2): redact by KEY name AND by VALUE shape (redact.ts — single source of truth, #7).
function redact(v: unknown): unknown {
  return redactSecretsDeep(v, { keyRe: REDACT_KEY_RE, replacement: '<redacted>' });
}

export interface ExportedConfig {
  schema: 1;
  generatedAt: string;
  harnessDir: string;
  host: string | undefined;
  mcpServers: unknown;
  claudeSettings: { allow?: string[]; deny?: string[]; mcp?: unknown } | undefined;
  codexConfig: unknown | undefined;
  manifestMeta: { surface?: string; kernel_version?: string } | undefined;
  hosts: string[];
}

export async function buildExportedConfig(harnessDir: string): Promise<ExportedConfig> {
  // .mcp/servers.json — the user's MCP wiring
  let mcpServers: unknown = undefined;
  const mcpPath = join(harnessDir, '.mcp', 'servers.json');
  if (existsSync(mcpPath)) {
    try {
      mcpServers = redact(JSON.parse(await readFile(mcpPath, 'utf-8')));
    } catch {
      mcpServers = '<unreadable>';
    }
  }

  // .claude/settings.json — host-specific allow/deny + MCP wiring
  let claudeSettings: ExportedConfig['claudeSettings'] = undefined;
  const claudePath = join(harnessDir, '.claude', 'settings.json');
  if (existsSync(claudePath)) {
    try {
      claudeSettings = redact(JSON.parse(await readFile(claudePath, 'utf-8'))) as ExportedConfig['claudeSettings'];
    } catch {
      /* swallow */
    }
  }

  // .codex/config.toml — present as a string (TOML doesn't need
  // sanitisation; users put secrets in env vars referenced by the toml)
  let codexConfig: unknown = undefined;
  const codexPath = join(harnessDir, '.codex', 'config.toml');
  if (existsSync(codexPath)) {
    try {
      // Emit the TOML as a string so the bundle stays single-JSON
      const raw = await readFile(codexPath, 'utf-8');
      // Strip obvious secret-looking lines: `<key> = "..."` where
      // <key> matches the redaction regex
      codexConfig = raw.split('\n').map(line => {
        const m = line.match(/^\s*(\w+)\s*=\s*".*"\s*$/);
        if (m && REDACT_KEY_RE.test(m[1])) {
          return line.replace(/"[^"]*"/, '"<redacted>"');
        }
        return line;
      }).join('\n');
    } catch {
      /* swallow */
    }
  }

  // Manifest meta (iter 56 + iter 58)
  let manifestMeta: ExportedConfig['manifestMeta'] = undefined;
  let hosts: string[] = [];
  let host: string | undefined;
  const manifestPath = join(harnessDir, '.harness', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(await readFile(manifestPath, 'utf-8'));
      manifestMeta = m.meta;
      hosts = Array.isArray(m.hosts) ? m.hosts : [];
      host = m.vars?.host ?? hosts[0];
    } catch {
      /* swallow */
    }
  }

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    harnessDir,
    host,
    mcpServers,
    claudeSettings,
    codexConfig,
    manifestMeta,
    hosts,
  };
}

export async function exportConfigCmd(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());

  if (!existsSync(join(dir, '.harness', 'manifest.json'))) {
    return {
      code: 2,
      lines: [
        `harness export-config — checking ${dir}`,
        '',
        `  FAIL no .harness/manifest.json found at this path`,
        `       (this directory is not a scaffolded harness — run`,
        `       harness export-config from a harness root)`,
      ],
    };
  }

  const config = await buildExportedConfig(dir);
  return {
    code: 0,
    lines: [JSON.stringify(config, null, 2)],
  };
}
