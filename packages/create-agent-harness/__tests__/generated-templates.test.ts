// SPDX-License-Identifier: MIT
//
// Contract test for the generated quick-start templates (catalog.def.mjs ->
// gen-templates.mjs). Scaffolds every generated template into a tmp dir and
// asserts it renders cleanly, and validates the canonical catalog.json the CLI
// `--list` and the Rust crate both consume.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, loadCatalog, formatCatalog, TEMPLATES } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', 'templates', 'catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as {
  schema: number;
  templates: Array<{
    id: string;
    category: string;
    name: string;
    domain: string;
    description: string;
    quickStart: string;
    generate: boolean;
    agentCount: number;
    skillCount: number;
    commandCount: number;
    agents: Array<{ id: string }>;
  }>;
};

const generated = catalog.templates.filter((t) => t.generate);

describe('catalog.json', () => {
  it('has a schema and 20 templates (iter 113: + vertical:repo-maintainer)', () => {
    expect(catalog.schema).toBe(1);
    expect(catalog.templates.length).toBe(20);
  });

  it('every id is unique and listed in TEMPLATES', () => {
    const ids = catalog.templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(TEMPLATES).toContain(id);
  });

  it('covers every requested category', () => {
    const ids = catalog.templates.map((t) => t.id);
    for (const id of [
      'vertical:coding',
      'vertical:business',
      'vertical:ruview',
      'vertical:health',
      'vertical:crm',
      'vertical:marketing',
      'vertical:advertising',
      'vertical:research',
      'vertical:ai',
      'vertical:agentics',
      'vertical:exotic',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('loadCatalog() + formatCatalog() round-trip', () => {
    const loaded = loadCatalog();
    expect(loaded.length).toBe(20);  // iter 113: + vertical:repo-maintainer
    const lines = formatCatalog(loaded);
    expect(lines.join('\n')).toContain('vertical:coding');
    expect(lines.join('\n')).toContain('vertical:education');  // iter 80 pin
    expect(lines.join('\n')).toContain('vertical:sales');      // iter 87 pin
    expect(lines.join('\n')).toContain('vertical:gaming');     // iter 96 pin
    expect(lines.join('\n')).toContain('Available templates:');
  });
});

describe('generated templates scaffold cleanly', () => {
  for (const t of generated) {
    it(`${t.id} -> renders with no unresolved vars`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'gen-tpl-'));
      const name = 'demo-harness';
      const target = join(root, name);
      const r = await scaffold({
        name,
        template: t.id,
        host: 'claude-code',
        // Plain description — the raw {{description}} slot lands in JSON files,
        // so a value with quotes is the caller's responsibility to keep clean.
        description: 'demo harness',
        targetDir: target,
        generatorVersion: '0.1.0',
      });

      // No template variable left unrendered.
      expect(r.unresolved, `${t.id} had unresolved vars`).toEqual([]);

      // Core files exist.
      expect(r.paths).toContain('package.json');
      expect(r.paths).toContain('CLAUDE.md');
      expect(r.paths).toContain('.claude/settings.json');

      // package.json is valid JSON carrying the harness name + kernel dep.
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
      expect(pkg.name).toBe(name);
      expect(pkg.dependencies['@metaharness/kernel']).toBeDefined();

      // Regression for issue #13: npm strips a "bin" target with a leading "./"
      // on publish, leaving the package with no CLI. Bin paths must be relative
      // with no "./" prefix.
      for (const [binName, binPath] of Object.entries(pkg.bin ?? {})) {
        expect(typeof binPath === 'string' && !(binPath as string).startsWith('./'),
          `${t.id} bin[${binName}] must not start with "./" (npm strips it on publish)`).toBe(true);
      }

      // One agent file per declared agent.
      for (const a of t.agents) {
        expect(r.paths, `${t.id} missing agent ${a.id}`).toContain(`src/agents/${a.id}.ts`);
      }

      // settings.json is valid JSON with a scoped MCP server.
      const settings = JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf-8'));
      expect(settings.mcpServers[name]).toBeDefined();
      expect(settings.permissions.allow).toContain(`mcp__${name}__*`);
    });
  }
});
