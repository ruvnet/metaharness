// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { importEvidence } from './ingest.mjs';
import { evaluateCase, verifyReplay } from './replay.mjs';

// Each named fixture has a label from the scenario author, outside detector input.
// Partitions use distinct case IDs, timestamps and event permutations. They share
// rule families and are visible here; neither partition is blinded field evidence.
const incidentTimeline = {
  decoy: [['decoy_hit', 'canary', 0]],
  identityEdge: [['credential_change', 'identity', 0], ['anomalous_use', 'edge', 2]],
  identityEndpoint: [['credential_change', 'identity', 0], ['anomalous_use', 'endpoint', 10]],
  unsupported: [['anomalous_use', 'edge', 0], ['marker', 'endpoint', 5]]
};
const heldoutTimeline = {
  decoy: [['decoy_hit', 'edge', 0], ['benign', 'identity', 25], ['decoy_hit', 'canary', 120]],
  identityEdge: [['credential_change', 'identity', 0], ['credential_change', 'identity', 300_000, 'B'],
    ['anomalous_use', 'edge', 300_000]],
  identityEndpoint: [['credential_change', 'identity', 0], ['finding', 'artex', 15],
    ['credential_change', 'identity', 2_000], ['anomalous_use', 'endpoint', 2_000]],
  unsupported: [['credential_change', 'identity', 0], ['anomalous_use', 'endpoint', 600_000]]
};
const normalTimeline = [
  [['benign', 'edge', 0]],
  [['marker', 'edge', 0], ['marker', 'endpoint', 5]],
  [['finding', 'artex', 0], ['marker', 'edge', 10]],
  [['credential_change', 'identity', 0], ['benign', 'edge', 20]],
  [['anomalous_use', 'edge', 0], ['credential_change', 'identity', 5]],
  [['credential_change', 'identity', 0], ['anomalous_use', 'edge', 300_001]],
  [['credential_change', 'identity', 0, 'A'], ['anomalous_use', 'edge', 4, 'B']],
  [['credential_change', 'identity', 0], ['anomalous_use', 'edge', 0]],
  [['anomalous_use', 'endpoint', 0], ['anomalous_use', 'edge', 2]],
  [['benign', 'identity', 0], ['finding', 'artex', 2], ['anomalous_use', 'endpoint', 5]]
];

function fixture(partition, i) {
  const benign = partition === 'benign';
  const pattern = benign ? i % normalTimeline.length : i % 20;
  const family = benign ? 'control-' + pattern : pattern === 19 ? 'unsupported' :
    pattern < 8 ? 'decoy' : pattern < 15 ? 'identityEdge' : 'identityEndpoint';
  const incident = partition === 'heldout' ? heldoutTimeline : incidentTimeline;
  const template = benign ? normalTimeline[pattern] : incident[family];
  const group = benign ? 2 : partition === 'development' ? 0 : 1;
  const caseId = 'fixture-' + group + '-' + i;
  const tenant = 'lab-' + (i % 11);
  const epoch = 1_760_000_000_000 + group * 50_000_000 + i * 433;
  const session = 'session-' + i;
  const rows = template.map(([kind, source, offset, who = 'A'], index) => ({
    id: 'e-' + index, kind, source, at: epoch + offset, session: session + who
  }));
  // Vary benign background within and outside the decision session. Noise is
  // independent of the incident timeline and never supplies a response grant.
  const noise = (i * 7 + group * 3) % 13;
  for (let n = 0; n < noise; n++) {
    rows.push({
      id: 'noise-' + n, kind: n % 3 === 0 ? 'marker' : 'benign',
      source: n % 2 === 0 ? 'edge' : 'endpoint',
      at: epoch + n * 23 + 1, session: n % 3 === 0 ? session + 'A' : session + 'background'
    });
  }
  if ((group + i) % 2) rows.reverse();
  else if (rows.length > 2) rows.push(rows.shift());
  return { family, positive: !benign, scope: { tenant, caseId, format: 'json' },
    bytes: JSON.stringify({ version: 1, tenant, caseId, events: rows }) };
}

