#!/usr/bin/env node
// Offline control-path measurement, not a paid-model or provider-performance benchmark.
// Build first: npm run build --workspace @metaharness/flywheel
// Run: node packages/flywheel/scripts/benchmark-production-controls.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  FileBudgetLimiter, createProductionManifest, createProductionPromotionRule, evidenceDigest,
  gateFingerprint, makeSigner, meetsPromotionRule, runFlywheelGenerations, verifyReplayBundle,
} from '../dist/index.js';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = /^--(runs|families|samples|comparisons|seed)=(\d+)$/.exec(arg);
  if (!match) throw new Error(`Unknown argument ${arg}; use --runs=N --families=N --samples=N --comparisons=N --seed=N.`);
  return [match[1], Number(match[2])];
}));
const runs = args.runs ?? 25;
const families = args.families ?? 1000;
const samples = args.samples ?? 96;
const comparisons = args.comparisons ?? 5;
const seed = args.seed ?? 1592639710;
for (const [name, value] of Object.entries({ runs, families, samples, comparisons, seed })) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
}
if (process.platform === 'win32') {
  throw new Error('This durability benchmark requires a POSIX local filesystem with directory fsync. Windows is unsupported; no weaker substitute is measured.');
}

const alpha = 0.05;
const lambda = 0.5;
const digest = 'a'.repeat(64);
const noopScore = (primary, itemWins, provenance) => ({
  primary, noopRate: 0, costPerWin: 1, regressed: false,
  ...(itemWins ? { itemWins } : {}), ...(provenance ? { provenance } : {}),
});

function configuration(maxComparisons, sampleCount, familyId) {
  return {
    familyId, maxComparisons, alpha, lambda,
    evaluator: { id: 'offline-seeded-fixture-v1', model: 'NO_MODEL_SYNTHETIC', artifactDigest: digest },
    dependenciesDigest: digest,
    selectionItemIds: ['selection-item'],
    suites: Array.from({ length: maxComparisons }, (_, comparison) => ({
      id: `independent-${comparison}`, seed: `fixed-${comparison}`,
      itemIds: Array.from({ length: sampleCount }, (_, item) => `task-${comparison}-${item}`),
      items: Array.from({ length: sampleCount }, (_, item) => ({ id: `task-${comparison}-${item}`, requiredQuality: comparison + 1 })),
    })),
  };
}

function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => {
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
  };
  const round = (v) => Number(v.toFixed(3));
  return {
    n: values.length, min: round(sorted[0]), p50: round(at(.5)), p90: round(at(.9)),
    p95: round(at(.95)), p99: round(at(.99)), max: round(sorted.at(-1)),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
  };
}

