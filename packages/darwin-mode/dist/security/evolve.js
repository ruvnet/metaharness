// SPDX-License-Identifier: MIT
//
// Darwin Shield — the evolution loop (ADR-155 §decision, §swarm loop). Mutate a
// population, score each variant by fitness over the corpus, select superior
// descendants (elitism + diversity), archive the lineage, repeat for N cycles.
// The model is frozen; ONLY the harness evolves. Deterministic for a fixed seed.
import { baselineGenome, crossover, mutate, seedPopulation } from './genome.js';
import { COST_BUDGET, TIME_BUDGET, fitness } from './scoring.js';
import { corpusCounts, runSwarm } from './swarm.js';
import { makeRng } from './util.js';
/** Score one genome over the whole corpus → fitness breakdown. */
export function evaluate(genome, cfg, taskId) {
    const counts = corpusCounts(cfg.corpus);
    const run = runSwarm(genome, cfg.corpus, taskId, cfg.memory ? { memory: cfg.memory } : {});
    const breakdown = fitness({
        metrics: run.metrics,
        groundTruthCount: counts.groundTruth,
        decoyCount: counts.decoys,
        baselineFalsePositiveRate: cfg.baselineFalsePositiveRate,
        costBudget: COST_BUDGET,
        timeBudget: TIME_BUDGET,
    });
    return { genome, breakdown };
}
/** Run the full evolutionary search. Returns the champion + learning curve. */
export function evolve(cfg) {
    const seed = cfg.seed ?? 0;
    const eliteFraction = cfg.eliteFraction ?? 0.25;
    const useCrossover = cfg.crossover ?? true;
    const base = cfg.base ?? baselineGenome();
    const rng = makeRng(seed);
    const baseline = evaluate(base, cfg, 'baseline');
    // Genome memory seeds the initial population from prior winners (ADR-155).
    const seeds = cfg.memory ? cfg.memory.seedPopulation({ repo: cfg.corpus.id, commit: cfg.corpus.version, languages: ['ts'], frameworks: [], unitCount: 0, attackSurface: [], summary: '' }, Math.floor(cfg.population / 2)) : [];
    let population = seedPopulation(base, cfg.population, seed, seeds);
    const lineageParent = new Map();
    let champion = baseline;
    const history = [];
    let evaluations = 0;
    const eliteCount = Math.max(1, Math.floor(cfg.population * eliteFraction));
    for (let cycle = 0; cycle < cfg.cycles; cycle += 1) {
        const scored = population.map((g) => {
            evaluations += 1;
            return evaluate(g, cfg, `cycle-${cycle}`);
        });
        scored.sort((a, b) => b.breakdown.fitness - a.breakdown.fitness);
        const best = scored[0];
        if (best.breakdown.fitness > champion.breakdown.fitness)
            champion = best;
        history.push(champion.breakdown.fitness);
        // ── Selection: keep elites, breed the next population. ──
        const elites = scored.slice(0, eliteCount).map((s) => s.genome);
        const next = [...elites];
        let idx = 0;
        while (next.length < cfg.population) {
            const parent = elites[idx % elites.length];
            let child;
            // Immigration: periodically inject a fresh mutation from the base genome to
            // escape premature convergence (deterministic, RNG-driven). Without this a
            // short run can get stuck in a low-reviewer local optimum.
            if (next.length === cfg.population - 1 && cfg.population > eliteCount + 1) {
                child = mutate(base, rng, cycle + 1, next.length);
                lineageParent.set(child.id, base.id);
            }
            else if (useCrossover && elites.length >= 2 && rng() < 0.3) {
                const mate = elites[(idx + 1) % elites.length];
                child = crossover(parent, mate, rng, cycle + 1, next.length);
                lineageParent.set(child.id, parent.id);
            }
            else {
                child = mutate(parent, rng, cycle + 1, next.length);
                lineageParent.set(child.id, parent.id);
            }
            next.push(child);
            idx += 1;
        }
        population = next;
    }
    // Reconstruct the champion's lineage from the parent map.
    const lineage = [];
    let cur = champion.genome.id;
    const guard = new Set();
    while (cur && !guard.has(cur)) {
        lineage.unshift(cur);
        guard.add(cur);
        cur = lineageParent.get(cur);
    }
    if (lineage[0] !== base.id)
        lineage.unshift(base.id);
    return {
        champion,
        baseline,
        history,
        lineage,
        cyclesRun: cfg.cycles,
        evaluations,
    };
}
//# sourceMappingURL=evolve.js.map