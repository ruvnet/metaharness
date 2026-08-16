// SPDX-License-Identifier: MIT
//
// Draft integration contract for the forthcoming @metaharness/field-memory
// package. The generator owns only the opt-in configuration/bootstrap surface;
// aggregation and storage stay in the upstream package.

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, scaffold } from '../src/index.js';
import { integrateFieldMemory } from '../src/field-memory-scaffold.js';
import { upgradeCmd } from '../src/upgrade-cmd.js';

const FIELD_MODULE = 'src/field-memory.ts';

const tmpRoot = (prefix: string) => mkdtemp(join(tmpdir(), prefix));

async function scaffoldFixture(enabled: boolean | undefined, suffix: string) {
  const target = join(await tmpRoot(`field-memory-${suffix}-`), 'bot');
  const result = await scaffold({
    name: 'bot',
    template: 'minimal',
    host: 'claude-code',
    targetDir: target,
    generatorVersion: 'test',
    darwin: false,
    fieldMemory: enabled,
  });
  return { target, result };
}

describe('--field-memory argument contract', () => {
  it('parses explicit opt in and opt out without changing the default', () => {
    expect(parseArgs(['bot', '--field-memory']).fieldMemory).toBe(true);
    expect(parseArgs(['bot', '--no-field-memory']).fieldMemory).toBe(false);
    expect(parseArgs(['bot']).fieldMemory).toBeUndefined();
  });
});

