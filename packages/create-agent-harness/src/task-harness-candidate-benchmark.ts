// SPDX-License-Identifier: MIT

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { sha256 } from './manifest.js';
import {
  TASK_HARNESS_CANDIDATE_SCHEMA,
  validateTaskHarnessCandidate,
  type TaskHarnessCandidate,
} from './task-harness-candidate.js';

const SEEDS = [1592639710, 271828182, 314159265, 161803398, 141421356] as const;
const CASES_PER_SEED = 2_000;
const BATCH_SIZE = 100;
const CEILING = ['memory.read', 'mcp.tools.call', 'repo.read', 'repo.write'];

type Attack = 'clean' | 'reordered-clean' | 'capability-expansion' | 'duplicate-module' | 'unknown-field';

interface Sample {
  input: unknown;
  attack: Attack;
  malicious: boolean;
  expectedDigest?: string;
}

export interface TaskHarnessCandidateBenchmarkResult {
  schema: 'metaharness-task-harness-candidate-benchmark/v1';
  seedSet: readonly number[];
  sampleSize: number;
  maliciousCases: number;
  cleanCases: number;
  baselineFalseAcceptance: number;
  candidateFalseAcceptance: number;
  cleanFalseDenial: number;
  deterministicDigestMismatches: number;
  candidate: {
    durationMs: number;
    throughputPerSecond: number;
    p95BatchLatencyMs: number;
  };
  baseline: {
    durationMs: number;
    throughputPerSecond: number;
  };
  environment: {
    node: string;
    platform: string;
    architecture: string;
  };
  costUsd: 'unavailable';
  energy: 'unavailable';
  reproduction: string;
  outcome: 'PASS' | 'FAIL';
}

export function runTaskHarnessCandidateBenchmark(): TaskHarnessCandidateBenchmarkResult {
  const samples: Sample[] = [];
  for (const seed of SEEDS) {
    let cleanReference: string | undefined;
    for (let i = 0; i < CASES_PER_SEED; i += 1) {
      const attack = attackFor(i);
      const base = makeCandidate(seed, i);
      let input: unknown = base;
      let malicious = false;
      let expectedDigest: string | undefined;
      if (attack === 'reordered-clean') {
        const reference = validateTaskHarnessCandidate(base, CEILING).candidateDigest;
        input = {
          ...base,
          modules: [...base.modules].reverse(),
          requestedCapabilities: [...base.requestedCapabilities].reverse(),
        };
        expectedDigest = reference;
      } else if (attack === 'capability-expansion') {
        input = { ...base, requestedCapabilities: [...base.requestedCapabilities, 'shell.exec'] };
        malicious = true;
      } else if (attack === 'duplicate-module') {
        const modules = base.modules.map((module) => ({ ...module }));
        modules[3] = { ...modules[3]!, kind: 'action' };
        input = { ...base, modules };
        malicious = true;
      } else if (attack === 'unknown-field') {
        input = { ...base, promotionThreshold: 0 };
        malicious = true;
      } else {
        cleanReference = validateTaskHarnessCandidate(base, CEILING).candidateDigest;
        expectedDigest = cleanReference;
      }
      samples.push({ input, attack, malicious, ...(expectedDigest === undefined ? {} : { expectedDigest }) });
    }
  }

  const baselineStart = performance.now();
  let baselineFalseAcceptance = 0;
  for (const sample of samples) {
    const accepted = naiveShapeOnlyBaseline(sample.input);
    if (accepted && sample.malicious) baselineFalseAcceptance += 1;
  }
  const baselineDurationMs = performance.now() - baselineStart;

  let candidateFalseAcceptance = 0;
  let cleanFalseDenial = 0;
  let deterministicDigestMismatches = 0;
  const batchLatencies: number[] = [];
  const candidateStart = performance.now();
  for (let offset = 0; offset < samples.length; offset += BATCH_SIZE) {
    const batchStart = performance.now();
    for (const sample of samples.slice(offset, offset + BATCH_SIZE)) {
      try {
        const validated = validateTaskHarnessCandidate(sample.input, CEILING);
        if (sample.malicious) candidateFalseAcceptance += 1;
        if (sample.expectedDigest !== undefined && validated.candidateDigest !== sample.expectedDigest) {
          deterministicDigestMismatches += 1;
        }
      } catch {
        if (!sample.malicious) cleanFalseDenial += 1;
      }
    }
    batchLatencies.push(performance.now() - batchStart);
  }
  const candidateDurationMs = performance.now() - candidateStart;

  const maliciousCases = samples.filter((sample) => sample.malicious).length;
  const cleanCases = samples.length - maliciousCases;
  const result: TaskHarnessCandidateBenchmarkResult = {
    schema: 'metaharness-task-harness-candidate-benchmark/v1',
    seedSet: SEEDS,
    sampleSize: samples.length,
    maliciousCases,
    cleanCases,
    baselineFalseAcceptance,
    candidateFalseAcceptance,
    cleanFalseDenial,
    deterministicDigestMismatches,
    candidate: {
      durationMs: round(candidateDurationMs),
      throughputPerSecond: round((samples.length / candidateDurationMs) * 1_000),
      p95BatchLatencyMs: round(percentile(batchLatencies, 0.95)),
    },
    baseline: {
      durationMs: round(baselineDurationMs),
      throughputPerSecond: round((samples.length / baselineDurationMs) * 1_000),
    },
    environment: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    costUsd: 'unavailable',
    energy: 'unavailable',
    reproduction: 'npm run benchmark:task-harness-candidate --workspace=metaharness',
    outcome:
      candidateFalseAcceptance === 0 &&
      cleanFalseDenial === 0 &&
      deterministicDigestMismatches === 0 &&
      baselineFalseAcceptance === maliciousCases
        ? 'PASS'
        : 'FAIL',
  };
  return result;
}

