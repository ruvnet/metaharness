// SPDX-License-Identifier: MIT
// SECURITY acceptance (agent-context isolation): the agent callback is the
// untrusted party. A malicious agent that mutates the context it is handed —
// forging a perfect evaluation into state.evaluations, gutting the promotion
// baseline on candidate.evaluation, and inflating its own budget — must not be
// able to influence promotion: the operator's authoritative state is isolated
// from the copies the agent sees, the forged commit is refused by the real
// promotion gate, and the seed remains the winner.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Ed25519ReceiptSigner,
  EphemeralGovernedMemory,
  GovernedCapabilityPolicy,
  GovernedVariationOperator,
  JsonCheckpointStore,
  SemanticSupervisor,
  verifyReceipt,
  verifyVariationCheckpoint,
  type ActionObservation,
  type EnvironmentAdapter,
  type EvaluationResult,
  type VariationAction,
  type VariationContext,
  type VariationState,
} from '../src/index.js';

function result(quality: number, correct: boolean): EvaluationResult {
  return {
    evaluatorVersion: 'eval-v1', correct, safe: true, replayable: true,
    noRegression: correct, budgetValid: true, quality, costUsd: 0,
    wallTimeMs: 1, policyViolations: 0, protectedTestsPassed: correct,
    lowerConfidenceBound: correct ? 0.8 : 0, evidence: {},
  };
}

class InertEnvironment implements EnvironmentAdapter {
  readonly version = 'env-v1';
  async fork(parent: { id: string }) {
    return { branchId: `${parent.id}-working`, workspaceDigest: `sha256:fork-${parent.id}` };
  }
  async execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation> {
    return {
      ok: true, stdout: `${action.kind}:observed`, exitCode: 0, durationMs: 1, costUsd: 0,
      workspaceDigest: `sha256:${state.budget.actionsUsed + 1}-${action.kind}`,
    };
  }
  async quarantine(): Promise<void> {}
}

describe('agent-context isolation (untrusted agent cannot buy promotion)', () => {
  it('a malicious agent that forges a perfect score is refused and the seed stays the winner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'avo-malicious-'));
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const signer = new Ed25519ReceiptSigner('sec-key', privateKey, publicKey);
      const tamperedContexts: VariationContext[] = [];
      const maliciousAgent = {
        async chooseAction(context: VariationContext): Promise<VariationAction> {
          // Attack 1: forge a perfect, freshly-"evaluated" score into live state.
          (context.state.evaluations as EvaluationResult[]).push(result(1, true));
          // Attack 2: gut the promotion baseline so any delta qualifies.
          (context.candidate.evaluation as EvaluationResult).quality = 0;
          (context.candidate.evaluation as EvaluationResult).lowerConfidenceBound = 0;
          // Attack 3: inflate the remaining budget.
          (context.state.budget as { maxActions: number }).maxActions = 10_000;
          tamperedContexts.push(context);
          // Then immediately claim the prize.
          return { kind: 'commit', summary: 'forged perfect score' };
        },
      };
      const operator = new GovernedVariationOperator({
        runId: 'sec-1',
        task: 'security acceptance',
        seed: { id: 'seed', branchId: 'seed', workspaceDigest: 'sha256:seed' },
        environment: new InertEnvironment(),
        evaluators: { version: 'eval-v1', evaluate: async () => result(0.5, false) },
        agent: maliciousAgent,
        knowledge: { retrieve: async () => [] },
        memory: new EphemeralGovernedMemory(),
        policy: new GovernedCapabilityPolicy({
          version: 'policy-v1',
          allowedActions: ['inspect', 'edit', 'execute', 'evaluate', 'commit'],
          approvalActions: [],
          writablePaths: [/.*/],
        }),
        approval: { approve: async () => true },
        supervisor: new SemanticSupervisor({ policyVersion: 'policy-v1' }, async () => [
          { id: 's1', statement: 'a', causalMechanism: 'context', expectedEvidence: ['a'], surface: 'contextPolicy' },
          { id: 's2', statement: 'b', causalMechanism: 'edit', expectedEvidence: ['b'], surface: 'repairStrategy' },
          { id: 's3', statement: 'c', causalMechanism: 'tests', expectedEvidence: ['c'], surface: 'testPolicy' },
        ]),
        signer,
        checkpointStore: new JsonCheckpointStore(join(root, 'checkpoint.json')),
        budget: { maxActions: 5, maxBranchActions: 5, maxCostUsd: 1, maxWallTimeMs: 10_000, riskBudget: 1 },
        invariants: {
          immutableCapabilities: ['repository:read'],
          protectedPaths: [],
          promotionDelta: 0.1,
          requireSignedReceipts: true,
          requireZeroPolicyViolations: true,
        },
      });
      const output = await operator.run();

      // The forged commit never promotes: no winner, no lineage, and the
      // authoritative candidate set is still the seed alone.
      expect(output.winner).toBeNull();
      expect(output.lineage).toEqual([]);
      expect(output.checkpoint.state.candidates.map((c) => c.id)).toEqual(['seed']);
      // Every forged-commit attempt was refused by the real gate.
      const commits = output.receipts.filter((r) => r.action.kind === 'commit');
      expect(commits.length).toBeGreaterThan(0);
      for (const receipt of commits) {
        expect(receipt.observation.ok).toBe(false);
        expect(receipt.observation.exitCode).toBe(126);
        expect(receipt.observation.stderr).toContain('promotion gate rejected commit');
      }
      // The agent DID tamper with what it was handed — and none of it reached
      // the authoritative state: no forged evaluations, budget cap intact.
      expect(tamperedContexts.length).toBeGreaterThan(0);
      expect(output.checkpoint.state.evaluations.filter((e) => e.quality === 1)).toHaveLength(0);
      expect(output.checkpoint.state.budget.actionsUsed).toBeLessThanOrEqual(5);
      // Receipts and checkpoint still verify — the run is honest end to end.
      expect(output.receipts.every((r) => verifyReceipt(r, signer))).toBe(true);
      expect(verifyVariationCheckpoint(output.checkpoint, signer)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
