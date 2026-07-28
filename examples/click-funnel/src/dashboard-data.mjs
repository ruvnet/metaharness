// Reconstruct the full per-generation timeline for the dashboard.
//
// The proposer and simulator are deterministic, so we can replay exactly what
// each generation proposed (including the value of every REJECTED candidate,
// which the lineage doesn't record) and re-derive each generation's promoted
// policy, funnel stages, and KPIs. Emits results/timeline.json.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVERS, ROOT_POLICY, HOLDOUT_COHORT, ANCHOR_COHORT, simulate } from './funnel.mjs';
import { makeProposer } from './proposer.mjs';

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');
const summary = JSON.parse(await readFile(join(resultsDir, 'summary.json'), 'utf8'));
const proposer = makeProposer();

const kpis = (sim) => ({
  cvr: sim.cvr, cac: sim.cac, bounce: sim.bounceRate, roas: sim.roas,
  rpv: sim.revenuePerVisitor, revenue: sim.revenue,
  stages: { visitors: sim.visitors, engaged: sim.engaged, optins: sim.optins, net: sim.netPurchases },
});

let policy = { ...ROOT_POLICY };
const generations = [{
  gen: 0, promoted: null, policy: { ...policy },
  holdout: kpis(simulate(policy, HOLDOUT_COHORT)),
  anchor: { cvr: simulate(policy, ANCHOR_COHORT).cvr },
  candidates: [],
}];

for (let gen = 1; gen <= summary.generationsRun; gen++) {
  const base = { id: `gen${gen - 1}`, generation: gen, parents: [], policy };
  const candidates = [];
  for (const target of Object.keys(LEVERS)) {
    const value = await proposer(base, target);
    const commit = summary.allCandidates.find((c) => c.generation === gen && c.target === target);
    candidates.push({
      target, from: policy[target], to: value,
      verdict: commit.verdict, reasons: commit.failureReasons,
      cvr: commit.candidateScore.primary, cac: commit.candidateScore.costPerWin,
      regressed: commit.candidateScore.regressed,
    });
  }
  const promo = summary.promotions.find((p) => p.generation === gen);
  const promoted = promo ? candidates.find((c) => c.target === promo.mutation.target) : null;
  if (promoted) policy = { ...policy, [promoted.target]: promoted.to };
  generations.push({
    gen, promoted: promoted ? { target: promoted.target, from: promoted.from, to: promoted.to } : null,
    policy: { ...policy },
    holdout: kpis(simulate(policy, HOLDOUT_COHORT)),
    anchor: { cvr: simulate(policy, ANCHOR_COHORT).cvr },
    candidates,
  });
}

// Sanity: the replayed final policy must match the recorded run exactly.
const mismatch = Object.keys(ROOT_POLICY).filter((k) => policy[k] !== summary.finalPolicy[k]);
if (mismatch.length) throw new Error('replay diverged on: ' + mismatch.join(', '));

const timeline = {
  levers: LEVERS,
  gateFingerprint: summary.gateFingerprint,
  replayVerdict: summary.replayVerdict,
  sampleReceipt: summary.sampleReceipt,
  milestoneReached: summary.milestoneReached,
  generations,
};
await writeFile(join(resultsDir, 'timeline.json'), JSON.stringify(timeline, null, 1));
console.log(`timeline.json: ${generations.length} generations, final CVR ${(100 * generations.at(-1).holdout.cvr).toFixed(2)}%`);
