// SPDX-License-Identifier: MIT

import { Buffer } from 'node:buffer';
import { DarwinArchive, qualifies } from './archive.js';
import { createCheckpoint, verifyVariationCheckpoint } from './checkpoint.js';
import { sha256, transitionHash } from './crypto.js';
import type {
  ApprovalGate,
  AgentActionDecision,
  CapabilityPolicy,
  CheckpointStore,
  EnvironmentAdapter,
  EvaluatorSuite,
  GovernedMemory,
  KnowledgeBase,
  ReceiptSigner,
  Supervisor,
  VariationAgent,
} from './ports.js';
import type {
  ActionObservation,
  ActionReceipt,
  BudgetState,
  Candidate,
  EvaluationBinding,
  EvaluationResult,
  ProtectedInvariants,
  ResourceBudget,
  StructuredMemoryRecord,
  VariationAction,
  VariationCheckpoint,
  VariationContext,
  VariationResult,
  VariationState,
} from './types.js';

export interface SeedCandidate {
  id: string;
  branchId: string;
  workspaceDigest: string;
}

export interface VariationOperatorOptions {
  runId: string;
  task: string;
  seed: SeedCandidate;
  environment: EnvironmentAdapter;
  evaluators: EvaluatorSuite;
  agent: VariationAgent;
  knowledge: KnowledgeBase;
  memory: GovernedMemory;
  policy: CapabilityPolicy;
  approval: ApprovalGate;
  supervisor: Supervisor;
  signer: ReceiptSigner;
  checkpointStore: CheckpointStore;
  budget: ResourceBudget;
  invariants: ProtectedInvariants;
  runtimeVersion?: string;
  checkpointEveryActions?: number;
  rvfCheckpointEveryActions?: number;
  /** When true, stop the loop as soon as a committed candidate passes every
   *  promotion gate (the verified winner is captured and cannot change) — trades
   *  further population search for lower cost/latency. Default false (keep
   *  searching to the action budget). */
  stopOnVerifiedWinner?: boolean;
  now?: () => string;
}

export interface VariationOperator {
  run(): Promise<VariationResult>;
}

function budgetState(budget: ResourceBudget): BudgetState {
  return { ...budget, actionsUsed: 0, branchActionsUsed: 0, costUsdUsed: 0, wallTimeMsUsed: 0, riskUsed: 0 };
}

function budgetRemaining(budget: BudgetState): boolean {
  return budget.actionsUsed < budget.maxActions
    && budget.branchActionsUsed < budget.maxBranchActions
    && budget.costUsdUsed < budget.maxCostUsd
    && budget.wallTimeMsUsed < budget.maxWallTimeMs
    && budget.riskUsed <= budget.riskBudget;
}

export const STALE_EVALUATION_FAILURE = 'STALE_EVALUATION';
export const COMMIT_SNAPSHOT_FAILURE = 'COMMIT_SNAPSHOT_FAILED';

function failureObservation(
  reason: string,
  digest: string,
  failureSignature = reason,
): ActionObservation {
  return {
    ok: false,
    stderr: reason,
    exitCode: 126,
    durationMs: 0,
    costUsd: 0,
    workspaceDigest: digest,
    failureSignature,
  };
}

function currentWorkspaceDigest(state: VariationState, candidate: Candidate): string {
  return state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest;
}

function bindEvaluation(
  evaluation: EvaluationResult,
  binding: EvaluationBinding,
): EvaluationResult {
  return {
    ...structuredClone(evaluation),
    binding: Object.freeze({ ...binding }),
  };
}

