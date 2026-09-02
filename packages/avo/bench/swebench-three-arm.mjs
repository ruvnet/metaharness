import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { compareSWEbench, evaluateShipGate } from '../dist/index.js';

const inputPath = process.env.SWE_BENCH_RESULTS;
let input;
if (inputPath) {
  input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  if (!input.generatedAt) throw new Error('SWE-bench evidence must include its preregistered generatedAt timestamp');
} else {
  const arms = ['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'];
  const observations = arms.flatMap((arm) => Array.from({ length: 100 }, (_, index) => ({
    instanceId: `mechanism-${String(index).padStart(3, '0')}`,
    arm,
    resolved: index < (arm === 'darwin-fixed' ? 40 : arm === 'avo-no-supervisor' ? 45 : 49),
    costUsd: arm === 'darwin-fixed' ? 0.4 : arm === 'avo-no-supervisor' ? 0.5 : 0.56,
    wallTimeMs: arm === 'darwin-fixed' ? 100 : 300,
    policyViolations: 0,
    expectedReplayHash: `sha256:mechanism-${index}`,
    actualReplayHash: `sha256:mechanism-${index}`,
    rollbackCount: arm === 'darwin-fixed' ? 0 : index % 10 === 0 ? 1 : 0,
    coherenceRetention: arm === 'darwin-fixed' ? 0.7 : 0.9,
  })));
  input = {
    generatedAt: '2026-08-21T00:00:00.000Z',
    datasetKind: 'synthetic-mechanism', model: 'deterministic-no-provider-fixture',
    reasoningConfiguration: 'none', tokenBudget: 0, evaluatorVersion: 'fixture-v1',
    taskSetHash: 'sha256:synthetic-mechanism-only', observations,
  };
}

const comparison = compareSWEbench(input);
const output = { generatedAt: input.generatedAt, comparison, gate: evaluateShipGate(comparison) };
const outputPath = resolve('bench/results/swebench-three-arm.json');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
