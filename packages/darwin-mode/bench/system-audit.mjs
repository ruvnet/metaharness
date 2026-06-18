// SPDX-License-Identifier: MIT
//
// System audit dashboard (ADR-099). Benchmarks the EVOLUTION ENGINE itself, not
// task accuracy — five metrics that prove it is a reliable scientific instrument:
//
//   1. determinismDivergence   — two same-seed runs must produce an identical
//                                 archive (ADR-075). Success = 0.
//   2. fdrEmpirical            — feed BH true-null p-values; the empirical
//                                 false-discovery rate must be ≤ q (validates
//                                 ADR-096 on actual null data).
//   3. hge                     — Huxley-Gödel proxy: promoted / scored (clade
//                                 productivity, ADR-094).
//   4. nicheEntropy            — Shannon entropy of the behavioural-niche
//                                 distribution (ADR-091); higher = less monoculture.
//   5. adaptationLatency       — generations to first solve of a newly-admitted
//                                 hard tier (ADR-097); requires a graded suite.
//
// Run: node bench/system-audit.mjs   (deterministic, seeded; writes JSON to stdout)

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evolve, behavioralNiche, mulberry32 } from '../dist/index.js';
import { benjaminiHochberg } from '../dist/bench/stats.js';

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'darwin-audit-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'audit-target', version: '1.0.0', private: true,
    scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  writeFileSync(join(root, 'src', 'i.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'README.md'), '# audit target\n');
  return root;
}

const baseCfg = {
  generations: 3, childrenPerGeneration: 3, concurrency: 3, seed: 7,
  promotionDelta: 0.05, tasks: ['t1', 't2'],
};

async function runInto(repo, extra = {}) {
  const workRoot = mkdtempSync(join(tmpdir(), 'darwin-audit-wr-'));
  const result = await evolve({ repoRoot: repo, workRoot, ...baseCfg, ...extra });
  return { workRoot, result };
}

/** A stable fingerprint of an archive's scored structure. */
function archiveFingerprint(records) {
  return records
    .filter((r) => r.score)
    .map((r) => `${r.variant.id}:${r.variant.mutationSurface}:${r.score.finalScore}:${r.score.promoted}`)
    .sort()
    .join('|');
}

// 1. Determinism divergence — two same-seed runs.
const repo = makeRepo();
const a = await runInto(repo);
const b = await runInto(repo);
const determinismDivergence = archiveFingerprint(a.result.records) === archiveFingerprint(b.result.records) ? 0 : 1;

// 3+4. HGE + niche entropy, from run a's archive + run traces.
function loadTraces(workRoot, id) {
  try {
    return JSON.parse(readFileSync(join(workRoot, 'runs', `${id}.json`), 'utf8')).traces ?? [];
  } catch {
    return [];
  }
}
const scored = a.result.records.filter((r) => r.score);
const promoted = scored.filter((r) => r.score.promoted).length;
const hge = scored.length ? +(promoted / scored.length).toFixed(4) : 0;

const nicheCounts = new Map();
for (const r of scored) {
  const n = behavioralNiche(loadTraces(a.workRoot, r.variant.id));
  nicheCounts.set(n, (nicheCounts.get(n) ?? 0) + 1);
}
const total = [...nicheCounts.values()].reduce((s, c) => s + c, 0) || 1;
let nicheEntropy = 0;
for (const c of nicheCounts.values()) {
  const p = c / total;
  nicheEntropy -= p * Math.log(p);
}
nicheEntropy = +nicheEntropy.toFixed(4);

// 2. FDR empirical — feed BH TRUE-NULL p-values and measure the false-discovery
//    rate. Under H0 (no real effect) p-values are ~Uniform(0,1); BH at q must
//    keep E[false discoveries / discoveries] ≤ q.
const q = 0.05;
const TRIALS = 40000, N = 12;
const rng = mulberry32(12345);
let trialsWithDiscoveries = 0;
for (let t = 0; t < TRIALS; t++) {
  const ps = Array.from({ length: N }, () => rng());
  const discoveries = benjaminiHochberg(ps, q).filter(Boolean).length;
  // All hypotheses are true nulls, so V = R: FDR = E[V/R·1{R>0}] = P(R>0).
  if (discoveries > 0) trialsWithDiscoveries++;
}
const fdrEmpirical = +(trialsWithDiscoveries / TRIALS).toFixed(4);
// BH's guarantee is on the EXPECTATION, so judge against q within sampling noise
// (a knife-edge compare flips on Monte-Carlo error). SE of a proportion ≈ √(q(1-q)/T).
const fdrSE = Math.sqrt((q * (1 - q)) / TRIALS);
const fdrControlled = fdrEmpirical <= q + 3 * fdrSE;

// 5. Adaptation latency — needs a graded suite; honest n/a here.
const adaptationLatency = null; // requires a multi-difficulty benchSuite (ADR-097)

rmSync(repo, { recursive: true, force: true });
[a.workRoot, b.workRoot].forEach((w) => rmSync(w, { recursive: true, force: true }));

console.log(JSON.stringify({
  determinismDivergence,
  fdr: { q, empirical: fdrEmpirical, controlled: fdrControlled, se: +fdrSE.toFixed(4), trials: TRIALS, hypothesesPerTrial: N },
  hge,
  nicheEntropy,
  distinctNiches: nicheCounts.size,
  adaptationLatency,
  notes: {
    determinism: 'two same-seed evolve runs; 0 = identical archive (ADR-075)',
    fdr: 'BH on true-null uniform p-values; controlled iff empirical ≤ q (validates ADR-096)',
    hge: 'promoted/scored — clade-productivity proxy (ADR-094)',
    nicheEntropy: 'Shannon entropy of behavioural niches (ADR-091); higher = less monoculture',
    adaptationLatency: 'null = requires a graded multi-difficulty benchSuite (ADR-097)',
  },
}, null, 2));
