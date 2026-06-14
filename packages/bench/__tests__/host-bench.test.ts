// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { benchHost, benchAllHosts, formatResultsTable, HOST_ADAPTERS } from '../src/host-bench.js';

describe('host-bench', () => {
  it('benchHost returns sensible metrics for every host', () => {
    for (const adapter of HOST_ADAPTERS) {
      const r = benchHost(adapter, 50);  // tiny iter count for test speed
      expect(r.host).toBe(adapter.name);
      expect(r.iterations).toBe(50);
      expect(r.meanMs).toBeGreaterThanOrEqual(0);
      expect(r.p95Ms).toBeGreaterThanOrEqual(r.p50Ms);
      expect(r.p99Ms).toBeGreaterThanOrEqual(r.p95Ms);
      expect(r.filesPerCall).toBeGreaterThan(0);
      expect(r.bytesPerCall).toBeGreaterThan(0);
    }
  });

  it('benchAllHosts covers all 8 adapters', () => {
    const results = benchAllHosts(20);
    expect(results).toHaveLength(8);
    const hosts = new Set(results.map(r => r.host));
    expect(hosts).toEqual(new Set(['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm', 'copilot', 'opencode']));
  });

  it('formatResultsTable produces a valid markdown table', () => {
    const results = benchAllHosts(10);
    const table = formatResultsTable(results);
    expect(table.split('\n')[0]).toMatch(/^\| Host/);
    expect(table.split('\n')[1]).toMatch(/^\|---/);
    // One row per host plus 2 header rows
    expect(table.split('\n')).toHaveLength(8 + 2);
  });

  it('config-gen latency is reasonable (mean < 5ms per host)', () => {
    // Sanity guard against accidental O(n^2) regressions. 5ms is a
    // generous upper bound even on slow CI hardware.
    const results = benchAllHosts(100);
    for (const r of results) {
      expect(r.meanMs, `${r.host} mean ${r.meanMs}ms exceeds 5ms`).toBeLessThan(5);
    }
  });

  it('every host generates at least 1 file', () => {
    const results = benchAllHosts(10);
    for (const r of results) {
      expect(r.filesPerCall, `${r.host} produces no files`).toBeGreaterThanOrEqual(1);
    }
  });
});
