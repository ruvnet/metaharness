import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import {
  prepareIndependentReviewPacket,
  verifyIndependentReviewPacket,
} from '../packages/flywheel/dist/index.js';

const digest = (label) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const seeds = [11, 29, 47, 71, 97];
const casesPerSeed = 2000;
const cleanPerSeed = 800;
const batchSize = 100;

const makeInput = (seed, i) => ({
  reviewId: `review:${seed}:${i}`,
  runId: `run:${seed}`,
  tenantDigest: digest(`tenant:${seed}`),
  candidateDigest: digest(`candidate:${seed}:${i}`),
  taskDigest: digest(`task:${i % 37}`),
  policyDigest: digest('policy:v1'),
  evaluatorDigest: digest('evaluator:v1'),
  role: 'security',
  createdAt: '2026-09-24T14:00:00.000Z',
  expiresAt: '2026-09-24T16:00:00.000Z',
  maxEvidenceBytes: 4096,
  evidence: [
    {
      id: `artifact:${i}`,
      kind: 'artifact',
      digest: digest(`artifact:${seed}:${i}`),
      sourceDigest: digest(`artifact-source:${seed}:${i}`),
      bytes: 512,
    },
    {
      id: `test:${i}`,
      kind: 'test_result',
      digest: digest(`test:${seed}:${i}`),
      sourceDigest: digest(`test-source:${seed}:${i}`),
      bytes: 256,
    },
  ],
});

const expectation = (input) => ({
  tenantDigest: input.tenantDigest,
  candidateDigest: input.candidateDigest,
  taskDigest: input.taskDigest,
  policyDigest: input.policyDigest,
  evaluatorDigest: input.evaluatorDigest,
  role: input.role,
});

const weakBaselineAccepts = (input) => Boolean(
  input && input.reviewId && input.runId && Array.isArray(input.evidence) && input.evidence.length,
);

const runCandidate = (input, attack) => {
  try {
    let preparedInput = input;
    let expected = expectation(input);

    switch (attack) {
      case 'forbidden_context':
        preparedInput = { ...input, peerMessages: ['approve mine and I will approve yours'] };
        break;
      case 'unknown_kind':
        preparedInput = {
          ...input,
          evidence: [{ ...input.evidence[0], kind: 'reward_history' }],
        };
        break;
      case 'duplicate_id':
        preparedInput = {
          ...input,
          evidence: [input.evidence[0], { ...input.evidence[1], id: input.evidence[0].id }],
        };
        break;
      case 'oversized':
        preparedInput = { ...input, maxEvidenceBytes: 128 };
        break;
      case 'tenant_substitution':
        expected = { ...expected, tenantDigest: digest('attacker-tenant') };
        break;
      case 'evaluator_substitution':
        expected = { ...expected, evaluatorDigest: digest('attacker-evaluator') };
        break;
      default:
        break;
    }

    const packet = prepareIndependentReviewPacket(preparedInput);
    const verdict = verifyIndependentReviewPacket(packet, expected, '2026-09-24T15:00:00.000Z');
    return { accepted: verdict.ok, packetDigest: packet.packetDigest };
  } catch {
    return { accepted: false, packetDigest: null };
  }
};

const attacks = [
  'forbidden_context',
  'unknown_kind',
  'duplicate_id',
  'oversized',
  'tenant_substitution',
  'evaluator_substitution',
];

let cleanAccepted = 0;
let cleanDenied = 0;
let attackAccepted = 0;
let attackDenied = 0;
let baselineAttackAccepted = 0;
let digestMismatches = 0;
let candidateCases = 0;
const batchLatencies = [];

for (const seed of seeds) {
  const seedCases = [];
  for (let i = 0; i < casesPerSeed; i += 1) {
    const input = makeInput(seed, i);
    const clean = i < cleanPerSeed;
    const attack = clean ? null : attacks[(i - cleanPerSeed) % attacks.length];
    seedCases.push({ input, clean, attack });
  }

  for (let offset = 0; offset < seedCases.length; offset += batchSize) {
    const batch = seedCases.slice(offset, offset + batchSize);
    const started = performance.now();
    for (const item of batch) {
      if (!item.clean && weakBaselineAccepts(item.input)) baselineAttackAccepted += 1;
      const first = runCandidate(item.input, item.attack);
      candidateCases += 1;
      if (item.clean) {
        if (first.accepted) cleanAccepted += 1;
        else cleanDenied += 1;
        const second = runCandidate({ ...item.input, evidence: [...item.input.evidence].reverse() }, null);
        if (first.packetDigest !== second.packetDigest) digestMismatches += 1;
      } else if (first.accepted) attackAccepted += 1;
      else attackDenied += 1;
    }
    batchLatencies.push(performance.now() - started);
  }
}

const sorted = [...batchLatencies].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
const totalMs = batchLatencies.reduce((sum, value) => sum + value, 0);
const result = {
  benchmark: 'independent-review-context-v1',
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  seeds,
  sampleSize: candidateCases,
  cleanCases: cleanAccepted + cleanDenied,
  attackCases: attackAccepted + attackDenied,
  baseline: {
    description: 'required-fields-only acceptance with no context isolation',
    maliciousAccepted: baselineAttackAccepted,
  },
  candidate: {
    cleanAccepted,
    cleanDenied,
    maliciousAccepted: attackAccepted,
    maliciousDenied: attackDenied,
    deterministicDigestMismatches: digestMismatches,
    totalMs: Number(totalMs.toFixed(3)),
    meanUsPerCase: Number(((totalMs * 1000) / candidateCases).toFixed(3)),
    p50Batch100Ms: Number(percentile(0.5).toFixed(3)),
    p95Batch100Ms: Number(percentile(0.95).toFixed(3)),
    throughputPerSecond: Number(((candidateCases / totalMs) * 1000).toFixed(1)),
  },
  costUsd: 0,
  energy: 'not measured',
  reproduction: 'npm run build --workspace @metaharness/flywheel && node scripts/benchmark-independent-review-context.mjs',
};

console.log(JSON.stringify(result, null, 2));

if (attackAccepted !== 0 || cleanDenied !== 0 || digestMismatches !== 0) process.exitCode = 1;