async function controlRun(mode, parent, index) {
  const ledgerDirectory = await mkdtemp(join(parent, `${mode}-${index}-`));
  const signer = makeSigner(); // Key generation and temporary-directory allocation are outside timed execution.
  const production = configuration(2, 12, `control-${mode}-${index}`);
  production.anchorItemIds = ['frozen-anchor'];
  let evaluatorCalls = 0;
  let proposerCalls = 0;
  let evaluatedItems = 0;
  const evaluator = async (policy, suite) => {
    evaluatorCalls++;
    evaluatedItems += suite.items.length;
    const quality = policy.lever.length;
    if (!('itemIds' in suite)) return noopScore(quality);
    return noopScore(quality, suite.items.map((item) => quality >= item.requiredQuality), {
      source: 'LIVE', purpose: 'promotion', evaluatorDigest: digest,
      corpusDigest: evidenceDigest(suite), policyDigest: evidenceDigest(policy), sampleIds: [...suite.itemIds],
    });
  };
  const limiter = mode === 'production'
    ? new FileBudgetLimiter({ path: join(ledgerDirectory, 'budget.jsonl'), total: 100 })
    : null;
  const config = {
    rootPolicy: { lever: '' }, maxGenerations: 2, mutationTargets: ['lever'],
    holdout: { id: 'selection', items: [{ id: 'selection-item' }] },
    anchor: { id: 'anchor', items: [{ id: 'frozen-anchor' }] },
    proposer: async (base, target) => { proposerCalls++; return `${base.policy[target]}#`; },
    evaluator, signer,
    ...(mode === 'production'
      ? { promotionMode: 'production', production, hardBudget: { limiter, evaluatorUnits: 1, proposerUnits: 1 }, dataSource: 'LIVE' }
      : { promotionMode: 'research', dataSource: 'SYNTHETIC' }),
  };
  // Production exercises LIVE-shaped attestation validation using explicitly synthetic
  // in-process fixtures. This is NOT evidence that a real evaluator or model was used.
  const started = performance.now();
  const result = await runFlywheelGenerations(config);
  const loopFinished = performance.now();
  const replay = verifyReplayBundle(result.replayBundle, mode === 'production'
    ? { pinnedGateFingerprint: result.replayBundle.gate_fingerprint, pinnedPublicKey: signer.publicKey() }
    : { pinnedGateFingerprint: gateFingerprint(meetsPromotionRule), promotionRule: meetsPromotionRule });
  const finished = performance.now();
  assert.equal(replay.pass, true, `${mode} replay failed: ${replay.failures}`);
  assert.equal(result.promotions.length, 2);
  assert.equal(result.generationsRun, 2);
  const reservedUnits = result.replayBundle.budget_snapshot?.reserved ?? null;
  if (mode === 'production') assert.equal(reservedUnits, evaluatorCalls + proposerCalls);
  return {
    loopMs: loopFinished - started, replayMs: finished - loopFinished, endToEndMs: finished - started,
    evaluatorCalls, proposerCalls, evaluatedItems,
    externalOperationUnits: evaluatorCalls + proposerCalls, durableReservedUnits: reservedUnits,
    promotions: result.promotions.length, replayPassed: replay.pass,
  };
}

function summarizeRuns(records) {
  const countFields = ['evaluatorCalls', 'proposerCalls', 'evaluatedItems', 'externalOperationUnits', 'durableReservedUnits', 'promotions'];
  const perRun = {};
  for (const field of countFields) {
    assert.equal(new Set(records.map((record) => record[field])).size, 1, `Non-deterministic control count: ${field}`);
    perRun[field] = records[0][field];
  }
  return {
    milliseconds: {
      loop: quantiles(records.map((record) => record.loopMs)),
      replay: quantiles(records.map((record) => record.replayMs)),
      endToEnd: quantiles(records.map((record) => record.endToEndMs)),
    },
    perRun, allReplaysPassed: records.every((record) => record.replayPassed),
  };
}

