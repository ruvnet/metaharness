// SPDX-License-Identifier: MIT
//
// Bench for trace.ts (ADR-158 Darwin Trace Format & Cost Ledger).
//
// Synthesizes a realistic 200-span run, then reports the real optimization:
// detectLeaks() finds wasted spend (repeated retrieval/memory/tool calls,
// frontier models on low-risk work, oversized context) and we project the
// savings as a % of total cost. Writes bench/results/trace.json and exits 0.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CostLedger, Tracer, detectLeaks } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SPANS = 200;

const t = new Tracer('bench-genome', 1);

// Synthesize a realistic run: planning, retrieval (some repeated/oversized),
// model calls (some frontier on low-risk), tool calls, tests and reviews.
for (let i = 0; i < SPANS; i += 1) {
  const m = i % 10;
  if (m === 0) {
    t.span('planner', 'decompose-task', { model: 'cheap', tokensIn: 800, tokensOut: 400, costUnits: 2 });
  } else if (m === 1) {
    // Repeated identical retrieval (the cache should have served these).
    t.span('retrieval', 'load-repo-context', { tokensIn: 1200, costUnits: 3 });
  } else if (m === 2) {
    t.span('retrieval', `chunk-${i % 4}`, { tokensIn: 600, costUnits: 1 });
  } else if (m === 3) {
    // Occasional oversized retrieval context.
    const big = i % 30 === 3;
    t.span('retrieval', big ? 'whole-tree-dump' : 'scoped-fetch', {
      tokensIn: big ? 16000 : 700,
      costUnits: big ? 9 : 1,
    });
  } else if (m === 4) {
    t.span('model', 'generate-patch', { model: 'cheap', tokensIn: 1500, tokensOut: 800, costUnits: 6 });
  } else if (m === 5) {
    // Frontier on low-risk work (waste).
    const lowRisk = i % 20 === 5;
    t.span('model', lowRisk ? 'format fix (low-risk)' : 'hard reasoning', {
      model: 'frontier',
      tokensIn: 2000,
      tokensOut: 1000,
      costUnits: lowRisk ? 14 : 14,
    });
  } else if (m === 6) {
    // Repeated identical tool call.
    t.span('tool', 'run-linter', { costUnits: 1 });
  } else if (m === 7) {
    t.span('memory', 'recall-episode', { costUnits: 1 });
  } else if (m === 8) {
    t.span('test', `pytest-shard-${i % 3}`, { costUnits: 2 });
  } else {
    t.span('review', 'diff-review', { model: 'frontier_on_failure', costUnits: 4 });
  }
}

const spans = t.spans();
const ledger = new CostLedger(spans);
const totalCost = ledger.total();
const byKind = ledger.byKind();

const leaks = detectLeaks(spans);
const projectedSavings = +leaks.reduce((a, l) => a + l.wastedCostUnits, 0).toFixed(6);
const projectedSavingsPct = +((projectedSavings / totalCost) * 100).toFixed(2);

console.log(`[trace] spans=${spans.length} totalCost=${totalCost}`);
console.log(`[trace] byKind=${JSON.stringify(byKind)}`);
console.log(`[trace] leaks=${leaks.length} projectedSavings=${projectedSavings} (${projectedSavingsPct}%)`);
for (const l of leaks.slice(0, 5)) {
  console.log(`[trace]   - ${l.reason}: "${l.label}" x${l.count} → ${l.wastedCostUnits} units`);
}

const receipt = { totalCost, byKind, leaks: leaks.length, projectedSavingsPct };
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'trace.json'), JSON.stringify(receipt, null, 2));
console.log(`[trace] receipt → bench/results/trace.json`);
process.exit(0);
