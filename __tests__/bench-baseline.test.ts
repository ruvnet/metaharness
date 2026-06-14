// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore — JS module
import { flattenMetrics, compare } from '../scripts/bench-baseline.mjs';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'bench-baseline.mjs');

async function run(args: string[] = [], cwd: string = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], { cwd, windowsHide: true });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('flattenMetrics', () => {
  it('flattens host-bench shape', () => {
    const report = {
      iterations: 1000,
      results: [
        { host: 'claude-code', meanMs: 0.001, p95Ms: 0.005 },
        { host: 'rvm', meanMs: 0.004, p95Ms: 0.023 },
      ],
    };
    const flat = flattenMetrics(report);
    const paths = flat.map((m: any) => m.path).sort();
    expect(paths).toContain('iterations');
    expect(paths).toContain('results/claude-code/meanMs');
    expect(paths).toContain('results/rvm/p95Ms');
  });

  it('classifies latency-ish keys as lower-is-better', () => {
    const flat = flattenMetrics({ meanMs: 1.0, p95Ms: 5.0 });
    expect(flat.find((m: any) => m.path === 'meanMs')?.kind).toBe('lower');
    expect(flat.find((m: any) => m.path === 'p95Ms')?.kind).toBe('lower');
  });

  it('classifies quality keys as higher-is-better', () => {
    const flat = flattenMetrics({ ndcg: 0.85, recall: 0.7 });
    expect(flat.find((m: any) => m.path === 'ndcg')?.kind).toBe('higher');
    expect(flat.find((m: any) => m.path === 'recall')?.kind).toBe('higher');
  });
});

describe('compare', () => {
  it('reports no regressions when current matches baseline', () => {
    const a = { meanMs: 1.0, ndcg: 0.85 };
    const results = compare(a, a, 25);
    expect(results.every((r: any) => !r.regressed)).toBe(true);
  });

  it('flags latency regression > threshold', () => {
    const baseline = { meanMs: 1.0 };
    const current = { meanMs: 2.0 };  // +100% — slower
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(true);
    expect(results[0].deltaPct).toBeCloseTo(100, 0);
  });

  it('does not flag latency IMPROVEMENT (negative delta)', () => {
    const baseline = { meanMs: 1.0 };
    const current = { meanMs: 0.5 };  // -50% — faster, GOOD
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(false);
  });

  it('flags quality regression (lower than baseline by > threshold)', () => {
    const baseline = { ndcg: 1.0 };
    const current = { ndcg: 0.5 };  // 50% drop in quality
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(true);
  });

  it('does not flag quality IMPROVEMENT (higher than baseline)', () => {
    const baseline = { ndcg: 0.5 };
    const current = { ndcg: 0.9 };  // 80% gain in quality
    const results = compare(current, baseline, 25);
    expect(results[0].regressed).toBe(false);
  });
});

describe('script integration', () => {
  it('--update establishes baseline + exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      const current = join(dir, 'current.json');
      await writeFile(current, JSON.stringify({ meanMs: 1.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json', '--update'], dir);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/baseline updated/);
      // Confirm baseline written
      const txt = await readFile(join(dir, 'base.json'), 'utf-8');
      expect(JSON.parse(txt).meanMs).toBe(1.0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('first run with no baseline establishes one (exit 0)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      const current = join(dir, 'current.json');
      await writeFile(current, JSON.stringify({ p95Ms: 5.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json'], dir);
      expect(r.code).toBe(0);
      expect(r.stderr).toMatch(/establishing it/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('exit 1 on regression', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-bb-'));
    try {
      await writeFile(join(dir, 'base.json'), JSON.stringify({ meanMs: 1.0 }));
      await writeFile(join(dir, 'current.json'), JSON.stringify({ meanMs: 10.0 }));
      const r = await run(['--current=current.json', '--baseline=base.json', '--threshold=10'], dir);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/1 regression/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