function staleEvaluationReason(
  state: VariationState,
  candidate: Candidate,
  evaluation: EvaluationResult | undefined,
): string | null {
  const binding = evaluation?.binding;
  if (!binding) return 'commit requires a fresh operator-bound evaluation';
  if (binding.branchId !== state.currentBranchId) {
    return 'commit branch differs from the evaluated branch';
  }
  if (binding.sequence < 1 || binding.sequence > state.receipts.length) {
    return 'evaluation receipt sequence is missing or invalid';
  }
  const evaluationReceipt = state.receipts[binding.sequence - 1];
  if (!evaluationReceipt || evaluationReceipt.action.kind !== 'evaluate'
      || evaluationReceipt.previousStateHash !== binding.stateHash
      || evaluationReceipt.observation.workspaceDigest !== binding.workspaceDigest) {
    return 'evaluation binding does not match its receipt';
  }
  const invalidating = state.receipts
    .slice(binding.sequence)
    .find((receipt) => ['edit', 'execute', 'revert', 'branch'].includes(receipt.action.kind));
  if (invalidating) {
    return `commit follows invalidating ${invalidating.action.kind} action`;
  }
  if (binding.workspaceDigest !== currentWorkspaceDigest(state, candidate)) {
    return 'commit workspace differs from the evaluated workspace';
  }
  return null;
}

function memoryRecord(
  state: VariationState,
  action: VariationAction,
  observation: ActionObservation,
  evaluation?: EvaluationResult,
): StructuredMemoryRecord {
  const hypothesis = state.currentHypothesis ?? undefined;
  return {
    id: `${state.runId}/memory/${state.receipts.length + 1}`,
    type: evaluation ? (evaluation.correct ? 'evaluator-result' : 'counterexample') : action.kind === 'hypothesize' ? 'hypothesis' : 'tool-receipt',
    hypothesis,
    supportingObservations: observation.ok ? [observation.stdout ?? `${action.kind}:ok`] : [],
    contradictingObservations: observation.ok ? [] : [observation.stderr ?? `${action.kind}:failed`],
    actionsAttempted: [action.kind],
    evaluation,
    failureSignatures: observation.failureSignature ? [observation.failureSignature] : [],
    promotionDecision: evaluation ? 'pending-agent-commit' : undefined,
    rollbackDecision: action.kind === 'revert' ? 'reverted' : undefined,
    lineageReferences: [state.currentCandidateId, state.currentBranchId],
    costUsd: observation.costUsd,
    latencyMs: observation.durationMs,
  };
}

function assertCapabilitiesUnchanged(initial: readonly string[], current: readonly string[]): void {
  if (initial.length !== current.length || initial.some((value, index) => value !== current[index])) {
    throw new Error('avo: protected capability set changed during run');
  }
}

export const INVALID_AGENT_ACTION = 'avo: agent returned an invalid action';

const MAX_AGENT_JSON_DEPTH = 64;
const MAX_AGENT_JSON_NODES = 100_000;
const MAX_AGENT_JSON_STRING_BYTES = 8 * 1024 * 1024;
const MAX_AGENT_JSON_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_RETRIEVAL_LIMIT = 1_000;
const EVOLVABLE_SURFACES = new Set([
  'retrievalPolicy',
  'modelRouting',
  'contextPolicy',
  'testPolicy',
  'repairStrategy',
]);

interface JsonSnapshotState {
  readonly active: WeakSet<object>;
  nodes: number;
  bytes: number;
}

function chargeAgentString(value: string, state: JsonSnapshotState): void {
  const bytes = Buffer.byteLength(value, 'utf8');
  state.bytes += bytes;
  if (bytes > MAX_AGENT_JSON_STRING_BYTES || state.bytes > MAX_AGENT_JSON_TOTAL_BYTES) {
    throw new Error(INVALID_AGENT_ACTION);
  }
}

/**
 * Snapshot untrusted return values without invoking property getters. Only
 * values representable as finite, acyclic JSON are accepted. The fresh clone
 * is recursively frozen before any authority-bearing component can inspect it.
 */
