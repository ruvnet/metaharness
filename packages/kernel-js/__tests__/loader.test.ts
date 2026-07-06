// SPDX-License-Identifier: MIT
//
// Loader + pure-JS fallback backend (ADR-002a §fallback). These tests pin the
// invariant that made every generated harness fail before: loadKernel() must
// ALWAYS resolve to a working backend, even with no native NAPI package and no
// wasm pkg/ present. On a plain CI host that means the js backend answers.

import { describe, it, expect, afterEach } from 'vitest';
import { loadKernel } from '../src/index.js';

describe('loadKernel — always resolves a backend', () => {
  it('returns a backend with a non-empty version and a known kind', async () => {
    const kernel = await loadKernel();
    expect(['native', 'wasm', 'js']).toContain(kernel.backend);
    expect(typeof kernel.version()).toBe('string');
    expect(kernel.version().length).toBeGreaterThan(0);
  });

  it('kernelInfo reports version + git_sha + target', async () => {
    const info = (await loadKernel()).kernelInfo();
    expect(typeof info.version).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
    expect(typeof info.git_sha).toBe('string');
    expect(typeof info.target).toBe('string');
  });

  it('caches — repeated calls return the same instance', async () => {
    expect(await loadKernel()).toBe(await loadKernel());
  });
});

describe('mcpValidate — mirrors crates/kernel/src/mcp.rs::validate', () => {
  it('accepts a stdio (command) server', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', command: ['node', 's.js'] }))).toBeNull();
  });

  it('accepts an http (url) server', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', url: 'http://localhost:3000' }))).toBeNull();
  });

  it('rejects an empty server name', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: '', command: ['x'] }))).toBe('mcp: server name is empty');
  });

  it('rejects both command and url (mutually exclusive)', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x', command: ['a'], url: 'http://y' }))).toBe(
      'mcp: command and url are mutually exclusive',
    );
  });

  it('rejects neither command nor url', async () => {
    const k = await loadKernel();
    expect(k.mcpValidate(JSON.stringify({ name: 'x' }))).toBe('mcp: either command or url must be set');
  });

  it('throws on unparseable spec json', async () => {
    const k = await loadKernel();
    expect(() => k.mcpValidate('{not json')).toThrow(/invalid spec json/);
  });
});

// GH #22: backend selection via METAHARNESS_KERNEL_BACKEND + fail-loud.
import { _resetKernelCacheForTests, kernelDiagnostics } from '../src/index.js';

describe('METAHARNESS_KERNEL_BACKEND selection (GH #22)', () => {
  const prev = process.env.METAHARNESS_KERNEL_BACKEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.METAHARNESS_KERNEL_BACKEND;
    else process.env.METAHARNESS_KERNEL_BACKEND = prev;
    _resetKernelCacheForTests();
  });

  it('rejects an invalid backend value loudly', async () => {
    _resetKernelCacheForTests();
    process.env.METAHARNESS_KERNEL_BACKEND = 'gpu';
    await expect(loadKernel()).rejects.toThrow(/invalid; choose one of: native, wasm, js/);
  });

  it('forcing native fails loudly with a reason when no native pkg is installed', async () => {
    _resetKernelCacheForTests();
    process.env.METAHARNESS_KERNEL_BACKEND = 'native';
    await expect(loadKernel()).rejects.toThrow(/backend "native" was requested but is unavailable/);
  });

  it('forcing js always works and is the floor', async () => {
    _resetKernelCacheForTests();
    process.env.METAHARNESS_KERNEL_BACKEND = 'js';
    const k = await loadKernel();
    expect(k.backend).toBe('js');
  });

  it('kernelDiagnostics exposes resolved + requested + reasons', async () => {
    _resetKernelCacheForTests();
    process.env.METAHARNESS_KERNEL_BACKEND = 'js';
    const d = await kernelDiagnostics();
    expect(d.resolved).toBe('js');
    expect(d.requested).toBe('js');
    expect(typeof d.reasons).toBe('object');
  });
});

// GH #20 — the published @metaharness/kernel must ship a LOADABLE wasm artifact so a plain
// `npm install` can reach the fast Rust backend, not silently fall to the JS floor. The bug was the
// publish workflow building `wasm-pack --target bundler` while the runtime loader expects `--target
// nodejs` (CommonJS auto-init) — an unloadable mismatch.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const kjsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmShim = join(kjsRoot, 'pkg', 'ruflo_kernel_wasm.js');

describe('GH #20 — publish ships a loadable wasm (nodejs target)', () => {
  it('the publish workflow builds the wasm NODEJS target, not bundler', () => {
    const wf = readFileSync(join(kjsRoot, '..', '..', '.github', 'workflows', 'publish.yml'), 'utf8');
    // a raw bundler-target build is the #20 regression — the runtime loader can't load it
    expect(wf).not.toMatch(/wasm-pack build[^\n]*--target\s+bundler/);
    // it must use build:wasm (nodejs target + fixups) or an explicit --target nodejs
    expect(/build:wasm|--target\s+nodejs/.test(wf)).toBe(true);
  });

  // Only runs where the wasm artifact has been built (locally after `npm run build:wasm`, and in the
  // publish flow); asserts the artifact is the correct, LOADABLE target — a bundler artifact would make
  // a `wasm`-requested load throw / fall back rather than resolve the wasm backend.
  it.skipIf(!existsSync(wasmShim))('a present wasm artifact resolves the wasm backend', async () => {
    const prev = process.env.METAHARNESS_KERNEL_BACKEND;
    process.env.METAHARNESS_KERNEL_BACKEND = 'wasm';
    _resetKernelCacheForTests();
    try {
      const k = await loadKernel();
      expect(k.backend).toBe('wasm');
    } finally {
      if (prev === undefined) delete process.env.METAHARNESS_KERNEL_BACKEND;
      else process.env.METAHARNESS_KERNEL_BACKEND = prev;
      _resetKernelCacheForTests();
    }
  });
});
