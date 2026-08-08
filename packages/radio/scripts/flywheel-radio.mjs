// Flywheel evolution of the radio comms policy — run → measure → mutate → verify → promote.
//
// The policy being evolved is the pod's COMMUNICATION configuration over the
// AgentRadio sim (arXiv:2607.28430): {mode, foldEvery, postPolicy}. The model
// is frozen — there is no model; the sim's scripted agents never change. The
// root is the WORST reasonable comms policy (divide / fold-every-4 / silent:
// naive partition, sluggish boundary folds, discoveries held until Review), so
// a climbing wheel reproduces the paper's ablation DIRECTION — toward
// passive / immediate / fold-every-1 — as a measured, gate-checked, Ed25519-
// signed, externally replayable lineage rather than an assertion.
//
// Every promotion must clear a frozen conjunctive gate AND survive a
// never-optimized-against anchor topology (different seeds, different
// cross-partition structure). The sim is deterministic, so evaluation caching
// is safe — and exercising `cacheEvaluations` is part of the point.
//
// Usage: node scripts/flywheel-radio.mjs  (after `npm run build` — imports dist/)
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runFlywheelGenerations,
  makeSigner,
  verifyReplayBundle,
} from '../../flywheel/dist/index.js';
import { runSim, makeTask } from '../dist/sim.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '.radio-flywheel');

// ---------------------------------------------------------------------------
// Lever domains. mode=divide / foldEvery=4 / postPolicy=silent is the gen-0
// root — naive division of labor, discoveries silent until Review, and slow
// fold cadence: the paper's L1 arm with the passive layer effectively off.
const DOMAINS = {
  mode: ['divide', 'negotiate', 'passive'],
  foldEvery: ['1', '2', '4'],
  postPolicy: ['immediate', 'batched', 'silent'],
};
const ROOT_POLICY = { mode: 'divide', foldEvery: '4', postPolicy: 'silent' };

// Holdout: the task seeds the wheel optimizes against. Anchor: DIFFERENT seeds
// on a DIFFERENT topology (higher cross-partition fact fraction — the thing
// communication pays for) that is NEVER optimized against (anti-Goodhart) —
// a promoted comms policy must transfer, not overfit five seeds.
const HOLDOUT = {
  id: 'holdout-seeds-1-5',
  items: [1, 2, 3, 4, 5].map((seed) => ({ seed, opts: undefined })),
};
const ANCHOR = {
  id: 'anchor-seeds-101-105-crossheavy',
  items: [101, 102, 103, 104, 105].map((seed) => ({ seed, opts: { crossFraction: 0.7 } })),
};

// ---------------------------------------------------------------------------
// Deterministic proposer — walks each lever's domain, never re-proposing the
// base value. No model, no network: the search space is small and the WHEEL
// (measure + frozen gate + anchor + receipts) is the thing under test.
const cursors = Object.fromEntries(Object.keys(DOMAINS).map((k) => [k, 0]));
async function proposer(base, target) {
  const domain = DOMAINS[target];
  for (let i = 0; i < domain.length; i++) {
    const candidate = domain[(cursors[target] + i) % domain.length];
    if (candidate !== base.policy[target]) {
      cursors[target] = (cursors[target] + i + 1) % domain.length;
      return candidate;
    }
  }
  return base.policy[target];
}

