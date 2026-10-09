// Confirmation on FRESH seeds before anything reaches the submission gate.
//
// Darwin selects its winner as the max over every candidate's search scorecard, so that scorecard is biased upward
// by selection (in a null world where no knob matters, the search winner "beats" the baseline ~90-100% of the time).
// The gate therefore never sees search scorecards: run-darwin re-measures the baseline AND the winner at a disjoint
// --confirm-seed-base with --confirm-attempts (fresh instances, fresh sampling), and builds PAIRED evidence from it:
//   item  = (changed cell, 4-seed block) -- the block is one arena-sized group of 4 on common instance seeds
//   win   = that block, as a group, carries a purely reasoning-driven gradient (all 4 eligible, rewards not all equal)
// Only cells that differ between baseline and winner are paired; identical cells are the same measurement.
import { ELIGIBLE } from './fitness.mjs';

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/** A 4-episode block wins iff all four are eligible (solved/partial/reasoning) and their rewards are not all equal. */
export function blockWins(episodes) {
  return episodes.length === 4 && episodes.every((e) => ELIGIBLE.includes(e.cls)) && new Set(episodes.map((e) => e.reward)).size > 1;
}

function blocksOf(cell, seedBase, attempts) {
  const eps = Array.isArray(cell?.episodes) ? cell.episodes : [];
  return Array.from({ length: attempts / 4 }, (_, k) => {
    const lo = seedBase + 4 * k;
    return { seed: lo, episodes: eps.filter((e) => e.seed >= lo && e.seed < lo + 4) };
  });
}

/**
 * PairedOutcome[] for the cells that differ between two scorecards measured under the SAME provenance (seed base,
 * attempts, server, ...). Throws when the cards cannot be paired honestly.
 */
export function pairedOutcomes(baseline, candidate) {
  const pb = baseline?.raw?.provenance; const pc = candidate?.raw?.provenance;
  if (!pb || !pc) throw new Error('pairing_needs_provenance');
  for (const k of ['seedBase', 'attempts', 'serverSha', 'envSourceSha', 'runnerSha', 'runnerArgsSha', 'model', 'modelRevision', 'contextTokens']) {
    if (pb[k] !== pc[k]) throw new Error(`pairing_provenance_mismatch:${k}`);
  }
  if (!isCount(pb.seedBase) || !isCount(pb.attempts) || pb.attempts % 4 !== 0) throw new Error('pairing_bad_seed_plan');
  const byFamily = (card) => new Map((card.raw.cells ?? []).map((c) => [c.family, c]));
  const B = byFamily(baseline); const C = byFamily(candidate);
  if (B.size === 0 || [...B.keys()].sort().join() !== [...C.keys()].sort().join()) throw new Error('pairing_cell_sets_differ');
  const pairs = [];
  for (const [family, cc] of C) {
    const bc = B.get(family);
    if (cc.key === bc.key) continue;
    const bb = blocksOf(bc, pb.seedBase, pb.attempts); const cb = blocksOf(cc, pb.seedBase, pb.attempts);
    for (let k = 0; k < cb.length; k++) {
      if (bb[k].episodes.length !== 4 || cb[k].episodes.length !== 4) throw new Error(`pairing_incomplete_block:${family}@${cb[k].seed}`);
      pairs.push({ itemId: `${family}:d${bc.difficulty}b${bc.budget}->d${cc.difficulty}b${cc.budget}@seed${cb[k].seed}`,
        candidateWon: blockWins(cb[k].episodes), baselineWon: blockWins(bb[k].episodes) });
    }
  }
  return pairs;
}

/**
 * Can the sequential test reach 1/alpha at all? Max e-value = (1+lambda)^(informative pairs), and there are at most
 * changedCells x attempts/4 pairs. Returns the ceiling and the attempts per changed cell needed to make it reachable.
 */
export function confirmationPower({ changedCells, attempts, alpha = 0.05, lambda = 0.5, candidateBudget = 1 }) {
  const threshold = candidateBudget / alpha;
  const blocksNeeded = Math.ceil(Math.log(threshold) / Math.log(1 + lambda) - 1e-12);
  const maxPairs = changedCells * (attempts / 4);
  const attemptsNeeded = changedCells > 0 ? 4 * Math.ceil(blocksNeeded / changedCells) : Infinity;
  return { threshold, maxPairs, maxEValue: (1 + lambda) ** maxPairs, blocksNeeded, reachable: maxPairs >= blocksNeeded,
    attemptsPerChangedCellNeeded: attemptsNeeded };
}

/** Changed cells between two genomes (by family), given the cells module's genomeToCells. */
export function changedFamilies(genomeToCells, a, b) {
  const key = (c) => JSON.stringify([c.difficulty, c.budget, c.knobs ?? {}]);
  const A = new Map(genomeToCells(a).map((c) => [c.family, key(c)]));
  return genomeToCells(b).filter((c) => A.get(c.family) !== key(c)).map((c) => c.family);
}

/**
 * Re-measure baseline and winner on fresh seeds through the run budget. `makeRun(seedBase, attempts)` returns the
 * (genome, variantId, allowance) => card function for that seed plan. Never throws; failures are reported.
 */
export async function confirmWinner({ budget, makeRun, genomeToCells, baselineGenome, winnerGenome, seedBase, attempts }) {
  const opts = { unitsPerCell: attempts / 4, namespace: `confirm:${seedBase}:${attempts}`, run: makeRun(seedBase, attempts) };
  const baseline = await budget.evaluate(baselineGenome, 'confirm-baseline', opts);
  const winner = await budget.evaluate(winnerGenome, 'confirm-winner', opts);
  const out = { seedBase, attempts, changedFamilies: changedFamilies(genomeToCells, baselineGenome, winnerGenome), baseline, winner };
  if (baseline.regressed || winner.regressed) return { ...out, status: 'failed', reason: baseline.evaluatorError ?? winner.evaluatorError ?? 'regressed' };
  try {
    const pairs = pairedOutcomes(baseline, winner);
    return { ...out, status: 'measured', pairs, primaryDelta: winner.primary - baseline.primary };
  } catch (error) {
    return { ...out, status: 'failed', reason: error.message };
  }
}
