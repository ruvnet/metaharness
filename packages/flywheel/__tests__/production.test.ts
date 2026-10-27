import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFlywheelGenerations, makeSigner, gateFingerprint, meetsPromotionRule, withSequentialEvidence,
  createProductionManifest, createProductionPromotionRule, evidenceDigest, FileBudgetLimiter,
  InMemoryBudgetLimiter, verifyReplayBundle,
  type FlywheelConfig, type ProductionGateConfig, type ProductionGateManifest, type PromotionEvidence,
  type Score, type Suite, type ResumeState,
} from '../src/index.js';

// All evaluators and provenance below are synthetic test fixtures. No network/provider calls.
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const H = 'a'.repeat(64);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fixture(total = 100, comparisons = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'production-gate-')); dirs.push(dir);
  // Windows has no Node directory-fsync durability primitive. Its orchestration tests use an
  // explicitly test-only injected adapter; POSIX exercises the real persistent implementation.
  const memory = new InMemoryBudgetLimiter(total, 'fixture-budget');
  const limiter = process.platform === 'win32' ? { durable: true, reserve: memory.reserve.bind(memory), snapshot: memory.snapshot.bind(memory) } :
    new FileBudgetLimiter({ path: join(dir, 'budget.jsonl'), total, ledgerId: 'fixture-budget' });
  const production: ProductionGateConfig = {
    familyId: 'fixed-family', maxComparisons: comparisons, evaluator: { id: 'offline-fixture', model: 'no-model', artifactDigest: H },
    dependenciesDigest: H, selectionItemIds: ['selection-0'],
    suites: Array.from({ length: comparisons }, (_, g) => ({ id: `independent-${g}`, seed: `seed-${g}`,
      itemIds: Array.from({ length: 12 }, (_, i) => `source-task-${g}-${i}`),
      items: Array.from({ length: 12 }, (_, i) => ({ task: `source-task-${g}-${i}`, difficulty: g + 1 })),
    })),
  };
  let calls = 0, proposals = 0;
  const evaluator = async (policy: Record<string, string>, suite: Suite): Promise<Score> => {
    calls++;
    const quality = Object.values(policy).join('').length;
    const score: Score = { primary: quality, noopRate: 0, costPerWin: 1, regressed: false };
    if ('itemIds' in suite) {
      const s = suite as ProductionGateConfig['suites'][number];
      score.itemWins = s.items.map((i) => quality >= (i as { difficulty: number }).difficulty);
      score.provenance = { source: 'LIVE', purpose: 'promotion', evaluatorDigest: H,
        corpusDigest: evidenceDigest(s), policyDigest: evidenceDigest(policy), sampleIds: [...s.itemIds] };
    }
    return score;
  };
  const cfg: FlywheelConfig = {
    promotionMode: 'production', production, hardBudget: { limiter, evaluatorUnits: 1, proposerUnits: 1 },
    rootPolicy: { a: '' }, proposer: async (base, target) => { proposals++; return `${base.policy[target]}#`; }, evaluator,
    holdout: { id: 'selection', items: [{ task: 'selection-0' }] }, maxGenerations: comparisons, signer: makeSigner(), dataSource: 'LIVE',
  };
  return { cfg, production, limiter, calls: () => calls, proposals: () => proposals };
}
function manifest(f = fixture()): ProductionGateManifest {
  return createProductionManifest(f.production, {
    baseRule: meetsPromotionRule, evaluator: f.cfg.evaluator, holdout: f.cfg.holdout, rootPolicy: f.cfg.rootPolicy,
    budget: { ledgerId: 'fixture-budget', total: 100, evaluatorUnits: 1, proposerUnits: 1 },
  });
}
function validEvidence(m: ProductionGateManifest): PromotionEvidence {
  const baselineDigest = evidenceDigest({ a: '' }), candidateDigest = evidenceDigest({ a: '#' });
  const score = (won: boolean, policyDigest: string): Score => ({ primary: won ? 1 : 0, noopRate: 0, costPerWin: 1, regressed: false,
    itemWins: m.suites[0]!.itemIds.map(() => won), provenance: { source: 'LIVE', purpose: 'promotion', evaluatorDigest: H,
      corpusDigest: m.suites[0]!.digest, policyDigest, sampleIds: [...m.suites[0]!.itemIds] } });
  return { baseline: score(false, baselineDigest), candidate: score(true, candidateDigest),
    production: { comparison: 1, baselinePolicyDigest: baselineDigest, candidatePolicyDigest: candidateDigest,
      baseline: score(false, baselineDigest), candidate: score(true, candidateDigest) } };
}

