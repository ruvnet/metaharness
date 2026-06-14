// SPDX-License-Identifier: MIT
//
// Cross-host config-generation benchmark.
//
// Per ADR-004, every host adapter implements `generateConfig(spec)` →
// `Record<filename, contents>`. This benchmark measures THROUGHPUT of
// that function for each of the 8 supported hosts, lets users compare
// adapters apples-to-apples, and surfaces regressions before they land.
//
// What we measure (deterministic, no I/O):
//   - mean / p50 / p95 / p99 latency per host
//   - bytes-of-output emitted per call (proxy for config complexity)
//   - file-count per call

import { performance } from 'node:perf_hooks';
import adapterClaudeCode from '@ruflo/host-claude-code';
import adapterCodex from '@ruflo/host-codex';
import adapterPiDev from '@ruflo/host-pi-dev';
import adapterHermes from '@ruflo/host-hermes';
import adapterOpenclaw from '@ruflo/host-openclaw';
import adapterRvm from '@ruflo/host-rvm';
import adapterCopilot from '@ruflo/host-copilot';
import adapterOpencode from '@ruflo/host-opencode';

interface HostAdapter {
  name: string;
  generateConfig(spec: { name: string; description?: string }): Record<string, string>;
}

export const HOST_ADAPTERS: HostAdapter[] = [
  adapterClaudeCode as HostAdapter,
  adapterCodex as HostAdapter,
  adapterPiDev as HostAdapter,
  adapterHermes as HostAdapter,
  adapterOpenclaw as HostAdapter,
  adapterRvm as HostAdapter,
  adapterCopilot as HostAdapter,   // iter 127 (ADR-032)
  adapterOpencode as HostAdapter,  // iter 128 (ADR-036)
];

export interface HostBenchResult {
  host: string;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  filesPerCall: number;
  bytesPerCall: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/**
 * Benchmark one host adapter over `iterations` runs against a fixed
 * spec. Returns per-percentile latency + output-size measurements.
 */
export function benchHost(adapter: HostAdapter, iterations: number = 1000): HostBenchResult {
  const spec = { name: 'bench-bot', description: 'cross-host benchmark spec' };
  // Warmup: 50 iterations to stabilise JIT
  for (let i = 0; i < 50; i++) adapter.generateConfig(spec);
  const samples: number[] = new Array(iterations);
  let lastOutput: Record<string, string> | null = null;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const out = adapter.generateConfig(spec);
    samples[i] = performance.now() - t0;
    lastOutput = out;
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const fileCount = lastOutput ? Object.keys(lastOutput).length : 0;
  const bytes = lastOutput
    ? Object.values(lastOutput).reduce((s, v) => s + v.length, 0)
    : 0;
  return {
    host: adapter.name,
    iterations,
    meanMs: mean,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    filesPerCall: fileCount,
    bytesPerCall: bytes,
  };
}

/** Run benchHost across every supported host adapter. */
export function benchAllHosts(iterations: number = 1000): HostBenchResult[] {
  return HOST_ADAPTERS.map(a => benchHost(a, iterations));
}

/** Format the benchmark results as a markdown table for CI annotations. */
export function formatResultsTable(results: HostBenchResult[]): string {
  const lines: string[] = [];
  lines.push('| Host | n | mean (ms) | p50 | p95 | p99 | files | bytes |');
  lines.push('|------|---|-----------|-----|-----|-----|-------|-------|');
  for (const r of results) {
    lines.push(`| ${r.host} | ${r.iterations} | ${r.meanMs.toFixed(3)} | ${r.p50Ms.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.p99Ms.toFixed(3)} | ${r.filesPerCall} | ${r.bytesPerCall} |`);
  }
  return lines.join('\n');
}
