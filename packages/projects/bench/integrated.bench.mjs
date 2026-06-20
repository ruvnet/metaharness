// SPDX-License-Identifier: MIT
//
// Integrated acceptance benchmark (ADR-156). Composes the real modules into one
// scenario — 100 tasks × 3 repos — comparing a Darwin-evolved structured POLICY
// (cheap-first, typed handoffs, tiered memory, bounded scheduler, rails on) vs a
// frontier-only baseline. Targets: >=20% fewer retries, >=30% fewer wasted tokens,
// >=50% cheaper, same-or-better solve rate, zero guardrail bypasses. Deterministic.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRng, round6, defaultPolicy,
  simulateRetries,
  simulateRun, defaultDepthPolicy,
  Tracer, detectLeaks,
  RailRegistry, rejectsBeforeBenchmark,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 42;
const REPOS = 3;
const TASKS_PER_REPO = 100;
const TOTAL = REPOS * TASKS_PER_REPO;

// ── 1. Retries: typed handoffs (evolved) vs free-form (baseline). ──
const retriesEvolved = simulateRetries({ typed: true, tasks: TOTAL, seed: SEED }).retries;
const retriesBaseline = simulateRetries({ typed: false, tasks: TOTAL, seed: SEED }).retries;
const retryReductionPct = round6((1 - retriesEvolved / retriesBaseline) * 100);

// ── 2. Wasted tokens: composition of tiered memory (ADR-161) AND trace-based
//      pruning of repeated retrievals / oversized context (ADR-158). ADR-156
//      attributes the token win to BOTH mechanisms, so the integrated metric
//      composes them: memory shrinks per-task work tokens, and caching the repo
//      context (cacheRepoContext) collapses the per-task repo-context retrieval
//      that the trace ledger flags as a repeated-retrieval leak. ──
const rng = makeRng(SEED);
const classes = ['repo-bound', 'refactor', 'security', 'greenfield'];
const tasks = Array.from({ length: TOTAL }, (_, i) => ({
  id: `t${i}`,
  taskClass: classes[Math.floor(rng() * classes.length)],
  baseTokens: 2000 + Math.floor(rng() * 8000),
  solvableWithMemory: rng() < 0.7,
}));
const depth = defaultDepthPolicy();
const off = simulateRun(tasks, { memoryOn: false, depth, seed: SEED });
const on = simulateRun(tasks, { memoryOn: true, depth, seed: SEED });
const solveOk = on.solved >= off.solved;

// Repo-context retrieval: baseline re-loads it every task (a repeated-retrieval
// leak); the evolved policy (cacheRepoContext) loads it once and recalls from the
// repo memory tier thereafter. Confirm the leak is real via the trace ledger.
const REPO_CONTEXT_TOKENS = 3000;
const CACHE_RECALL_TOKENS = 120;
const baselineTrace = new Tracer('baseline', SEED);
for (let i = 0; i < TOTAL; i += 1) {
  baselineTrace.span('retrieval', 'load-repo-context', { tokensIn: REPO_CONTEXT_TOKENS, costUnits: 3 });
}
const baselineLeaks = detectLeaks(baselineTrace.spans());
const repeatedRetrievalLeak = baselineLeaks.some((l) => l.reason.includes('repeated'));

const baselineTokens = off.totalTokens + TOTAL * REPO_CONTEXT_TOKENS; // re-retrieved every task
const evolvedTokens = on.totalTokens + REPO_CONTEXT_TOKENS + (TOTAL - 1) * CACHE_RECALL_TOKENS; // loaded once, recalled
const tokensSavedPct = round6((1 - evolvedTokens / baselineTokens) * 100);

// ── 3. Cost: cheap-first policy with bounded frontier escalation vs frontier-only. ──
// Cost model (abstract units): a frontier model call costs 10, a cheap call 1.
// Baseline runs every task on frontier. The evolved policy runs cheap, escalating
// to frontier only on the configured failure fraction.
const policy = defaultPolicy();
const FRONTIER = 10;
const CHEAP = 1;
const baselineCost = TOTAL * FRONTIER;
const escalations = Math.round(TOTAL * (1 - policy.frontierEscalationThreshold)); // fraction that fails cheap → escalates
const evolvedCost = (TOTAL - escalations) * CHEAP + escalations * (CHEAP + FRONTIER);
const costReductionPct = round6((1 - evolvedCost / baselineCost) * 100);

// ── 4. Guardrail bypasses: a battery of cheating mutations must all be rejected. ──
const reg = new RailRegistry();
const cheats = [
  { id: 'c1', diff: '', touchedFiles: ['src/x.ts'], disablesTests: true, weakensSecurity: false, editsSecretsHandling: false, bypassesSandbox: false, protectedFilesTouched: [] },
  { id: 'c2', diff: '', touchedFiles: ['src/security/scoring.ts'], disablesTests: false, weakensSecurity: false, editsSecretsHandling: false, bypassesSandbox: false, protectedFilesTouched: [] },
  { id: 'c3', diff: '', touchedFiles: ['src/y.ts'], disablesTests: false, weakensSecurity: true, editsSecretsHandling: false, bypassesSandbox: false, protectedFilesTouched: [] },
  { id: 'c4', diff: '', touchedFiles: ['src/z.ts'], disablesTests: false, weakensSecurity: false, editsSecretsHandling: false, bypassesSandbox: true, protectedFilesTouched: [] },
];
const bypasses = cheats.filter((c) => !rejectsBeforeBenchmark(c, reg)).length;

// ── Verdict ──
const gates = {
  retries: { value: retryReductionPct, target: 20, pass: retryReductionPct >= 20 },
  tokens: { value: tokensSavedPct, target: 30, pass: tokensSavedPct >= 30 },
  cost: { value: costReductionPct, target: 50, pass: costReductionPct >= 50 },
  solveRate: { value: `${on.solved}/${off.solved}`, target: 'same-or-better', pass: solveOk },
  guardrailBypasses: { value: bypasses, target: 0, pass: bypasses === 0 },
};
const allPass = Object.values(gates).every((g) => g.pass);

const receipt = {
  scenario: '100 tasks × 3 repos, evolved policy vs frontier-only',
  seed: SEED,
  totalTasks: TOTAL,
  policy,
  tokenComposition: {
    memoryOnlySavedPct: round6((1 - on.totalTokens / off.totalTokens) * 100),
    combinedSavedPct: tokensSavedPct,
    repeatedRetrievalLeakDetected: repeatedRetrievalLeak,
    baselineTokens,
    evolvedTokens,
  },
  costModel: { baselineCost, evolvedCost, escalations },
  gates,
  allPass,
};
writeFileSync(join(here, 'results', 'integrated.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Integrated acceptance (ADR-156): ${TOTAL} tasks across ${REPOS} repos, seed ${SEED}\n`);
for (const [k, g] of Object.entries(gates)) {
  process.stdout.write(`  ${g.pass ? '✅' : '❌'} ${k}: ${g.value} (target ${g.target})\n`);
}
process.stdout.write(`  ${allPass ? 'ALL GATES PASS' : 'SOME GATES FAILED'} → receipt bench/results/integrated.json\n`);
if (!allPass) process.exitCode = 1;
