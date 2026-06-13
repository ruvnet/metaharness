// SPDX-License-Identifier: MIT
//
// End-to-end integration test:
//   1. scaffold() a minimal harness into a tmpdir
//   2. assert the file shape the rest of the system relies on
//   3. run `harness validate` (umbrella) on the scaffolded result
//   4. assert it reports HEALTHY
//
// This is the strongest cross-iter signal — it walks scaffolder (iter 4),
// witness shape (iter 3/8), path-guard (iter 16), MCP config (iter 8),
// and validate umbrella (iter 20) end-to-end without mocks. If any of
// those layers regresses, this test surfaces it before publish.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../packages/create-agent-harness/src/index.js';
import { validate } from '../packages/create-agent-harness/src/validate.js';

const GENERATOR_VERSION = '0.1.0';

describe('e2e: scaffold → validate', () => {
  it('minimal/claude-code scaffolds, then `harness validate` reports HEALTHY', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-e2e-'));
    try {
      const r = await scaffold({
        name: 'e2e-test-bot',
        template: 'minimal',
        host: 'claude-code',
        description: 'e2e smoke test',
        targetDir: dir,
        force: true,
        generatorVersion: GENERATOR_VERSION,
      });

      // Scaffold output sanity
      expect(r.paths.length).toBeGreaterThan(0);
      expect(r.unresolved).toEqual([]);
      expect(existsSync(join(dir, 'package.json'))).toBe(true);
      expect(existsSync(join(dir, '.harness', 'manifest.json'))).toBe(true);
      expect(existsSync(join(dir, '.harness', 'manifest.sha256'))).toBe(true);

      // Validate umbrella (skip-gcp so test doesn't need gcloud).
      const v = await validate([dir, '--skip-gcp']);
      const text = v.lines.join('\n');
      // Per-check pass markers — surface which sub-check failed if any.
      expect(text, 'doctor must pass').toMatch(/PASS doctor/);
      expect(text, 'path-guard must pass').toMatch(/PASS path-guard/);
      expect(text, 'mcp must pass').toMatch(/PASS mcp/);
      expect(text, 'secrets must be skipped').toMatch(/PASS secrets\s+— skipped/);
      // verify is optional (no witness yet); should pass-or-skip cleanly
      expect(text).toMatch(/(PASS verify|FAIL verify)/);
      expect(text).toMatch(/Result: HEALTHY/);
      expect(v.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('scaffolds for every host without throwing', async () => {
    const hosts = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'] as const;
    for (const host of hosts) {
      const dir = await mkdtemp(join(tmpdir(), `ahg-e2e-${host}-`));
      try {
        const r = await scaffold({
          name: `e2e-${host}`,
          template: 'minimal',
          host,
          description: `e2e for ${host}`,
          targetDir: dir,
          force: true,
          generatorVersion: GENERATOR_VERSION,
        });
        expect(r.paths.length, `host=${host} produced no files`).toBeGreaterThan(0);
        expect(r.unresolved, `host=${host} had unresolved vars`).toEqual([]);
        expect(existsSync(join(dir, '.harness', 'manifest.json')), `host=${host} missing manifest`).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('scaffold output passes path-guard (no hardcoded /tmp/, C:\\, /Users/)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-e2e-pathguard-'));
    try {
      await scaffold({
        name: 'pathguard-test',
        template: 'minimal',
        host: 'claude-code',
        description: 'path guard test',
        targetDir: dir,
        force: true,
        generatorVersion: GENERATOR_VERSION,
      });
      const { validate } = await import('../packages/create-agent-harness/src/validate.js');
      const v = await validate([dir, '--skip-gcp']);
      // path-guard is the iter-16 regression class — the original /tmp
      // Windows bug. If the SCAFFOLDER itself starts emitting hardcoded
      // paths, every user-generated harness inherits that bug.
      expect(v.lines.join('\n'), 'scaffolder must not emit hardcoded absolute paths')
        .toMatch(/PASS path-guard/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('validate umbrella reports HEALTHY for EVERY host (not just claude-code)', async () => {
    // The iter-23 "scaffolds for every host" only checks the scaffolder
    // doesn't throw. This checks that `harness validate` accepts the
    // OUTPUT of each host — host-specific config files (.codex/config.toml,
    // AGENTS.md, capability-table.json, etc.) must each clear doctor +
    // path-guard + mcp without manual fixes.
    const hosts = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'] as const;
    for (const host of hosts) {
      const dir = await mkdtemp(join(tmpdir(), `ahg-e2e-validate-${host}-`));
      try {
        await scaffold({
          name: `e2e-val-${host}`,
          template: 'minimal',
          host,
          description: `e2e validate for ${host}`,
          targetDir: dir,
          force: true,
          generatorVersion: GENERATOR_VERSION,
        });
        const v = await validate([dir, '--skip-gcp']);
        const txt = v.lines.join('\n');
        expect(txt, `host=${host} validate output:\n${txt}`).toMatch(/PASS doctor/);
        expect(txt, `host=${host} path-guard`).toMatch(/PASS path-guard/);
        expect(txt, `host=${host} mcp`).toMatch(/PASS mcp/);
        expect(txt, `host=${host} should be HEALTHY`).toMatch(/Result: HEALTHY/);
        expect(v.code, `host=${host} validate exit code`).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('subsequent scaffold with same name and force=true is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-e2e-idem-'));
    try {
      const first = await scaffold({
        name: 'idem-test',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: GENERATOR_VERSION,
      });
      const before = await readdir(dir, { recursive: true });
      const second = await scaffold({
        name: 'idem-test',
        template: 'minimal',
        host: 'claude-code',
        targetDir: dir,
        force: true,
        generatorVersion: GENERATOR_VERSION,
      });
      const after = await readdir(dir, { recursive: true });
      // Same file set
      expect([...after].sort()).toEqual([...before].sort());
      // Same number of paths reported
      expect(second.paths.length).toBe(first.paths.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
