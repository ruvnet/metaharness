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
