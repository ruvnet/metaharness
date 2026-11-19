// SPDX-License-Identifier: MIT
//
// metaharness depends on six of its own @metaharness/* packages. Up to 0.4.22 they
// were declared as 0.x caret ranges, and a 0.x caret never crosses a minor line:
// `^0.1.4` kept every install on @metaharness/avo 0.1.x after 0.2.x shipped. Since
// 0.4.23 each one is an exact pin. This file guards that, and loads every pinned
// package for real (no mocks) through the same path metaharness uses at runtime.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main } from '../src/index.js';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf-8'));

/** The `metaharness <verb>` subcommands that delegate to `@metaharness/<verb>/cli`. */
const DELEGATED: Array<{ name: string; verb: string; banner: string }> = [
  { name: '@metaharness/avo', verb: 'avo', banner: 'governed autonomous variation runtime' },
  { name: '@metaharness/flywheel', verb: 'flywheel', banner: 'metaharness flywheel' },
  { name: '@metaharness/redblue', verb: 'redblue', banner: 'metaharness redblue' },
  { name: '@metaharness/weight-eft', verb: 'weight-eft', banner: '@metaharness/weight-eft' },
  { name: '@metaharness/turn-credit', verb: 'turn-credit', banner: 'metaharness turn-credit' },
];
const ALL = [...DELEGATED.map((d) => d.name), '@metaharness/darwin'];

/** Node's bare-specifier lookup: the first node_modules/<name> walking up from PKG_DIR. */
function packageDir(name: string): string {
  let dir = PKG_DIR;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${name} is not installed`);
    dir = parent;
  }
}

function installedVersion(name: string): string {
  return JSON.parse(readFileSync(join(packageDir(name), 'package.json'), 'utf-8')).version;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scoped @metaharness/* dependencies are exact pins', () => {
  it.each(ALL)('%s is a required dependency pinned to an exact version', (name) => {
    expect(pkg.dependencies?.[name], `${name} must stay in dependencies`).toBeDefined();
    expect(pkg.optionalDependencies?.[name]).toBeUndefined();
    expect(pkg.peerDependencies?.[name]).toBeUndefined();
    expect(pkg.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(ALL)('%s resolves to exactly the pinned version', (name) => {
    expect(installedVersion(name)).toBe(pkg.dependencies[name]);
  });
});

describe('real imports at the pinned versions', () => {
  it.each(DELEGATED)('`metaharness $verb` loads $name/cli and runs its dispatch', async ({ name, verb, banner }) => {
    // The exact module metaharness imports, loaded from the installed package.
    const cli = await import(`${name}/cli`);
    expect(typeof cli.dispatch).toBe('function');

    // And the full CLI path: main() routes the verb to that dispatch.
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
    const code = await main([verb]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain(banner);
    expect(installedVersion(name)).toBe(pkg.dependencies[name]);
  });

  it('@metaharness/darwin loads and ships the metaharness-darwin bin the scaffolded evolve scripts call', async () => {
    const dir = packageDir('@metaharness/darwin');
    const darwinPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    expect(darwinPkg.version).toBe(pkg.dependencies['@metaharness/darwin']);
    const bin = darwinPkg.bin?.['metaharness-darwin'];
    expect(bin).toBeTruthy();
    expect(existsSync(join(dir, bin))).toBe(true);
    const mod = await import(pathToFileURL(join(dir, darwinPkg.exports['.'].import)).href);
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
