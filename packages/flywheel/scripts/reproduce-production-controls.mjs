// $0, offline regression witness. No provider, network, deployment, or promotion outside fixtures.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import * as current from '../dist/index.js';
const base = 'e0dfd44da72b7adfb7c57fdd42d124be58ed7086';
const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'production-repro-'));
try {
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}');
  for (const name of ['gate', 'sequential', 'run', 'receipts', 'lineage', 'replay']) {
    const source = execFileSync('git', ['show', `${base}:packages/flywheel/src/${name}.ts`], { cwd: root, encoding: 'utf8' });
    writeFileSync(join(temp, `${name}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  const old = Object.assign({}, ...await Promise.all(['gate', 'sequential', 'run', 'receipts', 'replay'].map((name) => import(pathToFileURL(join(temp, `${name}.js`)).href))));
  const evidence = { baseline: { primary: 0, noopRate: 0, costPerWin: 1, regressed: false }, candidate: { primary: 1, noopRate: 0, costPerWin: 1, regressed: false } };
  const paired = { ...evidence, pairedOutcomes: [{ itemId: '0', candidateWon: true, baselineWon: false }] };
  const oldStrict = old.withSequentialEvidence(old.meetsPromotionRule, { alpha: .05, lambda: .5 });
  const oldLoose = old.withSequentialEvidence(old.meetsPromotionRule, { alpha: .9, lambda: .5 });
  let oldCalls = 0;
  const oldRun = await old.runFlywheelGenerations({ rootPolicy: { a: '0', b: '0', c: '0', d: '0', e: '0' },
    proposer: async () => '1', evaluator: async (p) => { oldCalls++; return { primary: Object.values(p).reduce((n, v) => n + Number(v), 0), noopRate: 0, costPerWin: 1, regressed: false }; },
    promotionRule: oldStrict, holdout: { id: 's', items: ['heldout-1'] }, maxGenerations: 3, signer: old.makeSigner(), budget: { total: 2, spent: () => oldCalls } });
  assert.equal(oldCalls, 6); assert.equal(oldStrict(evidence).promote, true);
  assert.equal(old.gateFingerprint(oldStrict), old.gateFingerprint(oldLoose));
  assert.equal(oldStrict(paired).promote, false); assert.equal(oldLoose(paired).promote, true);
  const config = { familyId: 'fixed-repro-family', maxComparisons: 1, evaluator: { id: 'local-fixture', model: 'none', artifactDigest: 'a'.repeat(64) },
    dependenciesDigest: 'a'.repeat(64), selectionItemIds: ['selection-1'], suites: [{ id: 'approval', seed: 'fixed-seed',
      itemIds: Array.from({ length: 12 }, (_, i) => `approval-${i}`), items: Array.from({ length: 12 }, (_, i) => ({ id: `approval-${i}` })) }] };
  let calls = 0, proposals = 0;
  const evaluator = async (p) => { calls++; return { primary: Object.values(p).reduce((n, v) => n + Number(v), 0), noopRate: 0, costPerWin: 1, regressed: false }; };
  const manifest = current.createProductionManifest(config, { baseRule: current.meetsPromotionRule, evaluator,
    holdout: { id: 'selection', items: ['selection-1'] }, rootPolicy: { a: '0' }, budget: { ledgerId: 'repro', total: 2, evaluatorUnits: 1, proposerUnits: 1 } });
  const strict = current.createProductionPromotionRule(manifest);
  assert.equal(strict(evidence).promote, false); assert.equal(strict(evidence).status, 'INCONCLUSIVE');
  const newStrict = current.withSequentialEvidence(current.meetsPromotionRule, { alpha: .05 });
  const newLoose = current.withSequentialEvidence(current.meetsPromotionRule, { alpha: .9 });
  assert.notEqual(current.gateFingerprint(newStrict), current.gateFingerprint(newLoose));
  const limiter = new current.FileBudgetLimiter({ path: join(temp, 'budget.jsonl'), total: 2, ledgerId: 'repro' });
  const result = await current.runFlywheelGenerations({ promotionMode: 'production', production: config,
    hardBudget: { limiter, evaluatorUnits: 1, proposerUnits: 1 }, rootPolicy: { a: '0' },
    proposer: async () => { proposals++; return '1'; }, evaluator, holdout: { id: 'selection', items: ['selection-1'] },
    maxGenerations: 1, signer: current.makeSigner(), dataSource: 'LIVE' });
  assert.ok(calls <= 2); assert.equal(calls + proposals, 2); assert.equal(result.promotions.length, 0);
  const wins = Array.from({ length: 1810 }, (_, i) => ({ itemId: `w${i}`, candidateWon: true, baselineWon: false }));
  const losses = Array.from({ length: 1800 }, (_, i) => ({ itemId: `l${i}`, candidateWon: false, baselineWon: true }));
  const overflowing = [...wins, ...losses];
  assert.equal(old.sequentialEvidence(overflowing).significant, true);
  assert.equal(current.sequentialEvidence(overflowing).significant, false);
  console.log(JSON.stringify({ base, synthetic: true, paidInferenceCalls: 0,
    before: { missingEvidencePromotes: oldStrict(evidence).promote, equalFingerprintsDifferentDecisions: true, softEvaluatorBudget: 2, evaluatorCalls: oldCalls, promotions: oldRun.promotions.length, overflowingNearNullPromotes: true },
    after: { missingEvidence: strict(evidence), alphaFingerprintsDistinct: true, hardUnits: 2, evaluatorCalls: calls, proposerCalls: proposals, reserved: (await limiter.snapshot()).reserved, promotions: result.promotions.length, overflowingNearNullPromotes: false },
  }, null, 2));
} finally { rmSync(temp, { recursive: true, force: true }); }
