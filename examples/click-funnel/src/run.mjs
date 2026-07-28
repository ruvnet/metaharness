// FunnelWheel — evolve a click funnel's operating policy with the MetaHarness stack.
//
//   @metaharness/darwin    → mutation strategy (one lever at a time, Pareto selection)
//   @metaharness/flywheel  → the promotion loop: run → measure → mutate → verify → promote,
//                            Ed25519 receipts, lineage DAG, lift curve, independent replay
//   metaharness            → the CLI/Studio that mints the surrounding harness (dev tooling)
//
// The model of "traffic" is frozen (a seeded simulator, stamped SYNTHETIC); the
// funnel POLICY evolves. Only candidates that clear the frozen conjunctive gate
// — on the holdout AND the never-optimized-against mobile-heavy anchor — join
// the signed promotion lineage.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlywheelGenerations, makeSigner, gateFingerprint, verifyReplayBundle } from '@metaharness/flywheel';
import { ROOT_POLICY, HOLDOUT_COHORT, ANCHOR_COHORT, simulate, toScore, stageRates } from './funnel.mjs';
import { makeProposer } from './proposer.mjs';
import { funnelPromotionRule } from './gate.mjs';

const MAX_GENERATIONS = 12;
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'results');

const evaluator = async (policy, suite) => toScore(simulate(policy, suite));

const pinnedGate = gateFingerprint(funnelPromotionRule);
console.log(`FunnelWheel — evolving the funnel policy for ${MAX_GENERATIONS} generations`);
console.log(`  gate fingerprint (pinned): ${pinnedGate.slice(0, 16)}…`);

const result = await runFlywheelGenerations({
  rootPolicy: ROOT_POLICY,
  proposer: makeProposer(),
  evaluator,
  promotionRule: funnelPromotionRule,
  holdout: HOLDOUT_COHORT,
  anchor: ANCHOR_COHORT,
  maxGenerations: MAX_GENERATIONS,
  signer: makeSigner(),
  now: (gen) => `2026-07-28T00:00:00.000Z#gen${gen}`,
  dataSource: 'SYNTHETIC',
});

// ── Independent replay: verify receipts, lineage, and RE-RUN the pinned gate. ──
const verdict = verifyReplayBundle(result.replayBundle, {
  pinnedGateFingerprint: pinnedGate,
  promotionRule: funnelPromotionRule,
});

// ── Business-facing before/after on the SAME holdout cohort. ──
const rootSim = simulate(ROOT_POLICY, HOLDOUT_COHORT);
const finalSim = simulate(result.finalPolicy, HOLDOUT_COHORT);
const rootAnchorSim = simulate(ROOT_POLICY, ANCHOR_COHORT);
const finalAnchorSim = simulate(result.finalPolicy, ANCHOR_COHORT);

const funnelBreakdown = (sim) => ({
  visitors: sim.visitors, engaged: sim.engaged, optins: sim.optins,
  purchases: sim.purchases, upsells: sim.upsells, refunds: sim.refunds, netPurchases: sim.netPurchases,
  cvr: sim.cvr, bounceRate: sim.bounceRate, cac: sim.cac,
  revenue: sim.revenue, revenuePerVisitor: sim.revenuePerVisitor, roas: sim.roas, refundRate: sim.refundRate,
});

const summary = {
  generatedAt: new Date().toISOString(),
  dataSource: 'SYNTHETIC',
  stack: {
    'metaharness': 'harness factory (CLI/Studio) — dev tooling',
    '@metaharness/darwin': 'mutation strategy + Pareto selection (paretoFront)',
    '@metaharness/flywheel': 'promotion loop, Ed25519 receipts, lineage, replay',
  },
  gateFingerprint: pinnedGate,
  generationsRun: result.generationsRun,
  milestoneReached: result.milestoneReached,
  rootPolicy: ROOT_POLICY,
  finalPolicy: result.finalPolicy,
  liftCurve: result.liftCurve,
  holdout: { root: funnelBreakdown(rootSim), final: funnelBreakdown(finalSim) },
  anchor: { root: funnelBreakdown(rootAnchorSim), final: funnelBreakdown(finalAnchorSim) },
  promotions: result.promotions.map((c) => ({
    id: c.id, generation: c.generation, verdict: c.verdict,
    mutation: c.mutation, primaryDelta: c.primaryDelta, anchorScore: c.anchorScore,
  })),
  allCandidates: result.replayBundle.all_commits.map((c) => ({
    id: c.id, generation: c.generation, target: c.mutation?.target ?? null,
    verdict: c.verdict, failureReasons: c.failureReasons, primaryDelta: c.primaryDelta,
    candidateScore: c.candidateScore ?? null, baselineScore: c.baselineScore ?? null,
  })),
  replayVerdict: verdict,
  sampleReceipt: result.promotions.find((c) => c.verdict === 'PROMOTED')?.receipt ?? null,
};

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'replay-bundle.json'), JSON.stringify(result.replayBundle, null, 2));
await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

// ── Console report. ──
const pct = (x) => `${(100 * x).toFixed(2)}%`;
const usd = (x) => `$${x.toFixed(2)}`;
console.log(`\n=== RESULT (holdout, n=${rootSim.visitors}) ===`);
console.log(`  CVR      ${pct(rootSim.cvr)} → ${pct(finalSim.cvr)}   (${(finalSim.cvr / rootSim.cvr).toFixed(2)}×)`);
console.log(`  CAC      ${usd(rootSim.cac)} → ${usd(finalSim.cac)}`);
console.log(`  Bounce   ${pct(rootSim.bounceRate)} → ${pct(finalSim.bounceRate)}`);
console.log(`  Rev/visit ${usd(rootSim.revenuePerVisitor)} → ${usd(finalSim.revenuePerVisitor)}   ROAS ${rootSim.roas.toFixed(2)} → ${finalSim.roas.toFixed(2)}`);
console.log(`  Anchor CVR (frozen, mobile-heavy)  ${pct(rootAnchorSim.cvr)} → ${pct(finalAnchorSim.cvr)}`);
console.log(`\n  promotions: ${result.promotions.filter((c) => c.verdict === 'PROMOTED').length}  |  candidates tried: ${summary.allCandidates.length}  |  milestone (≥2 anchor-surviving): ${result.milestoneReached}`);
console.log(`  final policy: ${JSON.stringify(result.finalPolicy)}`);
console.log(`\n=== INDEPENDENT REPLAY ===`);
console.log(`  pass=${verdict.pass}  checks=${JSON.stringify(verdict.checks)}`);
console.log(`  chain: ${verdict.chainSummary}`);
console.log(`\nWrote results/summary.json and results/replay-bundle.json`);
