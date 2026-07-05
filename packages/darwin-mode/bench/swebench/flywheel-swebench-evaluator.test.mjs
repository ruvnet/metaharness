// D1-S1 validation ($0, mock solver + scorer): proves the SWE-bench Evaluator adapter plugs into
// @metaharness/flywheel and drives runFlywheelGenerations end-to-end — the same compounding loop we
// proved on the reasoning proxy, now shaped like code-repair. The REAL solver (solve.mjs) + REAL scorer
// (official swebench Docker harness) inject in D1-S4; this test never claims a real SWE-bench result
// (dataSource:'SYNTHETIC').
import { test } from 'node:test';
import assert from 'node:assert';
import { runFlywheelGenerations, makeSigner, verifyReplayBundle, meetsPromotionRule, gateFingerprint } from '@metaharness/flywheel';
import { makeSwebenchEvaluator, makeSwebenchProposer, isEmptyPatch } from './flywheel-swebench-evaluator.mjs';

// SWE-bench-shaped instances: a graduated "difficulty" (how much policy quality it takes to resolve).
const suite = (id, diffs) => ({ id, items: diffs.map((d, i) => ({ instance_id: `${id}-${i}`, difficulty: d })) });
const quality = (policy) => Object.values(policy).join('').split('#').length - 1;

// MOCK solver: under policy quality Q, an instance with difficulty ≤ Q gets a committed search/replace
// patch; a harder one gets an EMPTY patch (the model gives up — the cand-6 no-op signal). Better policy
// ⇒ more commits (fewer no-ops) AND more resolvable.
const runSolver = async (policy, instances) => {
  const Q = quality(policy);
  return instances.map((it) =>
    Q >= it.difficulty
      ? { instance_id: it.instance_id, model_patch: `--- a\n+++ b\n@@ fix ${it.instance_id}`, costUsd: 0.01 }
      : { instance_id: it.instance_id, model_patch: '', costUsd: 0.004 },
  );
};
// MOCK grader (stands in for the official swebench Docker harness): a committed (non-empty) patch on a
// solvable instance resolves. Real harness runs the tests; this mock just marks committed patches resolved.
const gradePredictions = async (preds) => ({ resolvedIds: preds.filter((p) => !isEmptyPatch(p)).map((p) => p.instance_id) });
// MOCK proposer completion: append one quality token to the current lever text.
const complete = async (_model, prompt) => {
  const m = String(prompt).match(/Current "[^"]*":\n([\s\S]*?)\n\nReturn/);
  return `${m?.[1] ?? ''}#`.trim();
};

test('SWE-bench Evaluator adapter drives @metaharness/flywheel to a compounding lift curve', async () => {
  const evaluator = makeSwebenchEvaluator({ runSolver, gradePredictions });
  const proposer = makeSwebenchProposer({ complete, proposerModel: 'mock-frontier' });

  const result = await runFlywheelGenerations({
    rootPolicy: { editPolicy: '', escalationPolicy: '', verifierPolicy: '' },
    proposer,
    evaluator,
    promotionRule: meetsPromotionRule,
    holdout: suite('holdout', [1, 2, 3, 4, 5, 6]),
    anchor: suite('anchor', [1, 2, 3]),
    maxGenerations: 8,
    signer: makeSigner(),
    dataSource: 'SYNTHETIC', // mock solver/scorer — NOT a real SWE-bench result
  });

  // The wheel compounded: ≥2 anchor-surviving improvements → a real lift curve, on code-repair-shaped data.
  assert.strictEqual(result.milestoneReached, true, 'expected ≥2 anchor-surviving compounding promotions');
  const primaries = result.liftCurve.map((p) => p.primary);
  assert.ok(primaries[primaries.length - 1] > primaries[0], 'resolved count must climb along the chain');
  for (let i = 1; i < primaries.length; i++) assert.ok(primaries[i] >= primaries[i - 1], 'monotone non-decreasing');

  // The bundle replays externally, gate provably unchanged.
  const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule) });
  assert.strictEqual(v.pass, true, `replay must pass: ${v.failures.join(',')}`);
  assert.deepStrictEqual(result.replayBundle.chain.at(-1).parents, [], 'chain reaches the gen-0 root');
});

test('Score projection: resolved→primary, empty-patch→noopRate, cost→costPerWin', async () => {
  const evaluator = makeSwebenchEvaluator({ runSolver, gradePredictions });
  // quality 0 (root policy): only difficulty-≤0 resolve ⇒ nothing; all 4 give up (empty).
  const s0 = await evaluator({ editPolicy: '' }, suite('h', [1, 2, 3, 4]));
  assert.strictEqual(s0.primary, 0);
  assert.strictEqual(s0.noopRate, 1); // all empty
  // quality 3: difficulties 1,2,3 resolve; 4 gives up.
  const s3 = await evaluator({ editPolicy: '###' }, suite('h', [1, 2, 3, 4]));
  assert.strictEqual(s3.primary, 3);
  assert.strictEqual(s3.noopRate, 0.25); // 1 of 4 empty
  assert.ok(s3.costPerWin < s0.costPerWin, 'cost per resolved improves as more resolve');
});