describe('explicit research compatibility and configuration identity', () => {
  it('preserves #319 missing/empty evidence fallback only in the research wrapper', () => {
    const evidence = { baseline: { primary: 0, noopRate: 0, costPerWin: 1, regressed: false }, candidate: { primary: 1, noopRate: 0, costPerWin: 1, regressed: false } };
    const research = withSequentialEvidence(meetsPromotionRule);
    expect(research(evidence)).toEqual(meetsPromotionRule(evidence));
    expect(research({ ...evidence, pairedOutcomes: [] })).toEqual(meetsPromotionRule(evidence));
    expect(createProductionPromotionRule(manifest())(evidence)).toMatchObject({ promote: false, status: 'INCONCLUSIVE' });
  });
  it('fixes equal fingerprint / unequal decision for alpha .05 versus .9', () => {
    const a = withSequentialEvidence(meetsPromotionRule, { alpha: .05 });
    const b = withSequentialEvidence(meetsPromotionRule, { alpha: .9 });
    const e = validEvidence(manifest()); e.pairedOutcomes = [{ itemId: '0', baselineWon: false, candidateWon: true }];
    expect(a(e).promote).toBe(false); expect(b(e).promote).toBe(true);
    expect(gateFingerprint(a)).not.toBe(gateFingerprint(b));
  });
  it('snapshots mutable sequential configuration', () => {
    const config = { alpha: .05, lambda: .5 }; const rule = withSequentialEvidence(meetsPromotionRule, config); const before = gateFingerprint(rule);
    config.alpha = .9;
    const e = validEvidence(manifest()); e.pairedOutcomes = [{ itemId: '0', baselineWon: false, candidateWon: true }];
    expect(rule(e).promote).toBe(false); expect(gateFingerprint(rule)).toBe(before);
  });
  it.each(['alpha', 'lambda', 'familyId', 'maxComparisons', 'evaluator', 'dependencies', 'corpus', 'seed', 'baseRule', 'budget', 'anchor'])(
    'binds %s into the production policy fingerprint', (field) => {
      const original = manifest(), changed = clone(original);
      switch (field) {
        case 'alpha': changed.alpha = .9; break;
        case 'lambda': changed.lambda = .2; break;
        case 'familyId': changed.familyId += 'x'; break;
        case 'maxComparisons': changed.maxComparisons++; changed.suites.push({ ...clone(changed.suites[0]!), id: 'extra-suite', itemIds: changed.suites[0]!.itemIds.map((x) => `extra-${x}`) }); break;
        case 'evaluator': changed.evaluator.artifactDigest = 'b'.repeat(64); break;
        case 'dependencies': changed.dependenciesDigest = 'b'.repeat(64); break;
        case 'corpus': changed.suites[0]!.digest = 'b'.repeat(64); break;
        case 'seed': changed.suites[0]!.seed += 'x'; break;
        case 'baseRule': changed.baseRule.configuration = { threshold: 9 }; break;
        case 'budget': changed.budget.total++; break;
        case 'anchor': changed.anchorCorpusDigest = H; changed.anchorItemIds = ['anchor-task']; break;
      }
      expect(gateFingerprint(createProductionPromotionRule(original))).not.toBe(gateFingerprint(createProductionPromotionRule(changed)));
    });
});