// ---------------------------------------------------------------------------
// Evaluator — the ONLY place sim meaning lives. Runs the deterministic swarm
// sim once per suite seed and averages. primary = 1000 / mean foreground
// steps-to-resolve (higher = faster resolution), costPerWin = mean steps,
// regressed = ANY seed left unresolved (a comms policy that loses answers is
// a hard stop no speedup can buy back), noopRate = unresolved fraction.
async function evaluator(policy, suite) {
  let totalSteps = 0;
  let unresolved = 0;
  for (const item of suite.items) {
    const task = item.opts === undefined ? makeTask(item.seed) : makeTask(item.seed, item.opts);
    // sim.ts signature: runSim(cfg: SimConfig) — single config object, seed
    // required, foldEvery a string literal '1' | '2' | '4'.
    const r = runSim({
      seed: item.seed,
      task,
      mode: policy.mode,
      foldEvery: policy.foldEvery,
      postPolicy: policy.postPolicy,
    });
    const steps = r.stepsToResolve ?? r.steps;
    const resolved = r.resolved ?? r.solved ?? false;
    totalSteps += steps;
    if (!resolved) unresolved++;
  }
  const meanSteps = totalSteps / suite.items.length;
  return {
    primary: 1000 / meanSteps,
    noopRate: unresolved / suite.items.length,
    costPerWin: meanSteps,
    regressed: unresolved > 0,
  };
}

// ---------------------------------------------------------------------------
// The FROZEN gate. Conjunctive: ≥2% measured lift, cost (steps) must not
// worsen, an unresolved seed is a hard stop, and the anchor topology must not
// regress more than 2% (noise band — the sim is deterministic, but the band
// keeps the gate shape identical to the k3 kernel wheel). Fingerprinted into
// the replay bundle: loosening it invalidates the lineage.
function radioCommsPromotionRule(e) {
  const reasons = [];
  if (e.candidate.regressed) reasons.push('a holdout seed went unresolved under the candidate policy');
  if (!(e.candidate.primary >= e.baseline.primary * 1.02))
    reasons.push(`lift below 2% floor (${e.baseline.primary.toFixed(2)} -> ${e.candidate.primary.toFixed(2)} pts)`);
  if (!(e.candidate.costPerWin <= e.baseline.costPerWin * 1.0))
    reasons.push('mean steps-to-resolve worsened');
  if (e.anchor && !(e.anchor.candidate >= e.anchor.baseline * 0.98))
    reasons.push(`anchor topology regressed (${e.anchor.baseline.toFixed(2)} -> ${e.anchor.candidate.toFixed(2)} pts)`);
  return { promote: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
const startedAt = new Date().toISOString();
const result = await runFlywheelGenerations({
  rootPolicy: ROOT_POLICY,
  proposer,
  evaluator,
  promotionRule: radioCommsPromotionRule,
  holdout: HOLDOUT,
  anchor: ANCHOR,
  maxGenerations: 8,
  signer: makeSigner(),
  dataSource: 'LIVE',
  // The sim is fully deterministic (seeded LCG, logical clock), so a
  // (policy, suite) score never changes within a run — caching is exact.
  cacheEvaluations: true,
  now: (g) => `${startedAt}#gen${g}`,
});

const verdict = verifyReplayBundle(result.replayBundle);

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'replay-bundle.json'), JSON.stringify(result.replayBundle, null, 2) + '\n');
await writeFile(
  join(outDir, 'tuned-policy.json'),
  JSON.stringify(
    {
      schema: 'radio-comms-tuning-v1',
      root: ROOT_POLICY,
      tuned: result.finalPolicy,
      liftCurve: result.liftCurve,
      milestoneReached: result.milestoneReached,
      replayVerified: verdict.pass,
      startedAt,
    },
    null,
    2,
  ) + '\n',
);

console.log('--- flywheel: radio comms policy ---');
console.log('generations run :', result.generationsRun);
console.log('lift curve      :');
for (const p of result.liftCurve)
  console.log(`  gen ${p.generation}: ${p.primary.toFixed(2)} pts (Δ ${p.delta >= 0 ? '+' : ''}${p.delta.toFixed(2)})` + (p.anchor != null ? ` anchor ${p.anchor.toFixed(2)}` : ''));
console.log('promoted chain  :', result.promotions.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target}=${c.mutation.summary})` : '(root)'}`).join(' -> '));
console.log('final policy    :', JSON.stringify(result.finalPolicy));
console.log('milestone (≥2 anchor-surviving wins):', result.milestoneReached);
console.log('replay verified :', verdict.pass, verdict.pass ? '' : JSON.stringify(verdict));
if (!verdict.pass) process.exitCode = 1;
