// SPDX-License-Identifier: MIT
//
// ADR-228 / ADR-235 — the STRICT promote-on-holdout rule + promotion-report helpers.
//
// TypeScript port of the pure, $0-tested helpers exported by bench/swebench/gepa/learn.mjs
// (isEmptyPatchDetail, resolvedIdSet, emptyPatchRate, totalThrash, summarizeEval,
// evaluatePromotion, compositeKey, buildPromotionReport) — behavior-preserving. The learn CLI
// wiring (spawning run-gepa, loading eval artifacts) is repo-bound and stays in bench.
//
// STRICT promotion rule (product spec) — promote the winning candidate ONLY if ALL hold on the
// UNSEEN holdout slice:
//   (1) gold does NOT regress — no instance the seed resolved is lost by the candidate;
//   (2) empty-patch rate improves — strictly fewer class-3 (exploration-loop / empty-patch) failures;
//   (3) cost/resolved does not worsen — candidate $/resolved <= seed $/resolved.
// Empty-patch = failureClass===3 (metric.ts classifyFailure). All facts come from each holdout
// eval's per-instance `.details` ({ gold, failureClass, thrash, cost }).
/** Empty-patch instance ⇔ failureClass===3 (exploration-loop / empty patch). */
export const isEmptyPatchDetail = (d) => !!d && d.failureClass === 3;
/** Set of instance_ids the run gold-resolved, from an eval JSON's `.details`. */
export function resolvedIdSet(details = {}) {
    return new Set(Object.keys(details).filter((id) => details[id] && details[id].gold === true));
}
/** Empty-patch rate = (# class-3 instances) / N, over an eval JSON's `.details`. */
export function emptyPatchRate(details = {}) {
    const ids = Object.keys(details);
    if (!ids.length)
        return 0;
    const empties = ids.filter((id) => isEmptyPatchDetail(details[id])).length;
    return Math.round((empties / ids.length) * 1000) / 1000;
}
/** Sum of per-instance thrash from `.details`. */
export function totalThrash(details = {}) {
    return Object.values(details).reduce((s, d) => s + (d && d.thrash ? d.thrash : 0), 0);
}
/** Roll a full eval JSON into the comparable summary the report + rule consume. */
export function summarizeEval(ev = {}) {
    const details = ev.details || {};
    const gold = typeof ev.goldResolved === 'number'
        ? ev.goldResolved
        : resolvedIdSet(details).size;
    const cost = typeof ev.cost === 'number' ? ev.cost : 0;
    const costPerResolved = gold > 0 ? Math.round((cost / gold) * 1e4) / 1e4 : Infinity;
    return {
        n: ev.n ?? Object.keys(details).length,
        gold,
        sum: ev.sumScore ?? null,
        emptyPatchRate: emptyPatchRate(details),
        thrash: totalThrash(details),
        cost: Math.round(cost * 1e4) / 1e4,
        costPerResolved,
        resolvedIds: [...resolvedIdSet(details)],
    };
}
/**
 * The STRICT promotion predicate over HOLDOUT seed vs candidate summaries (from summarizeEval).
 * Returns { promote, reason, checks, regressions, gains }.
 */
export function evaluatePromotion({ seed, cand }) {
    const seedSet = new Set(seed.resolvedIds || []);
    const candSet = new Set(cand.resolvedIds || []);
    const regressions = [...seedSet].filter((id) => !candSet.has(id)); // seed-resolved lost by cand
    const gains = [...candSet].filter((id) => !seedSet.has(id)); // newly resolved by cand
    const goldNoRegress = regressions.length === 0;
    const emptyPatchImproves = cand.emptyPatchRate < seed.emptyPatchRate;
    // "does not worsen": candidate $/resolved must be <= seed's (Infinity when 0 resolved).
    const costPerResolvedNotWorse = cand.costPerResolved <= seed.costPerResolved;
    const checks = { goldNoRegress, emptyPatchImproves, costPerResolvedNotWorse };
    const promote = goldNoRegress && emptyPatchImproves && costPerResolvedNotWorse;
    const fails = [];
    if (!goldNoRegress)
        fails.push(`gold regressed: lost seed-resolved ${JSON.stringify(regressions)}`);
    if (!emptyPatchImproves)
        fails.push(`empty-patch rate did not improve (${seed.emptyPatchRate} → ${cand.emptyPatchRate})`);
    if (!costPerResolvedNotWorse)
        fails.push(`cost/resolved worsened ($${seed.costPerResolved} → $${cand.costPerResolved})`);
    const reason = promote
        ? `PROMOTE: gold no-regress (${gains.length} new, 0 lost), empty-patch ${seed.emptyPatchRate}→${cand.emptyPatchRate}, cost/resolved $${seed.costPerResolved}→$${cand.costPerResolved}`
        : `REJECT: ${fails.join('; ')}`;
    return { promote, reason, checks, regressions, gains };
}
/** Composite registry key: host+model+vertical+language+task_class+genome_version. */
export function compositeKey({ host, model, vertical, language, task_class, genome_version }) {
    return [host, model, vertical, language, task_class, genome_version]
        .map((x) => String(x ?? 'unknown')).join('+');
}
/**
 * Assemble the full promotion report object (pure — a CLI just feeds it real evals + writes it).
 *   host, model, slice, seedId, candId, genomeVersion
 *   train  { seed, cand }  holdout { seed, cand }  — each a summarizeEval() result (cand optional)
 *   keyMeta { vertical, language, task_class }
 *   run    { budget, best, frontier, ... }  (optional provenance from the GEPA run)
 */
export function buildPromotionReport({ host, model, slice, seedId, candId, genomeVersion, train, holdout, keyMeta = {}, run = null, ranAt = new Date().toISOString(), }) {
    const vertical = keyMeta.vertical || 'code-repair';
    const language = keyMeta.language || 'python';
    const task_class = keyMeta.task_class || 'bug-fix';
    const key = compositeKey({ host, model, vertical, language, task_class, genome_version: genomeVersion });
    // The load-bearing decision is HOLDOUT-only (out-of-sample).
    const verdict = evaluatePromotion({ seed: holdout.seed, cand: holdout.cand || holdout.seed });
    return {
        ranAt,
        key,
        keyParts: { host, model, vertical, language, task_class, genome_version: genomeVersion },
        slice,
        seed: seedId,
        candidate: candId,
        train: { seed: train.seed, cand: train.cand || null },
        holdout: { seed: holdout.seed, cand: holdout.cand || null },
        regressions: verdict.regressions,
        gains: verdict.gains,
        checks: verdict.checks,
        verdict: verdict.promote ? 'promote' : 'reject',
        reason: verdict.reason,
        rule: 'strict: gold-no-regress AND holdout-empty-patch-improves AND cost/resolved-not-worse',
        run: run ? {
            best: run.best, frontier: run.frontier, bestMean: run.bestMean,
            budget: run.budget, holdoutGoldDelta: run.holdout ? run.holdout.goldDelta : null,
        } : null,
    };
}
//# sourceMappingURL=promotion.js.map