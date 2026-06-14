#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/dev-toolkit.mjs — single-command repo orientation map.
//
// Lists every dev script + harness subcommand + key CI gate so a new
// contributor doesn't have to spelunk through 50+ iters of CHANGELOG
// to find the right tool. Plain-text by default; --json for tooling.
//
// Run:
//   node scripts/dev-toolkit.mjs
//   node scripts/dev-toolkit.mjs --json
//   node scripts/dev-toolkit.mjs --filter=release
//   node scripts/dev-toolkit.mjs --check-health
//
// What's catalogued:
//   - Every scripts/*.mjs (read 1-line summary from JSDoc-ish comments)
//   - Every harness subcommand
//   - The 16-job CI matrix at a high level
//   - Key validation entry points (healthcheck / preflight / release)
//
// What's NOT in this script:
//   - ADRs (they live in docs/adrs/)
//   - Per-package READMEs (`ls packages/*/README.md`)

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const filter = args.find(a => a.startsWith('--filter='))?.slice('--filter='.length);
const CHECK_HEALTH = args.includes('--check-health');

const HARNESS_SUBCOMMANDS = [
  { name: 'sign', summary: 'Produce or update the Ed25519 witness manifest', iter: 8 },
  { name: 'verify', summary: 'Verify the witness manifest signature', iter: 8 },
  { name: 'doctor', summary: 'Smoke-check a scaffolded harness', iter: 8 },
  { name: 'federate', summary: 'Manage federation peers (init/add/remove/list/status)', iter: 9 },
  { name: 'secrets', summary: 'GCP Secret Manager: check / fetch / validate-token', iter: 18 },
  { name: 'validate', summary: 'Umbrella check: doctor + verify + path-guard + mcp + secrets', iter: 20 },
  { name: 'mcp', summary: 'List MCP servers / dispatch a tool through the claim check', iter: 45 },
  { name: 'publish', summary: 'Pin the harness manifest to IPFS via Pinata (dry-run default)', iter: 46 },
  { name: 'upgrade', summary: 'Re-render template + drift plan (--apply to apply)', iter: 47 },
  { name: 'completions', summary: 'Emit shell completion (bash | zsh | fish)', iter: 48 },
  { name: 'sbom', summary: 'Emit SPDX-2.3 SBOM for the harness (npm)', iter: 51 },
  { name: 'audit', summary: 'npm audit per-harness with structured output', iter: 51 },
  { name: 'mcp-scan', summary: 'Security-scan the harness MCP surface (policy + perms + deps)', iter: 55 },
  { name: 'analyze-repo', summary: 'Recommend a harness from a local repo (--embed for ruvllm)', iter: 55 },
  { name: 'diag', summary: 'Kernel-version skew check (ADR-027 diagnostic)', iter: 66 },
];

