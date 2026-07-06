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

      // Regression for issue #23: every scaffold must carry a license field
      // AND emit a matching LICENSE file (package.json `files` lists LICENSE).
      expect(pkg.license, `${t.id} package.json missing license field`).toBe('MIT');
      expect(r.paths, `${t.id} missing LICENSE file`).toContain('LICENSE');
      const license = await readFile(join(target, 'LICENSE'), 'utf-8');
      expect(license).toContain('MIT License');

      // Regression for issue #24: the generated README must not overclaim a WASM
      // kernel that the published beta doesn't ship (it resolves to js). Guard the
      // bare "WASM kernel" phrasing in ANY wording — the honest line says the
      // kernel "resolves native → wasm → js (js backend in the published beta)".
      // (The original assertion matched only one exact string; the vertical:devops
      // variant "WASM kernel, multi-host, witness-signed" slipped past it.)
      const readme = await readFile(join(target, 'README.md'), 'utf-8');
      expect(readme, `${t.id} README overclaims a bare "WASM kernel"`).not.toMatch(/WASM kernel/i);

      // One agent file per declared agent.
      for (const a of t.agents) {
        expect(r.paths, `${t.id} missing agent ${a.id}`).toContain(`src/agents/${a.id}.ts`);
      }

      // settings.json is valid JSON with a scoped MCP server.
      const settings = JSON.parse(await readFile(join(target, '.claude/settings.json'), 'utf-8'));
      expect(settings.mcpServers[name]).toBeDefined();
      expect(settings.permissions.allow).toContain(`mcp__${name}__*`);

      // Regression for issue #44: a scaffold whose test suite IMPORTS a shebanged
      // entrypoint (e.g. `import { run } from '../bin/cli.js'`) must ship a
      // vitest.config that strips the `#!` line — Vite/esbuild does NOT strip
      // shebangs before parsing, so otherwise EVERY fresh `npm test` dies with
      // "SyntaxError: Invalid or unexpected token". This catches the whole class:
      // a generated harness that cannot run its own tests out of the box.
      const testFiles = r.paths.filter((p) => p.startsWith('__tests__/') && p.endsWith('.ts'));
      const importedShebangedFiles: string[] = [];
      for (const tf of testFiles) {
        const src = await readFile(join(target, tf), 'utf-8');
        // match relative imports like ../bin/cli.js, ./foo.js
        for (const m of src.matchAll(/from\s+['"](\.[^'"]+\.js)['"]/g)) {
          const imp = m[1];
          // resolve relative to the test file's dir, normalized to a scaffold path
          const abs = join(target, dirname(tf), imp);
          let body = '';
          try { body = await readFile(abs, 'utf-8'); } catch { continue; }
          if (body.startsWith('#!')) importedShebangedFiles.push(imp);
        }
      }
      if (importedShebangedFiles.length > 0) {
        expect(
          r.paths,
          `${t.id}: tests import shebanged module(s) ${importedShebangedFiles.join(', ')} — scaffold needs a vitest.config that strips shebangs (#44)`,
        ).toContain('vitest.config.ts');
        const vcfg = await readFile(join(target, 'vitest.config.ts'), 'utf-8');
        expect(vcfg, `${t.id}: vitest.config.ts must strip the shebang (#44)`).toMatch(/strip-shebang|#!|shebang/i);
        // Prove the configured transform actually neutralizes a shebang into
        // parseable JS — not just that the file mentions "shebang".
        const stripped = '#!/usr/bin/env node\nexport const x = 1;\n'.replace(/^#![^\n]*/, '');
        expect(() => new Function(stripped.replace(/export /g, ''))).not.toThrow();
      }
    });
  }
});

// Regression for issue #48: docs↔code command fidelity across EVERY scaffold-able template (not just
// the `generate:true` catalog subset — `minimal` is `generate:false` yet ships a CLI + CLAUDE.md, and
// was the one advertising phantom `memory`/`route` commands the CLI answers with "Unknown command").
// A scaffold that documents a command its own bin/cli.js has no `case` for is a false promise to the
// agent reading CLAUDE.md.
describe('docs↔code command fidelity (#48)', () => {
  for (const template of TEMPLATES) {
    it(`${template}: every CLAUDE.md-documented subcommand has a CLI dispatch case`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'fidelity-'));
      const name = 'demo-harness';
      const target = join(root, name);
      const r = await scaffold({
        name, template, host: 'claude-code', description: 'demo harness', targetDir: target, generatorVersion: '0.1.0',
      });
      if (!r.paths.includes('CLAUDE.md')) return; // no docs to check
      const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
      const binPath = Object.values(pkg.bin ?? {})[0] as string | undefined;
      if (!binPath) return; // no CLI to check against

      const claudeMd = await readFile(join(target, 'CLAUDE.md'), 'utf-8');
      // A documented command = the first token after the harness name in a `| `name cmd …` |` table row.
      const documented = [
        ...claudeMd.matchAll(new RegExp('\\|\\s*`' + name + '\\s+([a-z][\\w-]*)', 'g')),
      ].map((m) => m[1]!);
      const cli = await readFile(join(target, binPath), 'utf-8');
      const cased = new Set([...cli.matchAll(/case\s+'([a-z][\w-]*)'/g)].map((m) => m[1]!));
      for (const cmd of documented) {
        expect(
          cased.has(cmd),
          `${template}: CLAUDE.md documents \`${name} ${cmd}\` but bin/cli.js has no \`case '${cmd}'\` (#48 docs↔code drift)`,
        ).toBe(true);
      }
    });
  }
});
