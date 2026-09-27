import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  MULTIGEN_AUTHORITY,
  MULTIGEN_PROOF_VERSION,
  makeSigner,
  reviewerAttestationPayload,
  verifyMultiGenerationEvidence,
} from '../packages/flywheel/dist/index.js';

const digest = (label) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const seeds = [11, 29, 47, 71, 97];
const totalCases = 10_000;
const cleanCases = 4_000;
const budget = { attempts: 20, evaluationCalls: 40, processStarts: 20, tokenCeiling: 200_000, costMicroUsdCeiling: 500_000 };
const probe = (wins, best, median, cost) => ({
  budget: { ...budget },
  successfulSuccessors: wins,
  bestSuccessorLift: best,
  medianSuccessorLift: median,
  actualCostMicroUsd: cost,
});
const outcome = (primary, costPerWin) => ({ primary, costPerWin, safetyViolations: 0, regressions: 0 });
const control = (arm, primary, wins) => ({
  arm,
  outcome: outcome(primary, 9),
  improver: probe(wins, 0.04, 0.01, 200_000),
});

const reviewerA = makeSigner();
const reviewerB = makeSigner();
const trustedReviewerKeys = {
  'reviewer:a': reviewerA.publicKey(),
  'reviewer:b': reviewerB.publicKey(),
};

const attest = (runId, generation) => [
  {
    reviewerId: 'reviewer:a',
    receipt: reviewerA.sign(reviewerAttestationPayload(runId, generation, 'reviewer:a')),
  },
  {
    reviewerId: 'reviewer:b',
    receipt: reviewerB.sign(reviewerAttestationPayload(runId, generation, 'reviewer:b')),
  },
];

const fixture = (seed) => {
  const runId = `run:multigen-bench:${seed}`;
  const rows = [
    { parentId: 'root', childId: 'g1', baseline: outcome(0.60, 10), child: outcome(0.66, 9), parent: probe(4, 0.06, 0.02, 220_000), next: probe(6, 0.08, 0.03, 220_000) },
    { parentId: 'g1', childId: 'g2', baseline: outcome(0.66, 9), child: outcome(0.72, 8), parent: probe(6, 0.08, 0.03, 220_000), next: probe(8, 0.10, 0.04, 220_000) },
    { parentId: 'g2', childId: 'g3', baseline: outcome(0.72, 8), child: outcome(0.79, 7), parent: probe(8, 0.10, 0.04, 220_000), next: probe(10, 0.12, 0.05, 220_000) },
  ];

  const generations = rows.map((row, index) => {
    const generation = {
      generation: index + 1,
      parentId: row.parentId,
      childId: row.childId,
      sourceDigest: digest(`source:${seed}:${index}`),
      selectionSetDigest: digest(`selection:${seed}:${index}`),
      confirmationSetDigest: digest(`confirmation:${seed}:${index}`),
      evidenceClass: 'synthetic',
      baseline: row.baseline,
      child: row.child,
      parentImprover: row.parent,
      childImprover: row.next,
      controls: [
        control('frozen', row.child.primary - 0.04, Math.max(1, row.next.successfulSuccessors - 3)),
        control('static', row.child.primary - 0.03, Math.max(1, row.next.successfulSuccessors - 3)),
        control('shuffled', row.child.primary - 0.05, Math.max(1, row.next.successfulSuccessors - 4)),
        control('previous', row.child.primary - 0.02, Math.max(1, row.next.successfulSuccessors - 2)),
      ],
      reviewerAttestations: [],
      authority: MULTIGEN_AUTHORITY,
    };
    generation.reviewerAttestations = attest(runId, generation);
    return generation;
  });

  return {
    version: MULTIGEN_PROOF_VERSION,
    runId,
    rootId: 'root',
    gateDigest: digest(`gate:${seed}`),
    createdAt: '2026-09-27T00:00:00Z',
    generations,
    authority: MULTIGEN_AUTHORITY,
  };
};

const expectation = (evidence) => ({
  runId: evidence.runId,
  rootId: evidence.rootId,
  gateDigest: evidence.gateDigest,
  trustedReviewerKeys,
});