describe('production independent-evidence boundary', () => {
  const mutations: Array<[string, (e: PromotionEvidence) => void]> = [
    ['absent', (e) => { delete e.production; }],
    ['missing item wins', (e) => { delete e.production!.candidate.itemWins; }],
    ['empty', (e) => { e.production!.candidate.itemWins = []; }],
    ['mismatched', (e) => { e.production!.candidate.itemWins!.pop(); }],
    ['mistyped wins', (e) => { (e.production!.candidate.itemWins as unknown[])[0] = 'true'; }],
    ['duplicate sample identities', (e) => { e.production!.candidate.provenance!.sampleIds[1] = e.production!.candidate.provenance!.sampleIds[0]!; }],
    ['wrong sample order', (e) => { e.production!.candidate.provenance!.sampleIds.reverse(); }],
    ['synthetic source', (e) => { (e.production!.candidate.provenance as any).source = 'SYNTHETIC'; }],
    ['unspecified source', (e) => { delete (e.production!.candidate.provenance as any).source; }],
    ['selection evidence', (e) => { (e.production!.candidate.provenance as any).purpose = 'selection'; }],
    ['wrong corpus', (e) => { e.production!.candidate.provenance!.corpusDigest = 'b'.repeat(64); }],
    ['wrong evaluator', (e) => { e.production!.candidate.provenance!.evaluatorDigest = 'b'.repeat(64); }],
    ['wrong policy', (e) => { e.production!.candidate.provenance!.policyDigest = 'b'.repeat(64); }],
    ['same policy', (e) => { e.production!.candidatePolicyDigest = e.production!.baselinePolicyDigest; }],
    ['nonfinite score', (e) => { e.production!.candidate.primary = NaN; }],
    ['missing regression flag', (e) => { delete (e.production!.candidate as any).regressed; }],
    ['out-of-family comparison', (e) => { e.production!.comparison = 2; }],
    ['concordant', (e) => { e.production!.candidate.itemWins = [...e.production!.baseline.itemWins!]; }],
  ];
  it.each(mutations)('returns INCONCLUSIVE for %s evidence', (_, mutate) => {
    const m = manifest(), e = validEvidence(m); mutate(e);
    expect(createProductionPromotionRule(m)(e)).toMatchObject({ promote: false, status: 'INCONCLUSIVE' });
  });
  it('requires both base and independent gates plus bounded-family sequential strength', () => {
    const m = manifest(), rule = createProductionPromotionRule(m), e = validEvidence(m);
    expect(rule(e).promote).toBe(true);
    e.production!.candidate.regressed = true; expect(rule(e).promote).toBe(false);
    e.production!.candidate.regressed = false; e.candidate.costPerWin = 5; expect(rule(e).promote).toBe(false);
  });
  it('forbids overlapping source identities or identical task bytes before any evaluator call', async () => {
    for (const overlap of ['id', 'content']) {
      const f = fixture();
      if (overlap === 'id') f.production.suites[0]!.itemIds[0] = 'selection-0';
      else f.production.suites[0]!.items[0] = clone(f.cfg.holdout.items[0]);
      await expect(runFlywheelGenerations(f.cfg)).rejects.toThrow(/disjoint/);
      expect(f.calls()).toBe(0);
    }
  });
  it.each(['missing', 'synthetic', 'cache', 'memory-budget', 'custom-rule'])('fails preflight for %s production configuration', async (which) => {
    const f = fixture();
    if (which === 'missing') delete f.cfg.production;
    if (which === 'synthetic') f.cfg.dataSource = 'SYNTHETIC';
    if (which === 'cache') f.cfg.cacheEvaluations = true;
    if (which === 'memory-budget') f.cfg.hardBudget!.limiter = new InMemoryBudgetLimiter(100);
    if (which === 'custom-rule') f.cfg.promotionRule = () => ({ promote: true, reasons: [] });
    await expect(runFlywheelGenerations(f.cfg)).rejects.toThrow(); expect(f.calls()).toBe(0);
  });
});

