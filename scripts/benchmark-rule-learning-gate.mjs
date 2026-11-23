// Measures gate machinery with synthetic trusted measurements, not model latency.
import { performance } from 'node:perf_hooks';
import { evaluateRuleLearning } from '../packages/darwin-mode/src/rule-learning-gate.ts';
const hash = n => String(n).repeat(64);
const request = { runId: 'overhead-fixture', rulebookHash: hash(6), candidate: { candidateHash: hash(1), programHash: hash(2) }, baseline: { candidateHash: hash(3), programHash: hash(4) }, datasetHash: hash(5), families: ['a', 'b', 'c'], seeds: [1, 2, 3, 4, 5] };
const runner = async c => ({ successes: c.candidateHash === hash(1) ? 7 : 5, samples: 10, interactions: c.candidateHash === hash(1) ? 75 : 100, replaySteps: 10, independentProbes: 10, replayMismatches: 0, failedHiddenProbes: 0, receiptHash: hash(7) });
for (let i = 0; i < 5; i++) await evaluateRuleLearning(request, runner);
const durations = [];
for (let i = 0; i < 30; i++) {
  const start = performance.now();
  if (!(await evaluateRuleLearning(request, runner)).accepted) throw Error('gate failed');
  durations.push(performance.now() - start);
}
durations.sort((a, b) => a - b);
console.log(JSON.stringify({ synthetic: true, fixtureCount: 30, warmups: 5, hostInvocationsPerFixture: 60, node: process.version, p50Ms: durations[14], p95Ms: durations[28], maxMs: durations[29] }, null, 2));