function snapshotAgentJson(value: unknown, state: JsonSnapshotState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_AGENT_JSON_NODES || depth > MAX_AGENT_JSON_DEPTH) throw new Error(INVALID_AGENT_ACTION);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    chargeAgentString(value, state);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(INVALID_AGENT_ACTION);
    return value;
  }
  if (typeof value !== 'object') throw new Error(INVALID_AGENT_ACTION);

  if (state.active.has(value)) throw new Error(INVALID_AGENT_ACTION);
  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.getPrototypeOf(value) !== Array.prototype) throw new Error(INVALID_AGENT_ACTION);
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor) || typeof lengthDescriptor.value !== 'number'
          || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
          || lengthDescriptor.value > MAX_AGENT_JSON_NODES) {
        throw new Error(INVALID_AGENT_ACTION);
      }
      const length = lengthDescriptor.value as number;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string') return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key;
      })) {
        throw new Error(INVALID_AGENT_ACTION);
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error(INVALID_AGENT_ACTION);
        output.push(snapshotAgentJson(descriptor.value, state, depth + 1));
      }
      return Object.freeze(output);
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(INVALID_AGENT_ACTION);
    const output: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(INVALID_AGENT_ACTION);
      chargeAgentString(key, state);
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error(INVALID_AGENT_ACTION);
      Object.defineProperty(output, key, {
        value: snapshotAgentJson(descriptor.value, state, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(output);
  } finally {
    state.active.delete(value);
  }
}

function assertJsonRecord(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID_AGENT_ACTION);
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))
      || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(INVALID_AGENT_ACTION);
  }
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new Error(INVALID_AGENT_ACTION);
}

function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(INVALID_AGENT_ACTION);
}

function assertSurface(value: unknown): void {
  if (typeof value !== 'string' || !EVOLVABLE_SURFACES.has(value)) throw new Error(INVALID_AGENT_ACTION);
}

function assertHypothesis(value: unknown): void {
  assertJsonRecord(value);
  assertExactKeys(value, ['id', 'statement', 'causalMechanism', 'expectedEvidence', 'surface']);
  assertString(value.id);
  assertString(value.statement);
  assertString(value.causalMechanism);
  assertStringArray(value.expectedEvidence);
  assertSurface(value.surface);
}

function assertVariationAction(value: unknown): asserts value is VariationAction {
  assertJsonRecord(value);
  assertString(value.kind);
  switch (value.kind) {
    case 'inspect':
      assertExactKeys(value, ['kind', 'path']);
      assertString(value.path);
      return;
    case 'search':
      assertExactKeys(value, ['kind', 'query'], ['paths']);
      assertString(value.query);
      if (Object.hasOwn(value, 'paths')) assertStringArray(value.paths);
      return;
    case 'hypothesize':
      assertExactKeys(value, ['kind', 'hypothesis']);
      assertHypothesis(value.hypothesis);
      return;
    case 'edit':
      assertExactKeys(value, ['kind', 'path', 'content', 'surface']);
      assertString(value.path);
      assertString(value.content);
      assertSurface(value.surface);
      return;
    case 'execute':
      assertExactKeys(value, ['kind', 'command']);
      assertString(value.command);
      return;
    case 'evaluate':
      assertExactKeys(value, ['kind']);
      return;
    case 'revert':
      assertExactKeys(value, ['kind'], ['checkpointId']);
      if (Object.hasOwn(value, 'checkpointId')) assertString(value.checkpointId);
      return;
    case 'branch':
      assertExactKeys(value, ['kind', 'parentCandidateId']);
      assertString(value.parentCandidateId);
      return;
    case 'consultMemory':
      assertExactKeys(value, ['kind', 'query'], ['limit']);
      assertString(value.query);
      if (Object.hasOwn(value, 'limit')
          && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1
            || (value.limit as number) > MAX_MEMORY_RETRIEVAL_LIMIT)) {
        throw new Error(INVALID_AGENT_ACTION);
      }
      return;
    case 'commit':
      assertExactKeys(value, ['kind', 'summary']);
      assertString(value.summary);
      return;
    default:
      throw new Error(INVALID_AGENT_ACTION);
  }
}

function normalizeAgentSelection(selected: unknown): {
  action: VariationAction;
  agentDecision: AgentActionDecision | null;
} {
  try {
    const snapshot = snapshotAgentJson(selected, { active: new WeakSet(), nodes: 0, bytes: 0 });
    assertJsonRecord(snapshot);
    if (!Object.hasOwn(snapshot, 'action')) {
      assertVariationAction(snapshot);
      return { action: snapshot, agentDecision: null };
    }

    assertExactKeys(snapshot, ['action', 'costUsd', 'durationMs'], ['receipt']);
    assertVariationAction(snapshot.action);
    if (typeof snapshot.costUsd !== 'number' || snapshot.costUsd < 0
        || typeof snapshot.durationMs !== 'number' || snapshot.durationMs < 0) {
      throw new Error(INVALID_AGENT_ACTION);
    }
    if (Object.hasOwn(snapshot, 'receipt')) assertJsonRecord(snapshot.receipt);
    return {
      action: snapshot.action,
      agentDecision: snapshot as unknown as AgentActionDecision,
    };
  } catch {
    // Keep the public validation failure independent of a Proxy trap, getter,
    // engine error, or the particular field that failed validation.
    throw new Error(INVALID_AGENT_ACTION);
  }
}