const fixturePin = 'd238f722e8d03f408483d23e888f1f97ec2bcffedfecb584ddc5482c0aa61f67';
const receiptPin = 'f555f6385dd833cb98d31ee3267aada310b26e67913ad99a16ccf0d86bdfa1aa';
const counts = { development: 20, heldout: 20, benign: 10_000 };
const tally = () => ({ cases: 0, detected: 0, missed: 0, falseBlocks: 0 });
const tallyCase = (record, positive, detected) => {
  record.cases++;
  if (positive) record[detected ? 'detected' : 'missed']++;
  else if (detected) record.falseBlocks++;
};

function percentile95(samples) {
  samples.sort((a, b) => a - b);
  return samples[Math.ceil(samples.length * 0.95) - 1];
}

export function runBenchmark() {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const fixtureHash = createHash('sha256');
  const receiptHash = createHash('sha256');
  const metrics = {};
  const latencies = [];
  let replayMismatches = 0, eventCount = 0;
  for (const [partition, count] of Object.entries(counts)) {
    const bucket = { baseline: tally(), candidate: tally(), families: {} };
    metrics[partition] = bucket;
    for (let i = 0; i < count; i++) {
      const { family, positive, scope, bytes } = fixture(partition, i);
      fixtureHash.update(JSON.stringify([partition, family, positive, bytes]) + '\n');
      const evidence = importEvidence(bytes, scope);
      eventCount += evidence.events.length;
      const baseline = evaluateCase(evidence, 'simulate', 'baseline');
      const beforePolicy = performance.now();
      const candidate = evaluateCase(evidence, 'simulate', 'candidate');
      latencies.push(performance.now() - beforePolicy);
      const familyScores = bucket.families[family] ??= { baseline: tally(), candidate: tally() };
      tallyCase(bucket.baseline, positive, baseline.summary.simulatedQuarantines > 0);
      tallyCase(bucket.candidate, positive, candidate.summary.simulatedQuarantines > 0);
      tallyCase(familyScores.baseline, positive, baseline.summary.simulatedQuarantines > 0);
      tallyCase(familyScores.candidate, positive, candidate.summary.simulatedQuarantines > 0);
      // Re-execution verifies determinism. The separately pinned fixture digest
      // below protects fixture definitions and labels against accidental drift.
      if (!verifyReplay(candidate, evidence, candidate.receiptSha256)) replayMismatches++;
      receiptHash.update(candidate.receiptSha256 + '\n');
    }
  }
  const corpusSha256 = fixtureHash.digest('hex');
  const candidateReceiptsSha256 = receiptHash.digest('hex');
  const actualMs = performance.now() - start;
  const p95Ms = percentile95(latencies);
  const heldout = metrics.heldout.candidate;
  const accepted = corpusSha256 === fixturePin && candidateReceiptsSha256 === receiptPin &&
    replayMismatches === 0 &&
    heldout.detected >= counts.heldout * 0.90 && heldout.detected > metrics.heldout.baseline.detected &&
    !metrics.benign.candidate.falseBlocks && p95Ms < 10;
  return {
    scope: 'offline synthetic policy replay', counts, eventCount, metrics,
    fixtures: { sha256: corpusSha256, pinnedSha256: fixturePin, matched: corpusSha256 === fixturePin },
    candidateReceiptsSha256, pinnedCandidateReceiptsSha256: receiptPin, replayMismatches,
    timing: { startedAt, finishedAt: new Date().toISOString(), totalMs: actualMs, p95PolicyMs: p95Ms,
      sequentialCasesPerSecond: Math.round(latencies.length * 1000 / actualMs), nodeVersion: process.version },
    accepted, deploymentAuthorized: false
  };
}