// Small deterministic PRNG, only for independent synthetic Bernoulli labels.
function random(initialSeed) {
  let state = initialSeed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wilson(successes, trials) {
  const z = 1.959963984540054;
  const rate = successes / trials;
  const denominator = 1 + z * z / trials;
  const center = (rate + z * z / (2 * trials)) / denominator;
  const radius = z * Math.sqrt(rate * (1 - rate) / trials + z * z / (4 * trials * trials)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

function labelExperiment(candidateWinProbability, experimentSeed) {
  const rng = random(experimentSeed);
  const holdout = { id: 'selection', items: [{ id: 'selection-item' }] };
  const config = configuration(comparisons, samples, 'pre-registered-simulation-family');
  const fakeEvaluator = async () => noopScore(0);
  const manifest = createProductionManifest(config, {
    baseRule: meetsPromotionRule, evaluator: fakeEvaluator, holdout, rootPolicy: { lever: 'baseline' },
    budget: { ledgerId: 'simulation-only-no-calls', total: 1000000, evaluatorUnits: 1, proposerUnits: 1 },
  });
  const rule = createProductionPromotionRule(manifest);
  const baselinePolicyDigest = evidenceDigest({ lever: 'baseline' });
  const candidatePolicyDigest = evidenceDigest({ lever: 'candidate' });
  let acceptedFamilies = 0;
  let acceptedComparisons = 0;
  const started = performance.now();
  for (let family = 0; family < families; family++) {
    let accepted = false;
    for (let comparison = 0; comparison < comparisons; comparison++) {
      const suite = manifest.suites[comparison];
      const candidateWins = Array.from({ length: samples }, () => rng() < candidateWinProbability);
      const baselineWins = candidateWins.map((win) => !win);
      const score = (wins, policyDigest) => noopScore(wins.filter(Boolean).length / samples, wins, {
        source: 'LIVE', purpose: 'promotion', evaluatorDigest: digest,
        corpusDigest: suite.digest, policyDigest, sampleIds: [...suite.itemIds],
      });
      const verdict = rule({
        // Selection evidence is independently fixed favorable; it never uses these labels.
        baseline: noopScore(0), candidate: noopScore(1),
        production: {
          comparison: comparison + 1, baselinePolicyDigest, candidatePolicyDigest,
          baseline: score(baselineWins, baselinePolicyDigest), candidate: score(candidateWins, candidatePolicyDigest),
        },
      });
      if (verdict.promote) { accepted = true; acceptedComparisons++; }
    }
    if (accepted) acceptedFamilies++;
  }
  return {
    candidateWinProbability, seed: experimentSeed >>> 0, independentFamilies: families,
    comparisonsPerFamily: comparisons, samplesPerComparison: samples,
    acceptedFamilies, acceptedComparisons, familyAcceptanceRate: acceptedFamilies / families,
    familyAcceptanceWilson95: wilson(acceptedFamilies, families), elapsedMs: Number((performance.now() - started).toFixed(3)),
  };
}

const root = await mkdtemp(join(tmpdir(), 'flywheel-controls-benchmark-'));
try {
  for (let i = 0; i < 3; i++) {
    await controlRun('research', root, `warmup-${i}`);
    await controlRun('production', root, `warmup-${i}`);
  }
  const records = { research: [], production: [] };
  for (let i = 0; i < runs; i++) {
    // Alternate ordering to reduce systematic JIT/order bias.
    for (const mode of i % 2 ? ['production', 'research'] : ['research', 'production']) {
      records[mode].push(await controlRun(mode, root, i));
    }
  }
  const research = summarizeRuns(records.research);
  const production = summarizeRuns(records.production);
  const nullLabels = labelExperiment(.5, seed);
  const injectedEffect = labelExperiment(.65, seed ^ 0x9E3779B9);
  console.log(JSON.stringify({
    benchmark: 'flywheel-production-controls-v1', dataSource: 'SYNTHETIC_OFFLINE', paidInferenceCalls: 0, paidCostUSD: 0,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model ?? 'unknown' },
    timingScope: 'Timed loop includes ledger initialization, every file-fsynced reservation and committed head, independent baseline/candidate evaluations, frozen anchor, receipt signing and final bundle assembly; endToEnd adds replay. Excludes key generation, temporary-directory allocation/cleanup and warmups. Evaluators/proposers are in-process synthetic functions with no latency injection.',
    controlRuns: { runsPerMode: runs, warmupsPerMode: 3, generationsPerRun: 2, independentSamplesPerGeneration: 12,
      research, production,
      medianEndToEndDifferenceMs: Number((production.milliseconds.endToEnd.p50 - research.milliseconds.endToEnd.p50).toFixed(3)),
      medianEndToEndRatio: Number((production.milliseconds.endToEnd.p50 / research.milliseconds.endToEnd.p50).toFixed(3)),
      costUnitMeaning: 'One declared unit per proposer/evaluator invocation. These are synthetic operation counts, not token usage or currency.',
    },
    statisticalChecks: {
      familyAlpha: alpha, perComparisonAlpha: alpha / comparisons, lambda,
      nullLabels, injectedEffect,
      assumptions: [
        'Independent families; fresh independent Bernoulli discordant labels within each fixed suite and comparison.',
        'Selection is fixed independently of promotion labels. Suites and maxComparisons are fixed before sampling.',
        'A family is accepted if any pre-registered comparison promotes; the same manifested family is reused only across isolated Monte Carlo replicates, never as a durable run.',
        'All evidence and provenance are synthetic test fixtures. These experiments exercise the strict rule only, not trusted provider provenance or durable admission.',
        'Wilson intervals summarize finite Monte Carlo sampling. Results are not a theorem proof, a guarantee on dependent tasks, model quality evidence, or a paid-model benchmark.',
      ],
    },
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