describe('field-memory scaffold', () => {
  it('emits the package-backed bootstrap and safe manifest defaults when opted in', async () => {
    const { target, result } = await scaffoldFixture(true, 'on');

    expect(result.paths).toContain(FIELD_MODULE);
    expect(result.unresolved).toEqual([]);

    const source = await readFile(join(target, FIELD_MODULE), 'utf-8');
    expect(source).toContain("from '@metaharness/field-memory'");
    expect(source).toContain("FIELD_MEMORY_LAYOUT = 'packed'");
    expect(source).toMatch(/minimumSupport:\s*([3-9]|[1-9]\d+)/);
    expect(source).toContain('hysteresisMargin: 0');
    expect(source).toContain('driftWindowMs: 30 * DAY_MS');
    expect(source).toContain('isAbsolute(storagePath)');
    expect(source).toContain('principal verifier is required');
    expect(source).not.toMatch(/\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/);

    const generatedReadme = await readFile(join(target, 'README.md'), 'utf-8');
    expect(generatedReadme).toContain('routing quarantine, not confidentiality');
    expect(generatedReadme).toMatch(/singleton aggregate\s+embeddings and rewards/);
    expect(generatedReadme).toContain('configuration-verified FlatIndex');

    const manifest = JSON.parse(
      await readFile(join(target, '.harness', 'manifest.json'), 'utf-8'),
    );
    expect(manifest.field_memory).toEqual({
      contract_schema: 1,
      enabled: true,
      package: '@metaharness/field-memory',
      version: '^0.1.0',
      module: FIELD_MODULE,
      layout: 'packed',
      minimum_support: 3,
      hysteresis_enabled: false,
      storage_path_required: true,
      drift_window_enabled: true,
      principal_identity_required: true,
      identity_hash_key_required: true,
    });
    expect(manifest.files[FIELD_MODULE]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds @metaharness/field-memory as a runtime dependency only', async () => {
    const { target } = await scaffoldFixture(true, 'dependency');
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));

    expect(pkg.dependencies['@metaharness/field-memory']).toBe('^0.1.0');
    expect(pkg.devDependencies?.['@metaharness/field-memory']).toBeUndefined();
  });

  it('fails closed until path, adapter, verifier, and identity hash key are supplied', async () => {
    const { target } = await scaffoldFixture(true, 'runtime');
    const stubDir = join(target, 'node_modules', '@metaharness', 'field-memory');
    await mkdir(stubDir, { recursive: true });
    await writeFile(join(stubDir, 'package.json'), JSON.stringify({
      name: '@metaharness/field-memory',
      type: 'module',
      exports: './index.js',
    }), 'utf-8');
    await writeFile(join(stubDir, 'index.js'), [
      'export function createFieldMemory(options) {',
      "  return { marker: 'field-memory', options };",
      '}',
      '',
    ].join('\n'), 'utf-8');

    const moduleUrl = pathToFileURL(join(target, FIELD_MODULE)).href
      .replaceAll('%7E', '~')
      .replaceAll('%7e', '~');
    const mod = await import(moduleUrl);
    const openStorage = async () => ({
      dimension: 384, metric: 'cosine', writerScope: 'process',
    });
    const verifier = async () => ({ principalId: 'verified', trustDomain: 'test' });

    await expect(mod.openFieldMemory({ storagePath: '', openStorage, verifier }))
      .rejects.toThrow(/storagePath is required/);
    await expect(mod.openFieldMemory({ storagePath: './relative.db', openStorage, verifier }))
      .rejects.toThrow(/must be absolute/);
    await expect(mod.openFieldMemory({
      storagePath: resolve(target, 'field.db'),
      openStorage,
      verifier: undefined,
      identityHashKey: new Uint8Array(32),
    })).rejects.toThrow(/principal verifier is required/);
    await expect(mod.openFieldMemory({
      storagePath: resolve(target, 'field.db'),
      openStorage,
      verifier,
    })).rejects.toThrow(/identityHashKey must contain at least 32 bytes/);
    await expect(mod.openFieldMemory({
      storagePath: resolve(target, 'field.db'),
      openStorage,
      verifier,
      identityHashKey: new Uint8Array(31),
    })).rejects.toThrow(/identityHashKey must contain at least 32 bytes/);
    await expect(mod.openFieldMemory({
      storagePath: resolve(target, 'field.db'),
      openStorage: async () => ({ dimension: 384, metric: 'cosine' }),
      verifier,
      identityHashKey: new Uint8Array(32),
    })).rejects.toThrow(/must declare writerScope/);

    const identityHashKey = new Uint8Array(32);
    const opened = await mod.openFieldMemory({
      storagePath: resolve(target, 'field.db'),
      openStorage,
      verifier,
      identityHashKey,
    });
    expect(opened.marker).toBe('field-memory');
    expect(opened.options.config.minimumSupport).toBe(3);
    expect(opened.options.config.hysteresisMargin).toBe(0);
    expect(opened.options.verifier).toBe(verifier);
    expect(opened.options.identityHashKey).toBe(identityHashKey);
    expect(opened.options.storage.writerScope).toBe('process');
  });

  it('refuses to overwrite a destination field-memory module even with force', async () => {
    const target = join(await tmpRoot('field-memory-existing-target-'), 'bot');
    const existingPath = join(target, FIELD_MODULE);
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(existingPath, '// deployment-owned module\n', 'utf-8');

    await expect(scaffold({
      name: 'bot',
      template: 'minimal',
      host: 'claude-code',
      targetDir: target,
      generatorVersion: 'test',
      darwin: false,
      fieldMemory: true,
      force: true,
    })).rejects.toThrow(/refuses to overwrite existing src\/field-memory\.ts/);
    expect(await readFile(existingPath, 'utf-8')).toBe('// deployment-owned module\n');
  });

  it.each([
    ['omitted', undefined],
    ['explicitly disabled', false],
  ] as const)('preserves legacy output when %s', async (_label, enabled) => {
    const { target, result } = await scaffoldFixture(enabled, String(_label).replaceAll(' ', '-'));
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
    const manifest = JSON.parse(
      await readFile(join(target, '.harness', 'manifest.json'), 'utf-8'),
    );

    expect(result.paths).not.toContain(FIELD_MODULE);
    expect(existsSync(join(target, FIELD_MODULE))).toBe(false);
    expect(pkg.dependencies?.['@metaharness/field-memory']).toBeUndefined();
    expect(manifest.field_memory).toBeUndefined();
  });

  it('is deterministic for the generated integration surface', async () => {
    const first = await scaffoldFixture(true, 'deterministic-a');
    const second = await scaffoldFixture(true, 'deterministic-b');

    const [firstSource, secondSource, firstPkg, secondPkg, firstManifest, secondManifest] =
      await Promise.all([
        readFile(join(first.target, FIELD_MODULE), 'utf-8'),
        readFile(join(second.target, FIELD_MODULE), 'utf-8'),
        readFile(join(first.target, 'package.json'), 'utf-8'),
        readFile(join(second.target, 'package.json'), 'utf-8'),
        readFile(join(first.target, '.harness', 'manifest.json'), 'utf-8'),
        readFile(join(second.target, '.harness', 'manifest.json'), 'utf-8'),
      ]);

    expect(secondSource).toBe(firstSource);
    expect(secondPkg).toBe(firstPkg);
    expect(JSON.parse(secondManifest).field_memory)
      .toEqual(JSON.parse(firstManifest).field_memory);
  });

  it('does not generate secret material, credentials, or principal assertions', async () => {
    const { target } = await scaffoldFixture(true, 'secrets');
    const blobs = await Promise.all([
      readFile(join(target, FIELD_MODULE), 'utf-8'),
      readFile(join(target, 'package.json'), 'utf-8'),
      readFile(join(target, '.harness', 'manifest.json'), 'utf-8'),
    ]);
    const output = blobs.join('\n');

    const secretShapes = [
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
      /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/,
      /\bsk-[A-Za-z0-9_-]{16,}\b/,
      /\bAIza[A-Za-z0-9_-]{20,}\b/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const pattern of secretShapes) expect(output).not.toMatch(pattern);
    expect(output).not.toContain('process.env');
    expect(output).not.toMatch(/principalId\s*[:=]\s*['"][^'"]+['"]/);
  });

  it('preserves the field overlay through upgrade dry-run and apply', async () => {
    const { target } = await scaffoldFixture(true, 'upgrade');
    const beforePackage = await readFile(join(target, 'package.json'), 'utf-8');
    const beforeReadme = await readFile(join(target, 'README.md'), 'utf-8');
    const beforeModule = await readFile(join(target, FIELD_MODULE), 'utf-8');

    const dry = await upgradeCmd([target]);
    expect(dry.code, dry.lines.join('\n')).toBe(0);
    expect(await readFile(join(target, 'package.json'), 'utf-8')).toBe(beforePackage);
    expect(await readFile(join(target, 'README.md'), 'utf-8')).toBe(beforeReadme);
    expect(await readFile(join(target, FIELD_MODULE), 'utf-8')).toBe(beforeModule);

    const applied = await upgradeCmd([target, '--apply']);
    expect(applied.code, applied.lines.join('\n')).toBe(0);
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['@metaharness/field-memory']).toBe('^0.1.0');
    expect(await readFile(join(target, 'README.md'), 'utf-8')).toContain('## Field memory');
    expect(await readFile(join(target, FIELD_MODULE), 'utf-8'))
      .toContain("from '@metaharness/field-memory'");
  });

  it.each(
    [
      ['contract_schema', (field: Record<string, unknown>) => { field.contract_schema = 2; }],
      ['enabled', (field: Record<string, unknown>) => { field.enabled = false; }],
      ['package', (field: Record<string, unknown>) => { field.package = '@scope/not-field-memory'; }],
      ['version', (field: Record<string, unknown>) => { field.version = '^0.2.0'; }],
      ['module', (field: Record<string, unknown>) => { field.module = 'src/other.ts'; }],
      ['layout', (field: Record<string, unknown>) => { field.layout = 'unpacked'; }],
      ['minimum_support', (field: Record<string, unknown>) => { field.minimum_support = 2; }],
      ['hysteresis_enabled', (field: Record<string, unknown>) => { field.hysteresis_enabled = true; }],
      ['storage_path_required', (field: Record<string, unknown>) => { field.storage_path_required = false; }],
      ['drift_window_enabled', (field: Record<string, unknown>) => { field.drift_window_enabled = false; }],
      ['principal_identity_required', (field: Record<string, unknown>) => { field.principal_identity_required = false; }],
      ['identity_hash_key_required', (field: Record<string, unknown>) => { delete field.identity_hash_key_required; }],
      ['unexpected key', (field: Record<string, unknown>) => { field.unexpected = true; }],
    ] as Array<[string, (field: Record<string, unknown>) => void]>,
  )(
    'upgrade rejects a field_memory contract with wrong %s',
    async (label, mutate) => {
      const { target } = await scaffoldFixture(true, `upgrade-invalid-${label.replaceAll(' ', '-')}`);
      const manifestPath = join(target, '.harness', 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      mutate(manifest.field_memory);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      const result = await upgradeCmd([target]);
      expect(result.code).toBe(1);
      expect(result.lines.join('\n')).toMatch(/field_memory block is invalid/);
    },
  );
});