function makeCandidate(seed: number, index: number): TaskHarnessCandidate {
  const d = (suffix: string) => sha256(`${seed}:${index}:${suffix}`);
  return {
    schema: TASK_HARNESS_CANDIDATE_SCHEMA,
    candidateId: `candidate-${seed}-${index}`,
    taskDigest: d('task'),
    parentDigest: d('parent'),
    generator: {
      id: 'jit-agent-fixture',
      version: '1.0.0',
      sourceDigest: d('generator'),
    },
    modules: [
      { kind: 'memory', id: 'memory-v1', artifactDigest: d('memory-artifact'), configDigest: d('memory-config') },
      { kind: 'planning', id: 'planning-v1', artifactDigest: d('planning-artifact'), configDigest: d('planning-config') },
      { kind: 'action', id: 'action-v1', artifactDigest: d('action-artifact'), configDigest: d('action-config') },
      { kind: 'capability', id: 'capability-v1', artifactDigest: d('capability-artifact'), configDigest: d('capability-config') },
    ],
    requestedCapabilities: ['memory.read', 'repo.read'],
    generatedAt: new Date(Date.UTC(2026, 8, 15, 0, 0, 0) + index * 1_000).toISOString(),
    authority: 'none',
  };
}

function attackFor(index: number): Attack {
  switch (index % 5) {
    case 0:
      return 'clean';
    case 1:
      return 'reordered-clean';
    case 2:
      return 'capability-expansion';
    case 3:
      return 'duplicate-module';
    default:
      return 'unknown-field';
  }
}

function naiveShapeOnlyBaseline(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const object = input as Record<string, unknown>;
  return object.schema === TASK_HARNESS_CANDIDATE_SCHEMA &&
    object.authority === 'none' &&
    Array.isArray(object.modules) &&
    object.modules.length === 4 &&
    Array.isArray(object.requestedCapabilities);
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runTaskHarnessCandidateBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== 'PASS') process.exitCode = 1;
}
