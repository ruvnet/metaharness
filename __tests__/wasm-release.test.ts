// SPDX-License-Identifier: MIT
//
// Wasm release invariants.
//
// @metaharness/horizon 0.2.1 was published without wasm/horizon_core.wasm: the
// wasm is gitignored, the Release workflow never ran build:wasm, and nothing
// checked the tarball. Its loader then failed with ENOENT for every user. These
// tests pin the three fixes: packages declare their wasm, the release builds it
// and refuses a tarball without it, and CI installs the wasm tools from crates.io
// instead of GitHub release downloads (which 504'd on 7136c872).
//
// None of these need a Rust toolchain: the Node CI job runs them as-is.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs script without type declarations
import { declaredWasm, missingFromPack, checkWasmInPack } from '../scripts/wasm-artifacts.mjs';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Pkg = { name: string; version: string; files?: string[]; scripts?: Record<string, string>; metaharness?: { wasmArtifacts?: string[] } };
const packages = readdirSync(join(ROOT, 'packages'))
  .filter(d => existsSync(join(ROOT, 'packages', d, 'package.json')))
  .map(d => ({ dir: d, pkg: JSON.parse(read(`packages/${d}/package.json`)) as Pkg }));

/** True when a declared file is covered by an entry of package.json `files`. */
function coveredByFiles(files: string[], path: string): boolean {
  return files.some(f => {
    const base = f.replace(/\/\*\*$/, '').replace(/\/$/, '');
    return path === base || path.startsWith(base + '/');
  });
}

describe('wasm artifact declarations', () => {
  it('every package with a build:wasm script declares the wasm it ships', () => {
    const builders = packages.filter(p => p.pkg.scripts?.['build:wasm']);
    expect(builders.map(p => p.dir).sort()).toEqual(expect.arrayContaining(['horizon', 'kernel-js', 'oo-agents']));
    for (const { pkg } of builders) {
      const files = declaredWasm(pkg) as string[];
      expect(files.length, `${pkg.name} has build:wasm but no metaharness.wasmArtifacts`).toBeGreaterThan(0);
      expect(files.some(f => f.endsWith('.wasm')), `${pkg.name} declares no .wasm file`).toBe(true);
      for (const f of files) expect(coveredByFiles(pkg.files ?? [], f), `${pkg.name}: ${f} not covered by "files"`).toBe(true);
    }
  });

  it('declared paths are relative and stay inside the package', () => {
    expect(() => declaredWasm({ name: 'x', metaharness: { wasmArtifacts: ['../evil.wasm'] } })).toThrow(/relative paths/);
    expect(() => declaredWasm({ name: 'x', metaharness: { wasmArtifacts: ['/abs.wasm'] } })).toThrow(/relative paths/);
    expect(declaredWasm({ name: 'x' })).toEqual([]);
  });
});

describe('pack-time wasm check', () => {
  const horizon = packages.find(p => p.dir === 'horizon')!.pkg;
  // The exact file list npm packed for @metaharness/horizon@0.2.1.
  const published021 = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/core.js', 'dist/guard.js'];

  it('rejects a horizon tarball without wasm/horizon_core.wasm (the 0.2.1 failure)', () => {
    expect(missingFromPack(horizon, published021)).toEqual(['wasm/horizon_core.wasm']);
    expect(() => checkWasmInPack(horizon, published021.map(path => ({ path })))).toThrow(/missing declared wasm artifacts: wasm\/horizon_core\.wasm/);
  });

  it('accepts the tarball once the wasm is in it', () => {
    expect(() => checkWasmInPack(horizon, [...published021, 'wasm/horizon_core.wasm'].map(path => ({ path })))).not.toThrow();
  });

  it('dream-release.mjs runs the check on every packed tarball', () => {
    const src = read('scripts/dream-release.mjs');
    expect(src).toMatch(/import \{ checkWasmInPack \} from '\.\/wasm-artifacts\.mjs'/);
    expect(src).toMatch(/checkWasmInPack\(pkg, packed\.files\)/);
    // The installed-artifact smoke must reach the wasm, not a fallback.
    expect(src).toMatch(/HorizonCore\.load\(\)/);
    expect(src).toMatch(/CellVm\.load\(\)/);
    expect(src).toMatch(/backend, 'wasm'/);
  });
});

describe('Release workflow builds wasm before packing', () => {
  const wf = read('.github/workflows/dream-release.yml');
  it('installs the pinned tools and runs build:wasm before the pack step', () => {
    const install = wf.indexOf('bash scripts/install-wasm-tools.sh');
    const build = wf.indexOf('node scripts/wasm-artifacts.mjs build');
    const pack = wf.indexOf('node scripts/dream-release.mjs pack');
    expect(install).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(install);
    expect(pack).toBeGreaterThan(build);
    expect(wf).toMatch(/targets: wasm32-unknown-unknown/);
  });
});

describe('CI installs wasm tools from crates.io, pinned', () => {
  const ci = read('.github/workflows/ci.yml');
  const script = read('scripts/install-wasm-tools.sh');
  it('ci.yml no longer uses the GitHub-hosted wasm-pack curl installer', () => {
    expect(ci).not.toMatch(/wasm-pack\/installer\/init\.sh/);
    expect(ci).toMatch(/bash scripts\/install-wasm-tools\.sh/);
  });

  it('the script installs every tool with cargo install --locked and a pinned version', () => {
    expect(script).toMatch(/cargo install "\$2" --version "\$3" --locked/);
    expect(script).toMatch(/^WASM_PACK_VERSION=\d+\.\d+\.\d+$/m);
    expect(script).toMatch(/^WASM_OPT_VERSION=\d+\.\d+\.\d+$/m);
    const code = script.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/curl|wget|github\.com\/.*\/releases/);
  });

  it('the wasm-bindgen-cli it installs equals the exact Cargo.toml pin', () => {
    const pin = /^wasm-bindgen = "=(\d+\.\d+\.\d+)"/m.exec(read('Cargo.toml'));
    expect(pin, 'root Cargo.toml must pin wasm-bindgen exactly, or wasm-pack downloads a matching CLI').not.toBeNull();
    expect(script).toContain(`WASM_BINDGEN_VERSION=${pin![1]}`);
  });
});
