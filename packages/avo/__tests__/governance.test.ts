import { describe, expect, it } from 'vitest';
import {
  DarwinArchive,
  GovernedAutonomyRouter,
  GovernedCapabilityPolicy,
  SemanticSupervisor,
  candidateUtility,
  qualifies,
  type Candidate,
  type EvaluationResult,
  type Hypothesis,
  type VariationState,
} from '../src/index.js';

function evaluation(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    evaluatorVersion: 'test-v1', correct: true, safe: true, replayable: true,
    noRegression: true, budgetValid: true, quality: 0.8, costUsd: 0.1,
    wallTimeMs: 10, policyViolations: 0, protectedTestsPassed: true,
    evidence: {}, ...overrides,
  };
}

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id, parentId: null, branchId: id, workspaceDigest: `sha256:${id}`,
    evaluation: evaluation(), novelty: 0.5, visits: 0, learningPotential: 0.5,
    risk: 0, committed: true, ...overrides,
  };
}

function state(evaluations: EvaluationResult[], candidates = [candidate('seed')]): VariationState {
  return {
    schema: 1, runId: 'run', task: 'task', stateHash: 'genesis',
    currentCandidateId: 'seed', currentBranchId: 'work', currentHypothesis: null,
    receipts: [], evaluations, candidates, memoryUpdates: [], rejectedLessons: [], interventions: [],
    budget: {
      maxActions: 100, maxBranchActions: 100, maxCostUsd: 10, maxWallTimeMs: 10_000,
      riskBudget: 2, actionsUsed: 0, branchActionsUsed: 0, costUsdUsed: 0,
      wallTimeMsUsed: 0, riskUsed: 0,
    },
    memoryCursor: null, pendingApprovals: [], startedAt: '2026-08-21T00:00:00.000Z',
  };
}

const strategies = async (): Promise<[Hypothesis, Hypothesis, Hypothesis]> => [
  { id: 'a', statement: 'narrow context', causalMechanism: 'context isolation', expectedEvidence: ['less noise'], surface: 'contextPolicy' },
  { id: 'b', statement: 'change retrieval', causalMechanism: 'counterexample recall', expectedEvidence: ['new evidence'], surface: 'retrievalPolicy' },
  { id: 'c', statement: 'change tests', causalMechanism: 'failure localization', expectedEvidence: ['smaller failure'], surface: 'testPolicy' },
];

describe('immutable capability policy', () => {
  it('default-denies capability and path expansion and keeps global regex decisions stable', () => {
    const policy = new GovernedCapabilityPolicy({
      version: 'p1', allowedActions: ['inspect', 'edit', 'execute'],
      approvalActions: ['execute'], allowedCommands: [/^npm test$/g], writablePaths: [/^policies\//g],
    });
    const current = state([]);
    expect(policy.authorize({ kind: 'execute', command: 'npm test' }, current).verdict).toBe('require-approval');
    expect(policy.authorize({ kind: 'execute', command: 'npm test' }, current).verdict).toBe('require-approval');
    expect(policy.authorize({ kind: 'execute', command: 'curl evil' }, current).verdict).toBe('deny');
    expect(policy.authorize({ kind: 'edit', path: '../policy', content: '', surface: 'repairStrategy' }, current).verdict).toBe('deny');
    expect(policy.authorize({ kind: 'branch', parentCandidateId: 'seed' }, current).verdict).toBe('deny');
  });
});

describe('promotion and archive selection', () => {
  it('requires every promotion clause and honors the confidence bound', () => {
    expect(qualifies(evaluation({ quality: 0.9, lowerConfidenceBound: 0.06 }), evaluation({ quality: 0.8 }), 0.05)).toBe(true);
    expect(qualifies(evaluation({ quality: 0.9, lowerConfidenceBound: 0.04 }), evaluation({ quality: 0.8 }), 0.05)).toBe(false);
    expect(qualifies(evaluation({ quality: 0.9, policyViolations: 1 }), evaluation({ quality: 0.8 }), 0.05)).toBe(false);
  });

  it('uses quality, novelty, uncertainty, learning, latency, cost, and risk', () => {
    const archive = new DarwinArchive();
    const risky = candidate('risky', { evaluation: evaluation({ quality: 0.95 }), risk: 10 });
    const useful = candidate('useful', { evaluation: evaluation({ quality: 0.85 }), novelty: 1, learningPotential: 1 });
    archive.insert(risky);
    archive.insert(useful);
    expect(candidateUtility(useful, 2)).toBeGreaterThan(candidateUtility(risky, 2));
    expect(archive.select().id).toBe('useful');
  });
});

describe('semantic supervisor', () => {
  it('redirects after five nonimproving evaluations with three distinct strategies', async () => {
    const supervisor = new SemanticSupervisor({ policyVersion: 'p1' }, strategies);
    const intervention = await supervisor.observe(state(Array.from({ length: 5 }, () => evaluation({ quality: 0.8 }))));
    expect(intervention?.trigger).toBe('plateau');
    expect(intervention?.strategies).toHaveLength(3);
  });

  it('prioritizes three matching failures and selects another lineage', async () => {
    const supervisor = new SemanticSupervisor({ policyVersion: 'p1' }, strategies);
    const repeated = Array.from({ length: 3 }, () => evaluation({ correct: false, quality: 0.2, failureSignature: 'same' }));
    const intervention = await supervisor.observe(state(repeated, [candidate('seed'), candidate('alternate', { learningPotential: 1 })]));
    expect(intervention?.trigger).toBe('repeated-failure');
    expect(intervention?.dominantFailure).toBe('same');
    expect(intervention?.alternateCandidateId).toBe('alternate');
  });
});

describe('task-mode routing', () => {
  it('keeps simple work fast and refuses autonomy under weak evaluation', () => {
    const router = new GovernedAutonomyRouter();
    expect(router.route({ task: 'typo', complexity: 0.1, failedAttempts: 0, estimatedValue: 0.1, evaluatorReliability: 1 }).mode).toBe('darwin-fast');
    expect(router.route({ task: 'hard', complexity: 1, failedAttempts: 3, estimatedValue: 1, evaluatorReliability: 1 }).mode).toBe('avo');
    expect(router.route({ task: 'hard', complexity: 1, failedAttempts: 3, estimatedValue: 1, evaluatorReliability: 0.2 }).mode).toBe('darwin-fast');
  });
});
