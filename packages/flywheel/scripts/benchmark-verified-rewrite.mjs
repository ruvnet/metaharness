// Local orchestration overhead only. No claim of model improvement or production throughput.
import { performance } from 'node:perf_hooks';
import { verifyTrajectoryRewrite, successPrioritizedReward, terminalOutcomesToScore } from '../dist/index.js';

const outcome = { strictSuccess: true, passedChecks: 42, totalChecks: 42, reportValid: true, cost: 1, safetyViolation: false };
let sessions = 0;
const cfg = {
  task: { split: 'development', id: 'bench', instruction: 'public task', snapshotDigest: 'a'.repeat(64), publicSteps: ['public procedure'] },
  discoveryOutcome: outcome, signal: new AbortController().signal, repeats: 8, maxReplayCost: 8,
  rewrite: async () => 'public procedure', review: async () => true,
  open: async () => ({ id: String(++sessions), snapshotDigest: 'a'.repeat(64), execute: async () => {},
    verify: async () => ({ ...outcome }), close: async () => {} }),
};
const iterations = 2000;
for (let i = 0; i < 100; i++) await verifyTrajectoryRewrite(cfg);
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  if (!(await verifyTrajectoryRewrite(cfg)).accepted) throw Error('unexpected rejection');
}
const rewriteMs = performance.now() - start;
const scoreStart = performance.now();
for (let i = 0; i < 100000; i++) { successPrioritizedReward(outcome, 82); terminalOutcomesToScore([outcome]); }
const scoreMs = performance.now() - scoreStart;
let rejectedSessions = 0;
const rejected = await verifyTrajectoryRewrite({ ...cfg, open: async () => ({ id: String(++rejectedSessions),
  snapshotDigest: 'a'.repeat(64), execute: async () => {}, verify: async () => ({ ...outcome, strictSuccess: false }), close: async () => {} }) });
if (rejected.accepted || rejectedSessions !== 1) throw Error('early rejection failed');
console.log(JSON.stringify({ evidence: 'LOCAL_ORCHESTRATION_ONLY', node: process.version,
  iterations, replaysPerIteration: 8, rewriteMicrosecondsPerIteration: rewriteMs * 1000 / iterations,
  rewardAndScoreMicrosecondsPerIteration: scoreMs * 1000 / 100000,
  rejectedReplaySessions: rejectedSessions, fullReplaySessions: 8, avoidedReplayFraction: 7 / 8 }, null, 2));