describe('production E2E receipts, replay and hard costs', () => {
  it('selects before fresh independent evaluation, promotes and replays all configuration-bound receipts', async () => {
    const f = fixture(); const result = await runFlywheelGenerations(f.cfg);
    expect(result.promotions).toHaveLength(1); expect(f.calls()).toBe(4); expect(f.proposals()).toBe(1);
    const b = result.replayBundle;
    expect(b.budget_snapshot!.reserved).toBe(5);
    expect(verifyReplayBundle(b, { pinnedGateFingerprint: b.gate_fingerprint!, pinnedPublicKey: f.cfg.signer.publicKey() }).pass).toBe(true);
    expect(verifyReplayBundle(b).pass).toBe(false);
    expect(verifyReplayBundle(b, { pinnedGateFingerprint: b.gate_fingerprint!, pinnedPublicKey: makeSigner().publicKey() }).pass).toBe(false);
  });
  it('requires item evidence in the running loop, not only the verifier', async () => {
    const f = fixture(); f.cfg.evaluator = async (p) => ({ primary: p.a!.length, noopRate: 0, costPerWin: 1, regressed: false });
    const r = await runFlywheelGenerations(f.cfg);
    expect(r.promotions).toHaveLength(0); expect(r.replayBundle.all_commits[0]!.failureReasons).toContain('invalid_independent_evidence');
  });
  it.each(Array.from({ length: 8 }, (_, i) => i))('never exceeds a %i-unit bound, including baseline and proposer', async (total) => {
    const f = fixture(total);
    if (total === 0) await expect(runFlywheelGenerations(f.cfg)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    else {
      const r = await runFlywheelGenerations(f.cfg);
      expect(r.promotions.length).toBe(total >= 5 ? 1 : 0);
    }
    expect(f.calls() + f.proposals()).toBeLessThanOrEqual(total);
    expect((await f.limiter.snapshot()).reserved).toBe(f.calls() + f.proposals());
  });
  it('counts executed failures and denies a restarted baseline even under a different root id', async () => {
    const f = fixture(2); let called = 0;
    f.cfg.evaluator = async () => { called++; throw new Error('provider uncertain'); };
    await expect(runFlywheelGenerations(f.cfg)).rejects.toThrow('provider uncertain');
    expect((await f.limiter.snapshot()).reserved).toBe(1);
    await expect(runFlywheelGenerations({ ...f.cfg, rootId: 'different-run' })).rejects.toMatchObject({ code: 'BUDGET_DUPLICATE_OPERATION' });
    expect(called).toBe(1);
  });
  it('does not swallow failed production checkpoints', async () => {
    const f = fixture(); f.cfg.onGeneration = () => { throw new Error('disk unavailable'); };
    await expect(runFlywheelGenerations(f.cfg)).rejects.toThrow('disk unavailable');
    expect((await f.limiter.snapshot()).reserved).toBe(5);
  });
  it('resumes with the original ledger and sealed state; rejects tampering and reset ledgers', async () => {
    const f = fixture(100, 2); let saved: ResumeState | undefined;
    const first = await runFlywheelGenerations({ ...f.cfg, maxGenerations: 1, onGeneration: (i) => { saved = i.resumeState; } });
    expect(first.promotions).toHaveLength(1);
    const bad = clone(saved!); bad.score.primary = 100;
    await expect(runFlywheelGenerations({ ...f.cfg, resumeFrom: bad })).rejects.toThrow(/authentic/);
    const other = fixture(100, 2);
    await expect(runFlywheelGenerations({ ...f.cfg, hardBudget: other.cfg.hardBudget, resumeFrom: saved })).rejects.toThrow(/authentic/);
    const r = await runFlywheelGenerations({ ...f.cfg, resumeFrom: saved });
    expect(r.promotions).toHaveLength(2); expect(f.calls()).toBe(7);
    expect(verifyReplayBundle(r.replayBundle, { pinnedGateFingerprint: r.replayBundle.gate_fingerprint!, pinnedPublicKey: f.cfg.signer.publicKey() }).pass).toBe(true);
  });
  it.each(['alpha', 'lambda', 'corpus', 'budget', 'evidence', 'mode', 'strip', 'lineage-copy'])('rejects %s replay tampering', async (kind) => {
    const f = fixture(); const r = await runFlywheelGenerations(f.cfg); const b = clone(r.replayBundle);
    const pin = b.gate_fingerprint!;
    if (kind === 'alpha') b.gate_manifest!.alpha = .9;
    if (kind === 'lambda') b.gate_manifest!.lambda = .9;
    if (kind === 'corpus') b.gate_manifest!.suites[0]!.digest = 'b'.repeat(64);
    if (kind === 'budget') b.budget_snapshot!.reserved = 0;
    if (kind === 'evidence') delete b.chain[0]!.productionEvidence;
    if (kind === 'mode') b.promotion_mode = 'research';
    if (kind === 'strip') { delete b.promotion_mode; delete b.production_receipt; delete b.gate_manifest; delete b.budget_snapshot; }
    if (kind === 'lineage-copy') b.all_commits[0]!.candidateScore!.primary = 999;
    expect(verifyReplayBundle(b, { pinnedGateFingerprint: pin, pinnedPublicKey: f.cfg.signer.publicKey() }).pass).toBe(false);
  });
  it('rejects changed configuration on resume before any new provider work', async () => {
    const f = fixture(100, 2); let saved: ResumeState | undefined;
    await runFlywheelGenerations({ ...f.cfg, maxGenerations: 1, onGeneration: (i) => { saved = i.resumeState; } });
    const before = f.calls(); f.production.alpha = .9;
    await expect(runFlywheelGenerations({ ...f.cfg, resumeFrom: saved })).rejects.toThrow(/authentic/);
    expect(f.calls()).toBe(before);
  });
});


describe('adversarial pin and lifecycle regressions', () => {
  it('requires the current helper implementation when rebuilding a pinned production gate', () => {
    const m = manifest(); m.implementationDigest = '0'.repeat(64);
    expect(() => createProductionPromotionRule(m)).toThrow(/implementation changed/);
    const n = manifest(); n.baseRule.dependenciesDigest = '0'.repeat(64);
    expect(() => createProductionPromotionRule(n)).toThrow(/helpers changed/);
  });
  it('does not allow a research downgrade when a trusted production signer was requested', async () => {
    const f = fixture(); const production = await runFlywheelGenerations(f.cfg);
    const research = await runFlywheelGenerations({ rootPolicy: { a: '' }, proposer: async () => '#',
      evaluator: async (p) => ({ primary: p.a!.length, noopRate: 0, costPerWin: 1, regressed: false }),
      holdout: { id: 's', items: [] }, maxGenerations: 1, signer: makeSigner() });
    research.replayBundle.gate_fingerprint = production.replayBundle.gate_fingerprint;
    expect(verifyReplayBundle(research.replayBundle, { pinnedGateFingerprint: production.replayBundle.gate_fingerprint!, pinnedPublicKey: f.cfg.signer.publicKey() }).pass).toBe(false);
  });
  it('does not expose mutable live policy or score references to checkpoint observers', async () => {
    const f = fixture();
    f.cfg.onGeneration = (info) => {
      info.resumeState.policy.a = 'UNAPPROVED'; info.resumeState.score.primary = 999;
      info.partialBundle.gate_manifest!.alpha = .99;
      info.partialBundle.chain[0]!.candidateScore!.primary = 999;
    };
    const r = await runFlywheelGenerations(f.cfg);
    expect(r.finalPolicy).toEqual({ a: '#' }); expect(r.replayBundle.gate_manifest!.alpha).toBe(.05);
    expect(verifyReplayBundle(r.replayBundle, { pinnedGateFingerprint: r.replayBundle.gate_fingerprint!, pinnedPublicKey: f.cfg.signer.publicKey() }).pass).toBe(true);
  });
  it('snapshots operation functions, limiter methods and unit amounts before callbacks', async () => {
    const f = fixture(); const original = f.cfg.proposer; let bypass = 0;
    f.cfg.proposer = async (...args) => {
      f.cfg.evaluator = async () => { bypass++; return { primary: 999, noopRate: 0, costPerWin: 0, regressed: false }; };
      f.cfg.hardBudget!.evaluatorUnits = 0;
      f.cfg.hardBudget!.limiter.reserve = async () => { bypass++; };
      return original(...args);
    };
    const r = await runFlywheelGenerations(f.cfg);
    expect(bypass).toBe(0); expect(r.replayBundle.budget_snapshot!.reserved).toBe(5);
  });
  it('rejects same-id replacement ledgers with equivalent spend but different operation history', async () => {
    const f = fixture(100, 2); let saved: ResumeState | undefined;
    await runFlywheelGenerations({ ...f.cfg, maxGenerations: 1, onGeneration: (info) => { saved = info.resumeState; } });
    const replacement = fixture(100, 2);
    for (let i = 0; i < 5; i++) await replacement.limiter.reserve({ operationId: `dummy-${i}`, kind: 'evaluator', evaluatorId: 'offline-fixture', units: 1 });
    await expect(runFlywheelGenerations({ ...f.cfg, hardBudget: replacement.cfg.hardBudget, resumeFrom: saved })).rejects.toThrow(/authentic/);
  });
});


describe('frozen anchor safety', () => {
  it('never drops the anchor evaluator regression flag', async () => {
    const f = fixture(); const evaluator = f.cfg.evaluator;
    f.cfg.anchor = { id: 'anchor', items: [{ task: 'anchor-0' }] }; f.production.anchorItemIds = ['anchor-0'];
    f.cfg.evaluator = async (policy, suite) => {
      const s = await evaluator(policy, suite);
      return suite.id === 'anchor' ? { ...s, primary: 1, regressed: policy.a !== '' } : s;
    };
    const r = await runFlywheelGenerations(f.cfg);
    expect(r.promotions).toHaveLength(0);
    expect(r.replayBundle.all_commits[0]!.failureReasons).toContain('anchor_safety_regressed');
    expect(r.replayBundle.all_commits[0]!.anchorEvaluation!.regressed).toBe(true);
  });
  it('rejects an unsafe root anchor and charges both executed evaluations', async () => {
    const f = fixture(); const evaluator = f.cfg.evaluator;
    f.cfg.anchor = { id: 'anchor', items: [{ task: 'anchor-0' }] }; f.production.anchorItemIds = ['anchor-0'];
    f.cfg.evaluator = async (policy, suite) => ({ ...await evaluator(policy, suite), regressed: suite.id === 'anchor' });
    await expect(runFlywheelGenerations(f.cfg)).rejects.toThrow(/unsafe root anchor/);
    expect((await f.limiter.snapshot()).reserved).toBe(2);
  });
});


describe('custom base rules cannot bypass production guardrails', () => {
  it('retains a frozen anchor primary bar even when the custom rule ignores anchors', async () => {
    const f = fixture(); const evaluator = f.cfg.evaluator;
    f.cfg.promotionRule = () => ({ promote: true, reasons: [] });
    f.production.baseRule = { configuration: { intentionallyPermissive: true }, dependenciesDigest: H };
    f.cfg.anchor = { id: 'anchor', items: [{ task: 'anchor-0' }] }; f.production.anchorItemIds = ['anchor-0'];
    f.cfg.evaluator = async (policy, suite) => suite.id === 'anchor' ? { primary: policy.a === '' ? 1 : 0, noopRate: 0, costPerWin: 1, regressed: false } : evaluator(policy, suite);
    const r = await runFlywheelGenerations(f.cfg);
    expect(r.promotions).toHaveLength(0);
    expect(r.replayBundle.all_commits[0]!.failureReasons).toContain('anchor_regressed');
  });
});


it('a custom rule cannot waive a selection-suite safety regression', async () => {
  const f = fixture(); const evaluator = f.cfg.evaluator;
  f.cfg.promotionRule = () => ({ promote: true, reasons: [] });
  f.production.baseRule = { configuration: {}, dependenciesDigest: H };
  f.cfg.evaluator = async (policy, suite) => ({ ...await evaluator(policy, suite), regressed: suite.id === 'selection' && policy.a !== '' });
  const r = await runFlywheelGenerations(f.cfg);
  expect(r.promotions).toHaveLength(0);
  expect(r.replayBundle.all_commits[0]!.failureReasons).toContain('safety_regressed');
  expect(f.calls()).toBe(2); // Selection rejects before spending on independent evidence.
});
