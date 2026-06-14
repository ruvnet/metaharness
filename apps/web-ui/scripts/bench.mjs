// SPDX-License-Identifier: MIT
//
// Micro-benchmark for the client-side generator hot paths. Everything runs in
// the browser on the user's machine, so "fast enough to feel instant" is the
// bar: scaffold + repo-analysis + verify should each be sub-millisecond so the
// live preview never stutters. Run: node scripts/bench.mjs
//
// Run with `npm run bench` (vite-node handles the TS + extensionless imports).

import { performance } from 'node:perf_hooks';
import {
  buildScaffold,
  analyzeFiles,
  recommendPlan,
  verifyFileMap,
  DEFAULT_PRIMITIVES,
  SAFE_MCP_POLICY,
} from '../src/generator/index.ts';

const cfg = {
  name: 'bench-bot',
  description: 'benchmark',
  hosts: ['claude-code', 'codex'],
  template: 'vertical:coding',
  memory: 'agentdb',
  routing: '3-tier',
  marketplace: 'powered-by',
  agents: ['architect', 'implementer', 'reviewer', 'test-writer'],
  skills: ['plan-change'],
  commands: ['doctor', 'review-diff'],
  primitives: DEFAULT_PRIMITIVES,
  mcpPolicy: SAFE_MCP_POLICY,
};

const repoFiles = {
  owner: 'ruvnet',
  repo: 'ruvector',
  files: {
    'README.md': 'Rust + WASM vector and agentic database. cargo build, clippy, HNSW. '.repeat(20),
    'Cargo.toml': '[package]\nname="ruvector"\nedition="2021"\n[dependencies]\nserde="1"',
  },
};

function bench(name, fn, iters = 5000) {
  fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const per = (ms / iters) * 1000; // µs
  console.log(`  ${name.padEnd(22)} ${per.toFixed(1).padStart(8)} µs/op   (${iters} ops in ${ms.toFixed(0)} ms)`);
  return per;
}

console.log('agent-harness-generator — generator micro-bench\n');
const scaffold = bench('buildScaffold', () => buildScaffold(cfg));
const analyze = bench('analyzeFiles', () => analyzeFiles(repoFiles));
const recommend = bench('recommendPlan', () => recommendPlan(analyzeFiles(repoFiles)), 2000);
const files = buildScaffold(cfg);
const verify = bench('verifyFileMap', () => verifyFileMap(files));

const budgetUs = 2000; // 2 ms/op ceiling — comfortably "instant" for a live preview
const worst = Math.max(scaffold, analyze, recommend, verify);
console.log(`\n  worst: ${worst.toFixed(1)} µs/op (budget ${budgetUs} µs)`);
if (worst > budgetUs) {
  console.error('  FAIL — a hot path exceeded the budget');
  process.exit(1);
}
console.log('  PASS — all hot paths within budget');
