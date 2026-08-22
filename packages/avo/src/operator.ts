// SPDX-License-Identifier: MIT

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

function failureObservation(reason: string, digest: string): ActionObservation {
  return { ok: false, stderr: reason, exitCode: 126, durationMs: 0, costUsd: 0, workspaceDigest: digest, failureSignature: reason };
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

function isAgentActionDecision(value: VariationAction | AgentActionDecision): value is AgentActionDecision {
  return Object.hasOwn(value, 'action');
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
        let agentDecision: AgentActionDecision | null = null;
        let action: VariationAction;
        if (isAgentActionDecision(selected)) {
          agentDecision = selected;
          action = selected.action;
        } else {
          action = selected;
        }
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

        if (decision.verdict === 'deny' || !approved) {
          observation = failureObservation(
            decision.verdict === 'deny' ? decision.reason : `approval denied: ${decision.reason}`,
            state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest,
          );
        } else if (action.kind === 'evaluate') {
          const parent = candidate.parentId ? this.archive.get(candidate.parentId)?.evaluation : undefined;
          evaluation = await this.options.evaluators.evaluate(state.currentBranchId, parent);
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
          if (!lastEvaluation || !qualifies(lastEvaluation, candidate.evaluation, this.options.invariants.promotionDelta)) {
            observation = failureObservation('promotion gate rejected commit', state.receipts.at(-1)?.workspaceDigest ?? candidate.workspaceDigest);
          } else {
            observation = await this.options.environment.execute(action, state);
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
            branchId: state.currentBranchId,
            workspaceDigest: observation.workspaceDigest,
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
        }

        const record = memoryRecord(state, action, observation, evaluation);
        await this.options.memory.buffer(record);
        state.memoryUpdates.push(record);
        state.memoryCursor = this.options.memory.cursor;
        if (!await this.options.memory.verify([record])) throw new Error('avo: structured memory persistence verification failed');
        if (state.budget.actionsUsed % this.checkpointEvery === 0) {
          await this.persist(state);
        }
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
      return structuredClone(saved.state);
    }
    const baselineEvaluation = await this.options.evaluators.evaluate(this.options.seed.branchId);
    const baseline: Candidate = {
      ...this.options.seed,
      parentId: null,
      evaluation: baselineEvaluation,
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
      evaluations: [baselineEvaluation],
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
      action: structuredClone(action),
      observation: structuredClone(observation),
      policyDecision: structuredClone(policyDecision),
      workspaceDigest: observation.workspaceDigest,
      costUsd: observation.costUsd,
      signature: this.options.signer.sign(stateHash),
      signer: this.options.signer.id,
    };
    const next = structuredClone(state);
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
