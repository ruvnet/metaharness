// signal-flywheel — the runner. Evolves the synthetic harness policy through
// runFlywheelGenerations with the DEFAULT frozen gate (meetsPromotionRule — we
// deliberately do NOT supply a custom promotionRule), an anchor suite, and an
// Evaluator that routes EVERY score through darwin-mode scoreVariant's ADR-249
// signal seams (turn-credit trace quality + deterministic cost-units).
//
// Usage:
//   node run.mjs            # run the flywheel, write bundle.json, print measurements
//   node run.mjs --check    # re-run fresh and assert the result is byte-identical to
//                           # the committed bundle.json modulo receipt signature/publicKey
//                           # (makeSigner mints a fresh per-process Ed25519 key)
//
// Determinism: no Date.now()/Math.random() anywhere. The `now` labels handed to
// the engine are generation strings; the ONLY fields that differ between runs
// are each receipt's `signature` and `publicKey` (library per-process keypair).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runFlywheelGenerations,
  makeSigner,
  verifyReplayBundle,
  meetsPromotionRule,
  gateFingerprint,
} from '../../packages/flywheel/dist/index.js';
import {
  DOMAINS,
  ROOT_POLICY,
  HOLDOUT,
  ANCHOR,
  evaluatePolicyOnSuite,
} from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, 'bundle.json');

const MAX_GENERATIONS = 8; // >= 6 per the experiment design

// ---------------------------------------------------------------------------
// Deterministic seeded proposer — cycles each lever's frozen domain, never
// re-proposing the base value (the ADR-243 radio-flywheel pattern). No LLM,
// no network: the thing under test is the SIGNAL PLUMBING + gate discipline.
function makeProposer() {
  const cursors = Object.fromEntries(Object.keys(DOMAINS).map((k) => [k, 0]));
  return async function proposer(base, target) {
    const domain = DOMAINS[target];
    for (let i = 0; i < domain.length; i++) {
      const candidate = domain[(cursors[target] + i) % domain.length];
      if (candidate !== base.policy[target]) {
        cursors[target] = (cursors[target] + i + 1) % domain.length;
        return candidate;
      }
    }
    return base.policy[target];
  };
}

// Evaluator seam: project the seam-fed ScoreCard onto the flywheel Score axes.
async function evaluator(policy, suite) {
  return evaluatePolicyOnSuite(policy, suite).score;
}

// ---------------------------------------------------------------------------
async function runOnce() {
  return runFlywheelGenerations({
    rootPolicy: { ...ROOT_POLICY },
    proposer: makeProposer(),
    evaluator,
    // NO promotionRule: the DEFAULT frozen meetsPromotionRule decides — including
    // its strict "noopRate must improve" clause, whatever that does to us.
    holdout: HOLDOUT,
    anchor: ANCHOR,
    maxGenerations: MAX_GENERATIONS,
    signer: makeSigner(),
    dataSource: 'SYNTHETIC', // mechanism proof, never a benchmark claim
    cacheEvaluations: true, // the simulator is pure in (policy, suite) — caching is exact
    now: (g) => `SYNTHETIC#gen${g}`, // no clock anywhere in the artifact path
  });
}

/** Strip the two per-process fields (Ed25519 signature + publicKey) so bundles
 *  from different processes can be compared byte-for-byte on everything else. */
function stripReceipts(bundle) {
  const strip = (c) => ({ ...c, receipt: { ...c.receipt, signature: 'STRIPPED', publicKey: 'STRIPPED' } });
  return { ...bundle, chain: bundle.chain.map(strip), all_commits: bundle.all_commits.map(strip) };
}

const round6 = (x) => +(Math.round(x * 1e6) / 1e6).toFixed(6);

function report(result, verdict) {
  const b = result.replayBundle;
  const rootPrimary = b.lift_curve[0].primary;
  const finalPrimary = b.lift_curve[b.lift_curve.length - 1].primary;
  console.log('--- signal-flywheel: ADR-249 seams under the frozen default gate (SYNTHETIC) ---');
  console.log('data_source            :', b.data_source);
  console.log('generations run        :', result.generationsRun, `(max ${MAX_GENERATIONS})`);
  console.log('candidates evaluated   :', b.all_commits.length);
  console.log('promotions             :', b.verified_improvements);
  console.log('anchor-surviving       :', b.anchor_surviving_improvements);
  console.log('milestone (>=2)        :', b.milestone_reached);
  console.log('lift curve (holdout primary = seam-fed darwin finalScore):');
  for (const p of b.lift_curve) {
    console.log(
      `  gen ${p.generation}: primary ${round6(p.primary)} (delta ${p.delta >= 0 ? '+' : ''}${round6(p.delta)})` +
        (p.anchor != null ? ` anchor ${round6(p.anchor)}` : ''),
    );
  }
  console.log('root -> final primary  :', round6(rootPrimary), '->', round6(finalPrimary), `(x${round6(finalPrimary / rootPrimary)})`);
  console.log('final policy           :', JSON.stringify(result.finalPolicy));
  const rejections = b.all_commits.filter((c) => c.verdict === 'REJECTED');
  const reasonCounts = {};
  for (const c of rejections) for (const r of c.failureReasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  console.log('rejections by reason   :', JSON.stringify(reasonCounts));
  console.log('gate fingerprint       :', b.gate_fingerprint);
  console.log('gate is library default:', b.gate_fingerprint === gateFingerprint(meetsPromotionRule));
  console.log('replay verified        :', verdict.pass, verdict.pass ? '' : JSON.stringify(verdict.failures));
  console.log('chain                  :', verdict.chainSummary);
}

const check = process.argv.includes('--check');
const result = await runOnce();
const verdict = verifyReplayBundle(result.replayBundle, {
  promotionRule: meetsPromotionRule,
  pinnedGateFingerprint: gateFingerprint(meetsPromotionRule),
});

if (check) {
  // Determinism proof: the fresh run must equal the COMMITTED bundle byte-for-byte
  // after stripping the per-process Ed25519 signature/publicKey fields.
  const committed = JSON.parse(await readFile(bundlePath, 'utf8'));
  const a = JSON.stringify(stripReceipts(committed), null, 2);
  const c = JSON.stringify(stripReceipts(result.replayBundle), null, 2);
  if (a !== c) {
    console.error('CHECK FAIL: fresh run differs from committed bundle.json beyond receipt key fields');
    process.exit(1);
  }
  console.log('CHECK PASS: fresh run is byte-identical to committed bundle.json modulo receipt signature/publicKey');
  report(result, verdict);
} else {
  await writeFile(bundlePath, JSON.stringify(result.replayBundle, null, 2) + '\n');
  report(result, verdict);
  console.log('wrote                  :', bundlePath);
}
if (!verdict.pass) process.exit(1);