export class GovernedVariationOperator implements VariationOperator {
  private readonly archive = new DarwinArchive();
  private readonly runtimeVersion: string;
  private readonly checkpointEvery: number;
  private readonly rvfCheckpointEvery: number;
  private readonly now: () => string;
  private readonly invariantHash: string;
  private readonly authorityVersions: readonly string[];

  constructor(private readonly options: VariationOperatorOptions) {
    this.runtimeVersion = options.runtimeVersion ?? '0.1.0';
    this.checkpointEvery = Math.max(1, options.checkpointEveryActions ?? 1);
    this.rvfCheckpointEvery = Math.max(1, options.rvfCheckpointEveryActions ?? 100);
    this.now = options.now ?? (() => new Date().toISOString());
    this.invariantHash = sha256(options.invariants);
    this.authorityVersions = [options.policy.version, options.evaluators.version, options.environment.version];
  }

  async run(): Promise<VariationResult> {
    let state = await this.restoreOrInitialize();
    const protectedCapabilities = [...this.options.invariants.immutableCapabilities];
    for (const candidate of state.candidates) this.archive.insert(candidate);

    let verifiedWinnerCommitted = false;
    try {
      while (budgetRemaining(state.budget)) {
        assertCapabilitiesUnchanged(protectedCapabilities, this.options.invariants.immutableCapabilities);
        if (sha256(this.options.invariants) !== this.invariantHash) throw new Error('avo: protected invariants changed during run');
        if (this.authorityVersions.some((version, index) => version !== [this.options.policy.version, this.options.evaluators.version, this.options.environment.version][index])) {
          throw new Error('avo: policy, evaluator, or environment version changed during run');
        }
        const candidate = this.archive.get(state.currentCandidateId);
        if (!candidate) throw new Error(`avo: missing current candidate ${state.currentCandidateId}`);
        const memories = await this.options.memory.retrieve(
          `${this.options.task}\n${state.currentHypothesis?.statement ?? ''}`,
          8,
        );
        const knowledge = await this.options.knowledge.retrieve(this.options.task, 8);
        // SECURITY: the agent is the UNTRUSTED party. `Readonly<>` is compile-time
        // only, so handing it the live state/candidate would let a malicious agent
        // mutate its own evaluation (or the promotion baseline) and be committed
        // with signed receipts. It gets deep copies; authority stays in here.
        const context: VariationContext = {
          task: this.options.task,
          state: structuredClone(state),
          candidate: structuredClone(candidate),
          recentObservations: structuredClone(state.receipts.slice(-8).map((receipt) => receipt.observation)),
          memories: structuredClone(memories),
          knowledge: structuredClone(knowledge),
          allowedSurfaces: ['retrievalPolicy', 'modelRouting', 'contextPolicy', 'testPolicy', 'repairStrategy'],
        };
        const selected = await this.options.agent.chooseAction(context);
        const { action, agentDecision } = normalizeAgentSelection(selected);
        let decision = this.options.policy.authorize(action, state);
        if (action.kind === 'edit' && this.options.invariants.protectedPaths.some((pattern) => protectedPathMatches(pattern, action.path))) {
          decision = {
            verdict: 'deny', reason: `protected invariant path cannot be edited: ${action.path}`,
            policyVersion: this.options.policy.version, riskCharge: 0,
          };
        }
        const approved = decision.verdict === 'allow'
          || (decision.verdict === 'require-approval' && await this.options.approval.approve(action, decision));
        let observation: ActionObservation;
        let evaluation: EvaluationResult | undefined;
        let committedSnapshot: { branchId: string; workspaceDigest: string } | undefined;

        if (decision.verdict === 'deny' || !approved) {
          observation = failureObservation(
            decision.verdict === 'deny' ? decision.reason : `approval denied: ${decision.reason}`,
            state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest,
          );
        } else if (action.kind === 'evaluate') {
          const parent = candidate.parentId ? this.archive.get(candidate.parentId)?.evaluation : undefined;
          const evaluatedStateHash = state.stateHash;
          const evaluatedWorkspaceDigest = currentWorkspaceDigest(state, candidate);
          const rawEvaluation = await this.options.evaluators.evaluate(state.currentBranchId, parent);
          evaluation = bindEvaluation(rawEvaluation, {
            branchId: state.currentBranchId,
            workspaceDigest: evaluatedWorkspaceDigest,
            stateHash: evaluatedStateHash,
            sequence: state.receipts.length + 1,
          });
          observation = {
            ok: evaluation.correct && evaluation.safe,
            durationMs: evaluation.wallTimeMs,
            costUsd: evaluation.costUsd,
            workspaceDigest: state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest,
            data: evaluation,
            failureSignature: evaluation.failureSignature,
          };
        } else if (action.kind === 'consultMemory') {
          const found = await this.options.memory.retrieve(action.query, action.limit ?? 8);
          observation = {
            ok: true,
            durationMs: 0,
            costUsd: 0,
            workspaceDigest: state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest,
            data: found,
          };
        } else if (action.kind === 'branch') {
          const selected = this.archive.get(action.parentCandidateId);
          if (!selected) {
            observation = failureObservation(`unknown archive candidate: ${action.parentCandidateId}`, candidate.workspaceDigest);
          } else {
            const branch = await this.options.environment.fork(selected);
            observation = {
              ok: true,
              durationMs: 0,
              costUsd: 0,
              workspaceDigest: branch.workspaceDigest,
              data: branch,
            };
          }
        } else if (action.kind === 'commit') {
          const lastEvaluation = state.evaluations.at(-1);
          const staleReason = staleEvaluationReason(state, candidate, lastEvaluation);
          if (staleReason) {
            observation = failureObservation(
              `promotion gate rejected commit: stale evaluation: ${staleReason}`,
              currentWorkspaceDigest(state, candidate),
              STALE_EVALUATION_FAILURE,
            );
          } else if (!qualifies(lastEvaluation!, candidate.evaluation, this.options.invariants.promotionDelta)) {
            observation = failureObservation('promotion gate rejected commit', state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest);
          } else {
            observation = await this.options.environment.execute(action, state);
            const evaluatedDigest = lastEvaluation!.binding!.workspaceDigest;
            if (observation.ok && observation.workspaceDigest !== evaluatedDigest) {
              observation = failureObservation(
                'stale evaluation: commit changed or observed a different workspace',
                observation.workspaceDigest,
                STALE_EVALUATION_FAILURE,
              );
            } else if (observation.ok) {
              const promotedId = `${state.runId}/candidate/${state.candidates.length}`;
              try {
                committedSnapshot = await this.options.environment.fork({
                  ...candidate,
                  id: promotedId,
                  branchId: state.currentBranchId,
                  workspaceDigest: evaluatedDigest,
                  evaluation: lastEvaluation!,
                });
              } catch {
                observation = failureObservation(
                  'commit snapshot creation failed',
                  evaluatedDigest,
                  COMMIT_SNAPSHOT_FAILURE,
                );
              }
              if (committedSnapshot && committedSnapshot.workspaceDigest !== evaluatedDigest) {
                committedSnapshot = undefined;
                observation = failureObservation(
                  'commit snapshot digest differs from the evaluated workspace',
                  evaluatedDigest,
                  COMMIT_SNAPSHOT_FAILURE,
                );
              } else if (committedSnapshot?.branchId === state.currentBranchId) {
                committedSnapshot = undefined;
                observation = failureObservation(
                  'commit snapshot aliases the mutable working branch',
                  evaluatedDigest,
                  COMMIT_SNAPSHOT_FAILURE,
                );
              }
            }
          }
        } else {
          observation = await this.options.environment.execute(action, state);
        }

        if (agentDecision) {
          observation = {
            ...observation,
            costUsd: observation.costUsd + agentDecision.costUsd,
            durationMs: observation.durationMs + agentDecision.durationMs,
            data: {
              execution: observation.data,
              agentReceipt: agentDecision.receipt ?? null,
            },
          };
        }

        state = await this.transition(state, action, observation, decision, evaluation);

        if (evaluation) {
          const violates = !evaluation.safe
            || !evaluation.protectedTestsPassed
            || (this.options.invariants.requireZeroPolicyViolations && evaluation.policyViolations > 0);
          if (violates) {
            await this.options.environment.quarantine(state.currentBranchId, evaluation.failureSignature ?? 'protected invariant failed');
            state.rejectedLessons.push(memoryRecord(state, action, observation, evaluation));
          }
          const intervention = await this.options.supervisor.observe(state);
          if (intervention) state.interventions.push(intervention);
        }

        if (action.kind === 'hypothesize' && observation.ok) state.currentHypothesis = action.hypothesis;
        if (action.kind === 'branch' && observation.ok) {
          state.currentCandidateId = action.parentCandidateId;
          const branch = observation.data as { branchId: string; workspaceDigest: string };
          state.currentBranchId = branch.branchId;
          state.budget.branchActionsUsed = 0;
          await this.options.memory.branch(branch.branchId);
        }
        if (action.kind === 'revert' && observation.ok) await this.options.memory.rollback(action.checkpointId);
        if (action.kind === 'commit' && observation.ok) {
          const evaluationResult = state.evaluations.at(-1)!;
          const promoted: Candidate = {
            id: `${state.runId}/candidate/${state.candidates.length}`,
            parentId: candidate.id,
            branchId: committedSnapshot!.branchId,
            workspaceDigest: committedSnapshot!.workspaceDigest,
            evaluation: evaluationResult,
            novelty: 1 / (1 + state.candidates.filter((value) => value.parentId === candidate.id).length),
            visits: 0,
            learningPotential: evaluationResult.correct ? 0.5 : 1,
            risk: evaluationResult.policyViolations,
            committed: true,
          };
          this.archive.insert(promoted);
          state.candidates.push(promoted);
          state.currentCandidateId = promoted.id;
          await this.options.memory.consolidate();
          verifiedWinnerCommitted = true;
        }

        const record = memoryRecord(state, action, observation, evaluation);
        await this.options.memory.buffer(record);
        state.memoryUpdates.push(record);
        state.memoryCursor = this.options.memory.cursor;
        if (!await this.options.memory.verify([record])) throw new Error('avo: structured memory persistence verification failed');
        if (state.budget.actionsUsed % this.checkpointEvery === 0) {
          await this.persist(state);
        }
        // Early-stop: once a commit passes the promotion gate (a candidate that
        // improves on its parent and satisfies every gate), the verified winner is
        // captured and cannot change — continuing only burns actions/cost.
        if (this.options.stopOnVerifiedWinner === true && verifiedWinnerCommitted) break;
      }

      const checkpoint = await this.persist(state, true);
      const winner = this.archive.bestVerified();
      return {
        winner,
        lineage: winner ? this.lineage(winner.id) : [],
        receipts: state.receipts,
        evaluatorEvidence: state.evaluations,
        memoryUpdates: state.memoryUpdates,
        checkpoint,
        failureReport: state.candidates.length > 1
          ? undefined
          : 'No variation satisfied correctness, safety, replay, regression, budget, improvement, and protected-test gates; the verified seed remains the winner.',
      };
    } finally {
      await this.options.memory.close();
    }
  }