const attack = (evidence, family) => {
  const altered = structuredClone(evidence);
  switch (family) {
    case 0:
      altered.generations[1].childImprover.successfulSuccessors = altered.generations[1].parentImprover.successfulSuccessors;
      altered.generations[1].reviewerAttestations = attest(altered.runId, altered.generations[1]);
      break;
    case 1:
      altered.generations[2].confirmationSetDigest = altered.generations[1].confirmationSetDigest;
      altered.generations[2].reviewerAttestations = attest(altered.runId, altered.generations[2]);
      break;
    case 2:
      altered.generations[0].child.primary = altered.generations[0].baseline.primary + 0.005;
      altered.generations[0].reviewerAttestations = attest(altered.runId, altered.generations[0]);
      break;
    case 3:
      altered.generations[0].child.primary += 0.01;
      break;
    case 4:
      altered.generations[1].controls = altered.generations[1].controls.slice(0, 3);
      altered.generations[1].reviewerAttestations = attest(altered.runId, altered.generations[1]);
      break;
    case 5:
      altered.generations[2].child.safetyViolations = 1;
      altered.generations[2].reviewerAttestations = attest(altered.runId, altered.generations[2]);
      break;
    case 6:
      altered.generations[0].reviewerAttestations = [
        {
          reviewerId: 'reviewer:a',
          receipt: reviewerA.sign(reviewerAttestationPayload(altered.runId, altered.generations[0], 'reviewer:a')),
        },
        {
          reviewerId: 'reviewer:b',
          receipt: reviewerA.sign(reviewerAttestationPayload(altered.runId, altered.generations[0], 'reviewer:b')),
        },
      ];
      break;
  }
  return altered;
};

let falseAccepts = 0;
let falseDenials = 0;
const batchLatencies = [];
const batchSize = 100;
let processed = 0;

for (let offset = 0; offset < totalCases; offset += batchSize) {
  const started = performance.now();
  for (let i = offset; i < Math.min(totalCases, offset + batchSize); i += 1) {
    const seed = seeds[i % seeds.length];
    const clean = i < cleanCases;
    const evidence = fixture(seed);
    const family = clean ? -1 : (i - cleanCases) % 7;
    const candidate = clean ? evidence : attack(evidence, family);
    const expected = family === 6
      ? {
          ...expectation(candidate),
          trustedReviewerKeys: {
            'reviewer:a': reviewerA.publicKey(),
            'reviewer:b': reviewerA.publicKey(),
          },
        }
      : expectation(candidate);
    const verdict = verifyMultiGenerationEvidence(candidate, expected);
    if (clean && !verdict.pass) falseDenials += 1;
    if (!clean && verdict.pass) falseAccepts += 1;
    processed += 1;
  }
  batchLatencies.push(performance.now() - started);
}

const sorted = [...batchLatencies].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
const totalMs = batchLatencies.reduce((sum, value) => sum + value, 0);

const result = {
  benchmark: 'multigen-proof-v1',
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  seeds,
  sampleSize: processed,
  cleanCases,
  adversarialCases: processed - cleanCases,
  adversarialFamilies: [
    'improver_plateau',
    'confirmation_reuse',
    'insufficient_capability_lift',
    'post_attestation_tamper',
    'missing_control',
    'protected_regression',
    'reviewer_key_alias',
  ],
  candidate: {
    falseAccepts,
    falseDenials,
    totalMs: Number(totalMs.toFixed(3)),
    meanUsPerCase: Number(((totalMs * 1000) / processed).toFixed(3)),
    p50Batch100Ms: Number(percentile(0.50).toFixed(3)),
    p95Batch100Ms: Number(percentile(0.95).toFixed(3)),
    throughputPerSecond: Number(((processed / totalMs) * 1000).toFixed(1)),
  },
  costUsd: 0,
  energy: 'not measured',
  proofBoundary: 'synthetic verifier qualification only; no RSI or real-workload efficacy claim',
  reproduction: 'npm run build --workspace @metaharness/flywheel && node scripts/benchmark-multigeneration-proof.mjs',
};

console.log(JSON.stringify(result, null, 2));
if (falseAccepts !== 0 || falseDenials !== 0) process.exitCode = 1;
