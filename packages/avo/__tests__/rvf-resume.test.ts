import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Ed25519ReceiptSigner,
  GovernedCapabilityPolicy,
  GovernedVariationOperator,
  JsonCheckpointStore,
  RvfGovernedMemory,
  SemanticSupervisor,
  verifyReceipt,
  type ActionObservation,
  type Candidate,
  type EnvironmentAdapter,
  type EvaluationResult,
  type Hypothesis,
  type VariationAction,
  type VariationContext,
  type VariationResult,
  type VariationState,
} from '../src/index.js';

const MAX_ACTIONS = 205;

function evaluation(branchId: string): EvaluationResult {
  return {
    evaluatorVersion: 'resume-eval-v1', correct: true, safe: true, replayable: true,
    noRegression: true, budgetValid: true, quality: 0.75, costUsd: 0,
    wallTimeMs: 1, policyViolations: 0, protectedTestsPassed: true,
    lowerConfidenceBound: 0, evidence: { branchId },
  };
}

class ReplayEnvironment implements EnvironmentAdapter {
  readonly version = 'replay-env-v1';
  async fork(parent: Candidate) {
    return { branchId: `${parent.id}-work`, workspaceDigest: `sha256:fork-${parent.id}` };
  }
  async execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation> {
    return {
      ok: true, stdout: `${action.kind}:${state.budget.actionsUsed + 1}`, exitCode: 0,
      durationMs: 1, costUsd: 0,
      workspaceDigest: `sha256:action-${state.budget.actionsUsed + 1}-${action.kind}`,
    };
  }
  async quarantine(): Promise<void> {}
}

const strategyFactory = async (): Promise<[Hypothesis, Hypothesis, Hypothesis]> => [
  { id: 'context', statement: 'isolate context', causalMechanism: 'context isolation', expectedEvidence: ['signal'], surface: 'contextPolicy' },
  { id: 'memory', statement: 'retrieve failures', causalMechanism: 'counterexample retrieval', expectedEvidence: ['novel attempt'], surface: 'retrievalPolicy' },
  { id: 'tests', statement: 'localize test', causalMechanism: 'test localization', expectedEvidence: ['smaller failure'], surface: 'testPolicy' },
];

function deterministicAction(context: VariationContext): VariationAction {
  const n = context.state.budget.actionsUsed;
  switch (n % 5) {
    case 0: return { kind: 'hypothesize', hypothesis: { id: `h-${n}`, statement: `try ${n}`, causalMechanism: 'bounded repair', expectedEvidence: ['receipt'], surface: 'repairStrategy' } };
    case 1: return { kind: 'inspect', path: 'src/index.ts' };
    case 2: return { kind: 'edit', path: 'repair.ts', content: `export const attempt = ${n};\n`, surface: 'repairStrategy' };
    case 3: return { kind: 'evaluate' };
    default: return { kind: 'consultMemory', query: `failure ${n}`, limit: 3 };
  }
}

async function memory(path: string) {
  return RvfGovernedMemory.create({
    path,
    embedder: {
      dimensions: 8,
      embed: async (text: string) => {
        const digest = createHash('sha256').update(text).digest();
        return Float32Array.from(Array.from({ length: 8 }, (_, index) => (digest[index] + 1) / 256));
      },
    },
  });
}

async function run(root: string, interrupted: boolean, signer: Ed25519ReceiptSigner): Promise<VariationResult> {
  const checkpointPath = join(root, 'checkpoint.json');
  const rvfPath = join(root, 'memory.rvf');
  const killed = new Set<number>();
  for (;;) {
    const governedMemory = await memory(rvfPath);
    const agent = {
      chooseAction: async (context: VariationContext) => {
        const n = context.state.budget.actionsUsed;
        if (interrupted && (n === 100 || n === 200) && !killed.has(n)) {
          killed.add(n);
          throw new Error(`simulated termination at ${n}`);
        }
        return deterministicAction(context);
      },
    };
    try {
      return await new GovernedVariationOperator({
        runId: 'resume-proof', task: 'prove deterministic interruption recovery',
        seed: { id: 'seed', branchId: 'seed', workspaceDigest: 'sha256:seed' },
        environment: new ReplayEnvironment(),
        evaluators: { version: 'resume-eval-v1', evaluate: async (branchId: string) => evaluation(branchId) },
        agent, knowledge: { retrieve: async () => [] }, memory: governedMemory,
        policy: new GovernedCapabilityPolicy({
          version: 'resume-policy-v1',
          allowedActions: ['hypothesize', 'inspect', 'edit', 'evaluate', 'consultMemory'],
          approvalActions: [], writablePaths: [/^repair\.ts$/],
        }),
        approval: { approve: async () => true },
        supervisor: new SemanticSupervisor({ policyVersion: 'resume-policy-v1' }, strategyFactory),
        signer, checkpointStore: new JsonCheckpointStore(checkpointPath),
        budget: { maxActions: MAX_ACTIONS, maxBranchActions: MAX_ACTIONS, maxCostUsd: 1, maxWallTimeMs: 10_000, riskBudget: 1 },
        invariants: { immutableCapabilities: ['bounded-read', 'bounded-repair'], protectedPaths: ['security/**'], promotionDelta: 0.01, requireSignedReceipts: true, requireZeroPolicyViolations: true },
        checkpointEveryActions: 1, now: () => '2026-08-21T00:00:00.000Z',
      }).run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('simulated termination')) throw error;
    }
  }
}

describe('RVF interruption and replay proof', () => {
  it('restores every 100 actions with an identical state hash and evaluator evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-rvf-resume-'));
    try {
      const keys = generateKeyPairSync('ed25519');
      const receiptSigner = new Ed25519ReceiptSigner('resume-key', keys.privateKey, keys.publicKey);
      const uninterrupted = await run(join(root, 'uninterrupted'), false, receiptSigner);
      const resumed = await run(join(root, 'resumed'), true, receiptSigner);
      expect(resumed.receipts).toHaveLength(MAX_ACTIONS);
      const divergence = resumed.receipts.findIndex((receipt, index) =>
        JSON.stringify(receipt) !== JSON.stringify(uninterrupted.receipts[index]));
      expect({
        divergence,
        resumed: divergence >= 0 ? resumed.receipts[divergence] : null,
        uninterrupted: divergence >= 0 ? uninterrupted.receipts[divergence] : null,
      }).toEqual({ divergence: -1, resumed: null, uninterrupted: null });
      expect(resumed.checkpoint.state.stateHash).toBe(uninterrupted.checkpoint.state.stateHash);
      expect(resumed.evaluatorEvidence).toEqual(uninterrupted.evaluatorEvidence);
      expect(resumed.lineage).toEqual(uninterrupted.lineage);
      expect(resumed.winner).toEqual(uninterrupted.winner);
      expect(resumed.receipts).toEqual(uninterrupted.receipts);
      expect(resumed.receipts.every((receipt) => receipt.policyDecision.verdict !== 'deny')).toBe(true);
      expect(resumed.receipts.every((receipt) => verifyReceipt(receipt, receiptSigner))).toBe(true);
      expect(resumed.checkpoint.rvfManifestPath).toMatch(/memory\.rvf\.manifest\.json$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
