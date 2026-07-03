// SPDX-License-Identifier: MIT
//
// @metaharness/darwin/gepa — the GEPA learning engine (ADR-228, arXiv 2507.19457).
//
// "Freeze the model, evolve the harness" applied to PROMPT POLICY: the cheap executor's operating
// policy is a genome of named text components; an injected evaluator scores each candidate
// per-instance; a reflection LM reads the textual feedback (ASI) and proposes targeted
// single-component mutations; Pareto selection over per-instance score vectors keeps candidates
// that win on different task subsets; the STRICT holdout promotion rule gates what ships.
//
// What ships here: the engine (genome algebra, metric/ASI, the optimize loop with a PLUGGABLE
// evaluator, the promotion rule) + the first holdout-confirmed promoted genome (cand-6).
// What does NOT ship: the SWE-bench/Docker evaluator — it is repo-bound and remains in-repo at
// packages/darwin-mode/bench/swebench/gepa/ as the reference wiring.
//
// Modules:
//   genome     — genome load/validate/merge/component algebra + the frozen seed
//   metric     — per-instance scoring + failure-class taxonomy + ASI feedback text
//   loop       — the budgeted GEPA optimize loop (evaluator/reflector injected)
//   promotion  — the strict promote-on-holdout rule + report/composite-key helpers
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadGenome } from './genome.js';
export * from './genome.js';
export * from './metric.js';
export * from './loop.js';
export * from './promotion.js';
/**
 * Absolute path to the shipped cand-6 genome — the first holdout-confirmed cheap-tier policy
 * promotion (edit-by-midpoint; holdout gold 2/12 → 3/12, zero regressions, empty-patch rate
 * 0.583 → 0.333). Provenance: genomes/PROVENANCE.md in this package.
 */
export const CAND6_GENOME_PATH = fileURLToPath(new URL('../../genomes/genome-promoted-cand6-edit-by-midpoint.json', import.meta.url));
/** Load + validate the shipped cand-6 promoted genome. */
export function loadCand6Genome() {
    return loadGenome((p, enc) => readFileSync(p, enc), CAND6_GENOME_PATH);
}
//# sourceMappingURL=index.js.map