// SPDX-License-Identifier: MIT
//
// GH #22: `harness diag` must surface WHICH kernel backend actually answers
// (native/wasm/js) and, when a faster tier is unavailable, WHY — instead of a
// silent js fallback the operator can't see. These tests pin the surfacing
// (formatDiagReport) and the end-to-end resolution (buildDiagReport).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiagReport, formatDiagReport, type DiagReport } from '../src/diag.js';

function baseReport(over: Partial<DiagReport>): DiagReport {
  return {
    dir: '/tmp/h',
    surface: 'cli',
    manifestKernelVersion: '0.1.2',
    localKernelVersion: '0.1.2',
    verdict: 'match',
    actionable: undefined,
    manifestGeneratorVersion: '0.3.1',
    localGeneratorVersion: '0.3.1',
    generatorVerdict: 'match',
    kernelBackend: undefined,
    requestedBackend: null,
    backendReasons: {},
    ...over,
  };
}

describe('diag surfaces the kernel backend (GH #22)', () => {
  it('prints the resolved backend', () => {
    const { lines } = formatDiagReport(baseReport({ kernelBackend: 'wasm' }));
    expect(lines.some(l => /kernel backend:\s+wasm/.test(l))).toBe(true);
  });

  it('explains why each faster tier was unavailable (the silent-fallback fix)', () => {
    const { lines } = formatDiagReport(baseReport({
      kernelBackend: 'js',
      backendReasons: {
        native: 'no native package mapping for platform "sunos-x64"',
        wasm: 'wasm artifact (pkg/ruflo_kernel_wasm.js) not present',
      },
    }));
    const text = lines.join('\n');
    expect(text).toMatch(/kernel backend:\s+js/);
    expect(text).toMatch(/native unavailable — no native package mapping/);
    expect(text).toMatch(/wasm unavailable — wasm artifact/);
  });

  it('shows the requested backend when METAHARNESS_KERNEL_BACKEND is set', () => {
    const { lines } = formatDiagReport(baseReport({ kernelBackend: 'js', requestedBackend: 'native' }));
    expect(lines.some(l => /kernel backend:\s+js\s+\[requested: native\]/.test(l))).toBe(true);
  });

  it('does NOT claim the tier that answered is unavailable', () => {
    // native answered — even if a stale reason were present, we must not print it.
    const { lines } = formatDiagReport(baseReport({
      kernelBackend: 'native',
      backendReasons: { native: 'should-not-appear' },
    }));
    expect(lines.join('\n')).not.toMatch(/native unavailable/);
  });

  it('reports "(not loadable)" when no backend could be resolved and none was requested', () => {
    const { lines } = formatDiagReport(baseReport({ kernelBackend: undefined, requestedBackend: null }));
    expect(lines.some(l => /kernel backend:\s+\(not loadable/.test(l))).toBe(true);
  });

  it('distinguishes a requested-but-unavailable backend from an uninstalled kernel', () => {
    const { lines } = formatDiagReport(baseReport({
      kernelBackend: undefined,
      requestedBackend: 'wasm',
      backendReasons: { wasm: 'kernel backend "wasm" was requested but is unavailable: ...' },
    }));
    const text = lines.join('\n');
    expect(text).toMatch(/kernel backend:\s+\(requested backend unavailable/);
    expect(text).toMatch(/\[requested: wasm\]/);
    expect(text).not.toMatch(/kernel not installed/);
  });
});

describe('buildDiagReport resolves a real backend (GH #22 integration)', () => {
  const prev = process.env.METAHARNESS_KERNEL_BACKEND;
  afterEach(() => {
    if (prev === undefined) delete process.env.METAHARNESS_KERNEL_BACKEND;
    else process.env.METAHARNESS_KERNEL_BACKEND = prev;
  });

  it('honors METAHARNESS_KERNEL_BACKEND=js end-to-end and never throws', async () => {
    process.env.METAHARNESS_KERNEL_BACKEND = 'js';
    const dir = await mkdtemp(join(tmpdir(), 'cah-diag-'));
    const report = await buildDiagReport(dir);
    expect(report.requestedBackend).toBe('js');
    expect(report.backendReasons).toBeTypeOf('object');
    // The js floor is always loadable when the kernel resolves. If the workspace
    // kernel can't be resolved in this environment at all, backend is undefined —
    // but buildDiagReport must never throw regardless.
    if (report.kernelBackend !== undefined) {
      expect(report.kernelBackend).toBe('js');
    }
  });
});

describe('buildDiagReport only reads data from the inspected directory', () => {
  it('does not import a kernel module that lives under the inspected directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cah-diag-local-'));
    const marker = join(dir, 'kernel-module-was-executed');
    await mkdir(join(dir, '.harness'), { recursive: true });
    await writeFile(join(dir, '.harness', 'manifest.json'), JSON.stringify({ name: 'h', kernel_version: '0.1.8' }));
    const kdir = join(dir, 'node_modules', '@metaharness', 'kernel');
    await mkdir(kdir, { recursive: true });
    await writeFile(join(kdir, 'package.json'), JSON.stringify({ name: '@metaharness/kernel', version: '0.1.8', type: 'module', main: 'index.js' }));
    await writeFile(join(kdir, 'index.js'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nexport {};\n`);
    const report = await buildDiagReport(dir);
    expect(existsSync(marker)).toBe(false);
    // The version is still read (as data) from the directory's package.json.
    expect(report.localKernelVersion).toBe('0.1.8');
  });
});
