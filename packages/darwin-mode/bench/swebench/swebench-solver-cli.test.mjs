// D1-S3 dry-run ($0, node:test): validates the REAL runSolver CLI plumbing end-to-end against a stub
// solve script — manifest write → SWE_POLICY_SYSTEM policy-injection → predictions parse → cost — and
// that it plugs into the flywheel SWE-bench Evaluator. The stub proves the pipeline WITHOUT cloning
// repos or calling a model; D1-S4 swaps the stub for the real solve.mjs + a cheap model + the official
// Docker scorer. NOTHING here is a real SWE-bench result (SYNTHETIC).
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeCliSolver, defaultPolicyToSystem } from './swebench-solver-cli.mjs';
import { makeSwebenchEvaluator, isEmptyPatch } from './flywheel-swebench-evaluator.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const stub = join(HERE, '_stub-solve.mjs');
const instances = [1, 2, 3, 4].map((d, i) => ({ instance_id: `stub-${i}`, difficulty: d }));
const gradePredictions = async (preds) => ({ resolvedIds: preds.filter((p) => !isEmptyPatch(p)).map((p) => p.instance_id) });

test('defaultPolicyToSystem joins non-empty lever texts', () => {
  assert.strictEqual(defaultPolicyToSystem({ a: 'x', b: '', c: 'y' }), 'x\ny');
});

test('CLI runSolver: manifest write → policy env → predictions parse → cost, over a stub solve', async () => {
  const runSolver = makeCliSolver({ solveScript: stub, model: 'stub-model', apiKeyEnv: 'NONE' });
  // low-quality policy (1 '#') resolves only difficulty-1; high-quality (3 '#') resolves 1-3.
  const low = await runSolver({ editPolicy: '#' }, instances);
  const high = await runSolver({ editPolicy: '###' }, instances);
  assert.strictEqual(low.length, 4);
  assert.deepStrictEqual(low.map((p) => p.instance_id), ['stub-0', 'stub-1', 'stub-2', 'stub-3']);
  assert.strictEqual(low.filter((p) => !isEmptyPatch(p)).length, 1); // only difficulty-1
  assert.strictEqual(high.filter((p) => !isEmptyPatch(p)).length, 3); // difficulty 1,2,3
  assert.ok(low.every((p) => typeof p.costUsd === 'number' && p.costUsd > 0), 'cost parsed from report');
});

test('the CLI solver plugs into makeSwebenchEvaluator → a Score reflecting the policy', async () => {
  const runSolver = makeCliSolver({ solveScript: stub, apiKeyEnv: 'NONE' });
  const evaluate = makeSwebenchEvaluator({ runSolver, gradePredictions });
  const s0 = await evaluate({ editPolicy: '' }, { id: 'h', items: instances });   // quality 0 → nothing
  const s3 = await evaluate({ editPolicy: '###' }, { id: 'h', items: instances }); // quality 3 → 3 resolve
  assert.strictEqual(s0.primary, 0);
  assert.strictEqual(s0.noopRate, 1);
  assert.strictEqual(s3.primary, 3);
  assert.strictEqual(s3.noopRate, 0.25);
  assert.ok(s3.costPerWin < s0.costPerWin);
});
