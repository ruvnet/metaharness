// SPDX-License-Identifier: MIT
//
// The numeric-genome evolution loop (ADR-272) — the numeric-kind analogue of
// `evolve.ts`'s prompt-kind loop:
//
//   baseline → (mutate/crossover → external evaluator → archive)* → select winner
//
// Reuses genuinely generic pieces from the prompt-kind implementation
// (`mapLimit` for bounded concurrency, `paretoFront` for multi-objective
// selection) but does not touch or extend `evolve()` itself — that function
// and its `HarnessVariant`/`createChildVariant` plumbing are irreducibly
// coupled to the seven-surface source-code mutation domain (ADR-071). This
// keeps the existing prompt-kind path completely unmodified and unregressed.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mapLimit } from './evolve.js';
import { paretoFront } from './pareto.js';
import { NumericArchive } from './numeric-archive.js';
import { crossoverGenome, defaultGenome, genomeToUnitVector, makeVariant, mutateGenome } from './numeric-mutator.js';
import { DEFAULT_SURROGATE_EXPLORE_SLOTS, DEFAULT_SURROGATE_MIN_ROWS, DEFAULT_SURROGATE_OVERSAMPLE, fitSurrogate, selectByPrediction, surrogateRowsFromArchive, validateSurrogateConfig, } from './numeric-surrogate.js';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_SIGMA = 0.2;
async function ensureWorkRoot(workRoot) {
    await mkdir(join(workRoot, 'reports'), { recursive: true });
}
/** L2 distance in unit-genome-space between a variant and the baseline — a deterministic parsimony proxy for Pareto selection. */
function genomeDistance(a, baseline) {
    let sum = 0;
    for (const key of Object.keys(baseline.genome)) {
        const av = a.genome[key] ?? 0;
        const bv = baseline.genome[key] ?? 0;
        const span = Math.max(Math.abs(bv), 1e-9);
        const d = (av - bv) / span;
        sum += d * d;
    }
    return Math.sqrt(sum);
}
export async function evolveNumeric(config) {
    const surrogate = config.surrogate;
    if (surrogate)
        validateSurrogateConfig(surrogate);
    const oversample = surrogate?.oversample ?? DEFAULT_SURROGATE_OVERSAMPLE;
    const report = { generationsScreened: 0, candidatesRanked: 0, candidatesSelected: 0, fallbacks: [] };
    let surrogateFitted = false;
    let lastHoldoutSpearman;
    await ensureWorkRoot(config.workRoot);
    const archive = new NumericArchive(join(config.workRoot, 'archive.json'));
    await archive.load();
    const seed = config.seed ?? 0;
    const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    const sigma = config.mutationSigma ?? DEFAULT_SIGMA;
    const baselineGenome = config.baselineGenome ?? defaultGenome(config.genomeSpec);
    const baseline = makeVariant(null, 0, 0, baselineGenome, [], 'baseline genome');
    archive.addVariant(baseline);
    const baselineScore = await config.evaluator.evaluate(baseline.genome, baseline.id);
    archive.setScore(baseline.id, baselineScore);
    await archive.save();
    let parents = [baseline];
    for (let generation = 1; generation <= config.generations; generation++) {
        const children = [];
        const canCross = config.crossover === true && parents.length >= 2;
        // Surrogate pre-screen (opt-in): decide whether this generation is screened.
        // Any reason it is not — warm-up, too few rows, a declined/failed fit —
        // leaves the generation exactly as the unscreened loop would run it.
        let screen = false;
        let fallbackReason;
        let rowCount = 0;
        if (surrogate) {
            const mutationSlots = config.childrenPerGeneration - (canCross ? 1 : 0);
            const rows = surrogateRowsFromArchive(archive.all(), config.genomeSpec);
            rowCount = rows.length;
            if (mutationSlots < 1)
                fallbackReason = 'no mutation slots to screen';
            else if (generation <= (surrogate.warmupGenerations ?? 0))
                fallbackReason = 'warm-up generation';
            else if (rows.length < (surrogate.minRows ?? DEFAULT_SURROGATE_MIN_ROWS)) {
                fallbackReason = `${rows.length} scored rows < minRows ${surrogate.minRows ?? DEFAULT_SURROGATE_MIN_ROWS}`;
            }
            else if (surrogateFitted && (generation - 1) % (surrogate.refitEvery ?? 1) !== 0) {
                screen = true; // reuse the previous fit
            }
            else {
                const outcome = await fitSurrogate(surrogate.model, rows, surrogate.trust);
                surrogateFitted = outcome.ready;
                if (outcome.ready) {
                    screen = true;
                    lastHoldoutSpearman = outcome.holdoutSpearman;
                }
                else
                    fallbackReason = outcome.reason;
            }
        }
        let rankedThisGeneration = 0;
        let selectedThisGeneration = 0;
        for (let pIdx = 0; pIdx < parents.length; pIdx++) {
            const parent = parents[pIdx];
            const pool = [];
            for (let localIndex = 0; localIndex < config.childrenPerGeneration; localIndex++) {
                const index = pIdx * config.childrenPerGeneration + localIndex;
                if (canCross && localIndex === 0) {
                    const other = parents[(pIdx + 1) % parents.length];
                    const { genome, fromB } = crossoverGenome(parent.genome, other.genome, config.genomeSpec, seed, generation, index);
                    children.push(makeVariant(parent, generation, index, genome, fromB, fromB.length > 0
                        ? `crossover: params [${fromB.join(', ')}] from ${other.id} onto ${parent.id}`
                        : `crossover: no param adopted from ${other.id} (identical to ${parent.id})`));
                }
                else {
                    pool.push({ index, ...mutateGenome(parent.genome, config.genomeSpec, seed, generation, index, sigma) });
                }
            }
            const slots = pool.length;
            const summaryOf = (c) => c.mutatedParams.length > 0 ? `perturbed [${c.mutatedParams.join(', ')}]` : 'no-op perturbation (clamped to parent)';
            let picked = pool.map((candidate) => ({ candidate, note: '' }));
            if (screen && surrogate && slots > 0) {
                // The unscreened loop's own candidates stay first in the pool; the extra
                // proposals take indices past every unscreened index, so ids never collide.
                const extraPerParent = slots * (oversample - 1);
                const extraBase = parents.length * config.childrenPerGeneration + pIdx * extraPerParent;
                for (let j = 0; j < extraPerParent; j++) {
                    const index = extraBase + j;
                    pool.push({ index, ...mutateGenome(parent.genome, config.genomeSpec, seed, generation, index, sigma) });
                }
                try {
                    const predictions = surrogate.model.predict(pool.map((c) => genomeToUnitVector(c.genome, config.genomeSpec)));
                    if (predictions.length !== pool.length)
                        throw new Error(`predict returned ${predictions.length} values for ${pool.length} candidates`);
                    const explore = Math.min(surrogate.exploreSlots ?? DEFAULT_SURROGATE_EXPLORE_SLOTS, slots - 1);
                    picked = selectByPrediction(predictions, slots, explore).map((pick) => ({
                        candidate: pool[pick.poolIndex],
                        note: pick.kind === 'explore'
                            ? ` [surrogate: explore slot, rank ${pick.rank}/${pool.length}]`
                            : ` [surrogate: rank ${pick.rank}/${pool.length}, predicted ${Number(pick.predicted.toPrecision(4))}]`,
                    }));
                    rankedThisGeneration += pool.length;
                    selectedThisGeneration += picked.length;
                }
                catch (error) {
                    // Fail open: keep this parent's unscreened candidates.
                    picked = pool.slice(0, slots).map((candidate) => ({ candidate, note: '' }));
                    screen = false;
                    surrogateFitted = false;
                    fallbackReason = `surrogate error: ${error.message}`;
                }
            }
            for (const { candidate, note } of picked) {
                children.push(makeVariant(parent, generation, candidate.index, candidate.genome, candidate.mutatedParams, summaryOf(candidate) + note));
            }
        }
        if (surrogate) {
            if (rankedThisGeneration > 0) {
                report.generationsScreened += 1;
                report.candidatesRanked += rankedThisGeneration;
                report.candidatesSelected += selectedThisGeneration;
            }
            if (fallbackReason !== undefined)
                report.fallbacks.push({ generation, reason: fallbackReason });
            surrogate.onGeneration?.(fallbackReason === undefined
                ? { generation, screened: true, rows: rowCount, ranked: rankedThisGeneration, selected: selectedThisGeneration, holdoutSpearman: lastHoldoutSpearman }
                : { generation, screened: false, reason: fallbackReason });
        }
        for (const child of children)
            archive.addVariant(child);
        const scores = await mapLimit(children, concurrency, (child) => config.evaluator.evaluate(child.genome, child.id));
        const promoted = [];
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const parent = archive.get(child.parentId ?? '')?.variant ?? baseline;
            const parentScore = archive.get(parent.id)?.score;
            archive.setScore(child.id, scores[i]);
            const improved = parentScore ? scores[i].primary > parentScore.primary : scores[i].primary > 0;
            if (!scores[i].regressed && improved)
                promoted.push(child);
        }
        await archive.save();
        if (promoted.length > 0) {
            parents = promoted.slice(0, 2);
        }
        else {
            // Stall fallback (mirrors ADR-073): draw from the whole archive by score,
            // then break ties toward genome diversity via the Pareto front over
            // (primary ↑, distance-from-baseline ↑) so a stalled search still explores.
            const scoredRecords = archive.all().filter((r) => r.score !== null && !r.score.regressed);
            const withDistance = scoredRecords.map((r) => ({ v: r.variant, primary: r.score.primary, distance: genomeDistance(r.variant, baseline) }));
            const front = paretoFront(withDistance, (o) => [o.primary, o.distance]);
            const ranked = (front.length > 0 ? front : withDistance).sort((a, b) => b.primary - a.primary).slice(0, 2);
            parents = ranked.length > 0 ? ranked.map((r) => r.v) : archive.selectParents(2);
            if (parents.length === 0)
                break;
        }
    }
    const winner = archive.best();
    const winnerLineage = winner ? archive.lineageOf(winner.variant.id) : [];
    await writeFile(join(config.workRoot, 'reports', 'winner.json'), JSON.stringify(winner, null, 2), 'utf8');
    const baselineRecord = archive.get(baseline.id);
    return {
        baseline: baselineRecord ?? { variant: baseline, score: baselineScore, children: [] },
        winner,
        records: archive.all(),
        generations: config.generations,
        winnerLineage,
        ...(surrogate ? { surrogate: report } : {}),
    };
}
//# sourceMappingURL=numeric-evolve.js.map