describe('field-memory overlay conflicts', () => {
  const packageFile = (content: string) => ({
    path: 'package.json', content, rendered: true, unresolved: [],
  });

  it('rejects a template that omits package.json', () => {
    expect(() => integrateFieldMemory([])).toThrow(/requires the template to emit package\.json/);
  });

  it('rejects duplicate generated package.json entries', () => {
    expect(() => integrateFieldMemory([
      packageFile(JSON.stringify({ name: 'one' })),
      packageFile(JSON.stringify({ name: 'two' })),
    ])).toThrow(/requires exactly one generated package\.json/);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['non-object root', '[]'],
  ])('rejects %s package.json', (_label, content) => {
    expect(() => integrateFieldMemory([packageFile(content)]))
      .toThrow(/requires a valid generated package\.json object/);
  });

  it('rejects a non-object dependency section', () => {
    expect(() => integrateFieldMemory([
      packageFile(JSON.stringify({ name: 'bot', dependencies: [] })),
    ])).toThrow(/dependencies to be an object/);
  });

  it.each(['^0.2.0', '~0.1.0', 'workspace:^0.1.0'])(
    'rejects noncompatible or unverified dependency specification %s',
    (spec) => {
      expect(() => integrateFieldMemory([
        packageFile(JSON.stringify({
          name: 'bot',
          dependencies: { '@metaharness/field-memory': spec },
        })),
      ])).toThrow(/accepts only .*\^0\.1\.0/);
    },
  );

  it('rejects the dependency in a non-runtime or duplicate section', () => {
    expect(() => integrateFieldMemory([
      packageFile(JSON.stringify({
        name: 'bot',
        devDependencies: { '@metaharness/field-memory': '^0.1.0' },
      })),
    ])).toThrow(/only in runtime dependencies/);
    expect(() => integrateFieldMemory([
      packageFile(JSON.stringify({
        name: 'bot',
        dependencies: { '@metaharness/field-memory': '^0.1.0' },
        devDependencies: { '@metaharness/field-memory': '^0.1.0' },
      })),
    ])).toThrow(/only in runtime dependencies/);
  });

  it('rejects an existing template module instead of accepting unknown code', () => {
    expect(() => integrateFieldMemory([
      packageFile(JSON.stringify({ name: 'bot', dependencies: {} })),
      { path: FIELD_MODULE, content: '// unknown\n', rendered: false, unresolved: [] },
    ])).toThrow(/refuses to overwrite existing src\/field-memory\.ts/);
  });

  it('preserves the exact supported runtime dependency', () => {
    const files = [packageFile(JSON.stringify({
      name: 'bot',
      dependencies: {
        '@metaharness/field-memory': '^0.1.0',
        existing: '^1.0.0',
      },
    }))];
    integrateFieldMemory(files);
    const pkg = JSON.parse(files[0]!.content);
    expect(pkg.dependencies).toEqual({
      '@metaharness/field-memory': '^0.1.0',
      existing: '^1.0.0',
    });
  });
});