async function listScripts() {
  const scripts = [];
  const dir = join(ROOT, 'scripts');
  const entries = await readdir(dir);
  for (const file of entries.filter(f => f.endsWith('.mjs') || f.endsWith('.sh'))) {
    let summary = '';
    try {
      const text = await readFile(join(dir, file), 'utf-8');
      // Pull the first non-shebang, non-SPDX comment block as the summary
      const lines = text.split('\n').slice(0, 30);
      for (const l of lines) {
        const m = l.match(/^(?:#|\/\/) *(.+)$/);
        if (m && !m[1].includes('SPDX') && !m[1].startsWith('!') && !m[1].includes('scripts/')) {
          summary = m[1].trim();
          break;
        }
      }
    } catch { /* */ }
    scripts.push({ path: `scripts/${file}`, summary });
  }
  return scripts;
}

function ciSummary() {
  return {
    name: 'CI matrix (16 jobs)',
    jobs: [
      { name: 'Rust × 3 OS', what: 'cargo fmt --check / clippy -D warnings / cargo test / cargo doc' },
      { name: 'WASM × 3 OS', what: 'wasm-pack build + wasm-tools validate + 500 KB size budget' },
      { name: 'Node 20+22 × 3 OS', what: 'TS build + vitest + path-guard + healthcheck (iter 43)' },
      { name: 'pack+install × 3 OS', what: 'npm pack every package + batch install (iter 31)' },
      { name: 'Bench (smoke)', what: 'Memory bench + host-bench + perf regression gate (iter 54)' },
      { name: 'CI passed', what: 'Final aggregator job for branch-protection' },
    ],
  };
}

function entryPoints() {
  return [
    { name: 'healthcheck', cmd: 'node scripts/healthcheck.mjs', when: 'Per-commit (<1s, 6 checks)', iter: 42 },
    { name: 'preflight', cmd: 'node scripts/preflight.mjs', when: 'Pre-release (~30s)', iter: 14 },
    { name: 'release', cmd: 'node scripts/release.mjs <bump> [--push]', when: 'Release (~60s)', iter: 33 },
    { name: 'sbom', cmd: 'node scripts/sbom.mjs', when: 'Per-tag (CI artifact, ~1s)', iter: 50 },
    { name: 'audit-deps', cmd: 'node scripts/audit-deps.mjs', when: 'Security gate', iter: 38 },
    { name: 'bench-baseline', cmd: 'node scripts/bench-baseline.mjs --current=...', when: 'Perf gate', iter: 53 },
  ];
}

function matches(name, filterStr) {
  if (!filterStr) return true;
  return name.toLowerCase().includes(filterStr.toLowerCase());
}

async function checkHealth() {
  const missing = [];
  for (const p of ['scripts/healthcheck.mjs', 'scripts/preflight.mjs', 'scripts/release.mjs', 'scripts/sbom.mjs', 'scripts/audit-deps.mjs', 'scripts/bench-baseline.mjs']) {
    if (!existsSync(join(ROOT, p))) missing.push(p);
  }
  return { missing, ok: missing.length === 0 };
}

async function main() {
  const scripts = (await listScripts()).filter(s => matches(s.path, filter));
  const subs = HARNESS_SUBCOMMANDS.filter(s => matches(s.name, filter));
  const entry = entryPoints().filter(s => matches(s.name, filter));
  const ci = ciSummary();
  const health = CHECK_HEALTH ? await checkHealth() : null;

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ scripts, harnessSubcommands: subs, entryPoints: entry, ci, health }, null, 2) + '\n');
    process.exit(CHECK_HEALTH && !health?.ok ? 1 : 0);
  }

  const log = (...args) => process.stdout.write(args.join(' ') + '\n');
  log('agent-harness-generator — dev toolkit');
  log('');
  log('## Entry points (which command for which moment)');
  for (const e of entry) {
    log(`  ${e.name.padEnd(18)} ${e.cmd.padEnd(50)} ${e.when}`);
  }
  log('');
  log(`## Dev scripts (scripts/*.mjs) — ${scripts.length} listed`);
  for (const s of scripts) {
    log(`  ${s.path.padEnd(40)} ${s.summary.slice(0, 100)}`);
  }
  log('');
  log(`## harness subcommands (${HARNESS_SUBCOMMANDS.length} total) — ${subs.length} listed`);
  for (const s of subs) {
    log(`  harness ${s.name.padEnd(12)} (iter ${String(s.iter).padStart(2)}) — ${s.summary}`);
  }
  log('');
  log(`## ${ci.name}`);
  for (const j of ci.jobs) {
    log(`  ${j.name.padEnd(22)} ${j.what}`);
  }
  log('');
  log('## More');
  log('  ADRs:          docs/adrs/INDEX.md');
  log('  Architecture:  docs/ARCHITECTURE.md');
  log('  Release:       docs/RELEASE.md');
  log('  Usage:         docs/USAGE.md');
  log('  Contributing:  CONTRIBUTING.md');

  if (health && !health.ok) {
    process.stderr.write(`\n[dev-toolkit] FAIL: missing scripts: ${health.missing.join(', ')}\n`);
    process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[dev-toolkit] FAIL: ${err?.stack ?? err}\n`);
  process.exit(1);
});