  private async restoreOrInitialize(): Promise<VariationState> {
    const saved = await this.options.checkpointStore.load();
    if (saved) {
      if (!verifyVariationCheckpoint(saved, this.options.signer)) throw new Error('avo: checkpoint signature/hash mismatch');
      // Schema 1 checkpoints written before EvaluationBinding remain valid and
      // load unchanged. Their unbound evidence is deliberately ineligible for
      // promotion, so the resumed agent must evaluate the current branch again.
      return structuredClone(saved.state);
    }
    const baselineEvaluation = await this.options.evaluators.evaluate(this.options.seed.branchId);
    const baseline: Candidate = {
      ...this.options.seed,
      parentId: null,
      evaluation: bindEvaluation(baselineEvaluation, {
        branchId: this.options.seed.branchId,
        workspaceDigest: this.options.seed.workspaceDigest,
        stateHash: `genesis:${this.options.runId}`,
        sequence: 0,
      }),
      novelty: 1,
      visits: 0,
      learningPotential: baselineEvaluation.correct ? 0.5 : 1,
      risk: baselineEvaluation.policyViolations,
      committed: true,
    };
    this.archive.insert(baseline);
    const working = await this.options.environment.fork(baseline);
    const state: VariationState = {
      schema: 1,
      runId: this.options.runId,
      task: this.options.task,
      stateHash: `genesis:${this.options.runId}`,
      currentCandidateId: baseline.id,
      currentBranchId: working.branchId,
      currentHypothesis: null,
      receipts: [],
      evaluations: [baseline.evaluation],
      candidates: [baseline],
      memoryUpdates: [],
      rejectedLessons: [],
      interventions: [],
      budget: budgetState(this.options.budget),
      memoryCursor: this.options.memory.cursor,
      pendingApprovals: [],
      startedAt: this.now(),
    };
    await this.options.memory.branch(working.branchId);
    await this.persist(state);
    return state;
  }

