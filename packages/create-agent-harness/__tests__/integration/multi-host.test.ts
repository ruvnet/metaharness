// SPDX-License-Identifier: MIT
//
// Cross-host integration smoke. End-to-end scaffold each host then
// inspect the per-host artifacts the adapter is supposed to emit.
// No containers — pure file-system + per-template render tests.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, HOSTS, TEMPLATES, type Host } from '../../src/index.js';

const tmp = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

describe('cross-host: minimal template scaffolds for every host', () => {
  for (const host of HOSTS) {
    it(`emits a valid harness for host=${host}`, async () => {
      const root = await tmp('integ-min-');
      const target = join(root, `bot-${host}`);
      const r = await scaffold({
        name: `bot-${host}`,
        template: 'minimal',
        host: host as Host,
        targetDir: target,
        generatorVersion: '0.1.0',
      });
      expect(r.paths).toContain('package.json');
      expect(r.paths).toContain('CLAUDE.md');
      expect(r.paths).toContain('.harness/manifest.json');

      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe(`bot-${host}`);
      expect(pkg.dependencies['@ruflo/kernel']).toBeDefined();
      expect(pkg.dependencies[`@ruflo/host-${host}`]).toBeDefined();
    });
  }
});

describe('cross-host: every vertical template builds for claude-code', () => {
  for (const template of TEMPLATES) {
    it(`builds template=${template}`, async () => {
      const root = await tmp(`integ-tpl-`);
      const target = join(root, 'demo');
      const r = await scaffold({
        name: 'demo',
        template,
        host: 'claude-code',
        targetDir: target,
        generatorVersion: '0.1.0',
      });
      expect(r.paths.length).toBeGreaterThan(0);
      expect(r.paths).toContain('package.json');
      expect(r.paths).toContain('.harness/manifest.json');
    });
  }
});

describe('cross-host: settings.json contains harness name in mcpServers', () => {
  for (const template of ['minimal', 'vertical:devops', 'vertical:support'] as const) {
    it(`template=${template}`, async () => {
      const root = await tmp('integ-mcp-');
      const target = join(root, 'sample');
      await scaffold({
        name: 'sample',
        template,
        host: 'claude-code',
        targetDir: target,
        generatorVersion: '0.1.0',
      });
      const settings = JSON.parse(await readFile(join(target, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.mcpServers).toBeDefined();
      expect(settings.mcpServers.sample).toBeDefined();
    });
  }
});