  private async transition(
    state: VariationState,
    action: VariationAction,
    observation: ActionObservation,
    policyDecision: ActionReceipt['policyDecision'],
    evaluation?: EvaluationResult,
  ): Promise<VariationState> {
    const previousStateHash = state.stateHash;
    const stateHash = transitionHash({ previousStateHash, action, observation, policyDecision, workspaceDigest: observation.workspaceDigest });
    const receipt: ActionReceipt = {
      sequence: state.receipts.length + 1,
      previousStateHash,
      stateHash,
      action,
      observation: structuredClone(observation),
      policyDecision: structuredClone(policyDecision),
      workspaceDigest: observation.workspaceDigest,
      costUsd: observation.costUsd,
      signature: this.options.signer.sign(stateHash),
      signer: this.options.signer.id,
    };
    const next = structuredClone(state);
    // Preserve the already-normalized, frozen actions rather than thawing them
    // through structuredClone on every transition.
    next.receipts = [...state.receipts];
    next.stateHash = stateHash;
    next.receipts.push(receipt);
    if (evaluation) next.evaluations.push(structuredClone(evaluation));
    next.budget.actionsUsed += 1;
    next.budget.branchActionsUsed += 1;
    next.budget.costUsdUsed += observation.costUsd;
    next.budget.wallTimeMsUsed += observation.durationMs;
    next.budget.riskUsed += policyDecision.riskCharge;
    return next;
  }

  private async persist(state: VariationState, packageRvf = false): Promise<VariationCheckpoint> {
    if (state.budget.actionsUsed === 0
      || state.budget.actionsUsed % this.rvfCheckpointEvery === 0
      || packageRvf) {
      await this.options.memory.checkpoint(`action-${state.budget.actionsUsed}`);
    }
    let checkpoint = createCheckpoint({
      runtimeVersion: this.runtimeVersion,
      policyVersion: this.options.policy.version,
      evaluatorVersion: this.options.evaluators.version,
      state,
      signer: this.options.signer,
    });
    if (packageRvf) {
      const path = await this.options.memory.packageCheckpoint(checkpoint);
      checkpoint = { ...checkpoint, rvfManifestPath: path };
    }
    await this.options.checkpointStore.save(checkpoint);
    return checkpoint;
  }

  private lineage(id: string): Candidate[] {
    const output: Candidate[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const candidate = this.archive.get(cursor);
      if (!candidate) break;
      output.push(candidate);
      cursor = candidate.parentId;
    }
    return output.reverse();
  }
}

function protectedPathMatches(pattern: string, path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const escaped = pattern.replaceAll('\\', '/').replace(/^\.\//, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`).test(normalized);
}
