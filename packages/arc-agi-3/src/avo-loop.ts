import { ArcController } from './controller.js';
import {
  ArcValidationError,
  containsRawGameIdentityKey,
  hashArcValue,
  snapshotArcJson,
} from './canonical.js';
import { resolveArcAvoConfig } from './avo-config.js';
import { ArcPlanArchive } from './plan-archive.js';
import { EvidenceRetrodictiveWorldModel } from './world-model.js';
import { verifyArcCheckpoint } from './checkpoint.js';
import { TRANSITION_RECEIPT_GENESIS } from './receipts.js';
import type {
  ArcAvoCheckpoint,
  ArcAvoCheckpointBody,
  ArcAvoContext,
  ArcAvoLoopApi,
  ArcAvoLoopOptions,
  ArcAvoStepResult,
  ArcCandidatePlan,
  ArcCandidatePlanDraft,
  ArcRetrodiction,
  ArcRetrodictionVerdict,
  ArcRuleHypothesisDraft,
} from './avo-types.js';
import type {
  ActResult,
  SemanticRule,
  SemanticRuleCommit,
  SupervisorDirective,
  SupervisorDirectiveCommit,
} from './types.js';

const HEX_HASH = /^[0-9a-f]{64}$/;
const EXTERNAL_PLANNER_VERSION = 'external-candidates-v1';
const MAX_AVO_CHECKPOINT_JSON_NODES = 4_000_000;
const AVO_CHECKPOINT_BODY_KEYS = new Set([
  'schema',
  'config',
  'plannerVersion',
  'supervisorVersion',
  'observationHash',
  'coreReceiptBaselineCount',
  'coreReceiptBaselineHeadHash',
  'coreCheckpoint',
  'archive',
  'worldModel',
]);
const AVO_CHECKPOINT_BODY_REQUIRED_KEYS = new Set([
  'schema',
  'config',
  'plannerVersion',
  'observationHash',
  'coreReceiptBaselineCount',
  'coreReceiptBaselineHeadHash',
  'coreCheckpoint',
  'archive',
  'worldModel',
]);
const AVO_CHECKPOINT_KEYS = new Set([
  ...AVO_CHECKPOINT_BODY_KEYS,
  'checkpointHash',
]);
const AVO_CHECKPOINT_REQUIRED_KEYS = new Set([
  ...AVO_CHECKPOINT_BODY_REQUIRED_KEYS,
  'checkpointHash',
]);

function assertExactCheckpointRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ArcValidationError('INVALID_AVO_CHECKPOINT', `${label} must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !('value' in Object.getOwnPropertyDescriptor(value, key)!)) ||
      [...required].some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ArcValidationError(
      'INVALID_AVO_CHECKPOINT',
      `${label} fields do not match the exact schema`,
    );
  }
}

function boundedVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 ||
      /[\u0000-\u001f]/.test(value)) {
    throw new ArcValidationError('INVALID_AVO_OPTIONS', `${label} version is invalid`);
  }
  return value.trim();
}

function latestRules(rules: readonly SemanticRule[]): Map<string, SemanticRule> {
  const latest = new Map<string, SemanticRule>();
  for (const rule of rules) {
    const prior = latest.get(rule.id);
    if (!prior || prior.version < rule.version) latest.set(rule.id, rule);
  }
  return latest;
}

function stableJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'value is not JSON serializable');
  }
  return snapshotArcJson(
    JSON.parse(encoded),
    MAX_AVO_CHECKPOINT_JSON_NODES,
  ) as unknown as T;
}

/**
 * ARC-specific AVO controller. It owns planning evidence and delegates the only
 * environment mutation to a private ArcController.
 */
export class ArcAvoLoop implements ArcAvoLoopApi {
  readonly #controller: ArcController;
  readonly #ownsController: boolean;
  readonly #config: import('./avo-types.js').ArcAvoConfig;
  readonly #planner: ArcAvoLoopOptions['planner'];
  readonly #supervisor: ArcAvoLoopOptions['supervisor'];
  readonly #plannerVersion: string;
  readonly #supervisorVersion?: string;
  readonly #worldModel: EvidenceRetrodictiveWorldModel;
  #archive?: ArcPlanArchive;
  #observation?: ActResult['observation'];
  #coreReceiptBaselineCount?: number;
  #coreReceiptBaselineHeadHash?: string;
  #mutationTail: Promise<void> = Promise.resolve();
  #closePromise?: Promise<void>;

  constructor(options: ArcAvoLoopOptions) {
    if (!options || typeof options !== 'object') {
      throw new ArcValidationError('INVALID_AVO_OPTIONS', 'AVO loop options are required');
    }
    this.#config = resolveArcAvoConfig(options.config);
    const hasController = options.controller !== undefined;
    const hasOptions = options.controllerOptions !== undefined;
    if (hasController === hasOptions) {
      throw new ArcValidationError(
        'INVALID_AVO_OPTIONS',
        'supply exactly one of controller or controllerOptions',
      );
    }
    if (options.controller) {
      if (options.controller.supervisionGateMode !== this.#config.features.supervisorGate) {
        throw new ArcValidationError(
          'INVALID_AVO_OPTIONS',
          'injected controller supervision gate differs from the AVO feature profile',
        );
      }
      this.#controller = options.controller;
      this.#ownsController = false;
    } else {
      const controllerOptions = options.controllerOptions!;
      if (controllerOptions.supervisionGate !== undefined &&
          controllerOptions.supervisionGate !== this.#config.features.supervisorGate) {
        throw new ArcValidationError(
          'INVALID_AVO_OPTIONS',
          'controller supervision gate differs from the AVO feature profile',
        );
      }
      this.#controller = new ArcController({
        ...controllerOptions,
        supervisionGate: this.#config.features.supervisorGate,
      });
      this.#ownsController = true;
    }
    this.#planner = options.planner;
    this.#supervisor = options.supervisor;
    this.#plannerVersion = options.planner
      ? boundedVersion(options.planner.version, 'planner')
      : EXTERNAL_PLANNER_VERSION;
    this.#supervisorVersion = options.supervisor
      ? boundedVersion(options.supervisor.version, 'supervisor')
      : undefined;
    this.#worldModel = new EvidenceRetrodictiveWorldModel(this.#config);
  }

  async start(): Promise<ArcAvoContext> {
    return this.#withMutation(async () => {
      if (!this.#observation) {
        this.#observation = await this.#controller.start();
        this.#captureCoreReceiptBaseline();
        this.#archive = this.#newArchive();
      }
      return this.context();
    });
  }

  context(): ArcAvoContext {
    const observation = this.#requireObservation();
    const archive = this.#requireArchive();
    const memory = this.#config.features.semanticRuleMemory
      ? this.#controller.queryMemory({ limit: 128 })
      : Object.freeze({ episodes: Object.freeze([]), rules: Object.freeze([]) });
    const frontier = this.#config.features.beliefFrontier
      ? this.#controller.graphFrontier(32)
      : Object.freeze([]);
    return Object.freeze({
      config: this.#config,
      observation,
      status: this.#controller.status(),
      memory,
      frontier,
      ...(archive.currentLineageHeadId === undefined
        ? {}
        : { lineageHeadId: archive.currentLineageHeadId }),
      recentCandidates: archive.recentCandidates(),
      recentOutcomes: archive.recentOutcomes(),
      recentRetrodictions: this.#config.features.retrodictiveWorldModel
        ? this.#worldModel.recent()
        : Object.freeze([]),
    });
  }

  async step(): Promise<ArcAvoStepResult> {
    return this.#withMutation(async () => {
      if (!this.#planner) {
        throw new ArcValidationError(
          'PLANNER_UNAVAILABLE',
          'this AVO loop requires externally supplied candidate plans',
        );
      }
      this.#assertVersionsStable();
      await this.#resolveSupervisorGate();
      const plannerContext = structuredClone(this.context());
      const proposed = await this.#planner.propose(plannerContext);
      let stable: readonly ArcCandidatePlanDraft[];
      try {
        stable = snapshotArcJson(proposed) as unknown as readonly ArcCandidatePlanDraft[];
      } catch {
        throw new ArcValidationError(
          'INVALID_CANDIDATE_BATCH',
          'planner returned non-JSON candidate plans',
        );
      }
      return this.#stepCritical(stable);
    });
  }

  stepWithCandidates(
    candidates: readonly ArcCandidatePlanDraft[],
  ): Promise<ArcAvoStepResult> {
    let stable: readonly ArcCandidatePlanDraft[];
    try {
      // Snapshot before entering the async mutation queue. A caller cannot edit
      // a queued proposal while an earlier transition is still completing.
      stable = snapshotArcJson(candidates) as unknown as readonly ArcCandidatePlanDraft[];
    } catch {
      return Promise.reject(new ArcValidationError(
        'INVALID_CANDIDATE_BATCH',
        'candidate plans must be strict acyclic JSON',
      ));
    }
    return this.#withMutation(async () => {
      this.#assertVersionsStable();
      await this.#resolveSupervisorGate();
      return this.#stepCritical(stable);
    });
  }

  async checkpoint(): Promise<ArcAvoCheckpoint> {
    return this.#withMutation(async () => {
      const observation = this.#requireObservation();
      const coreCheckpoint = await this.#controller.checkpoint();
      const rawBody = {
        schema: 'metaharness.arc_agi_3.avo_checkpoint.v1' as const,
        config: this.#config,
        plannerVersion: this.#plannerVersion,
        ...(this.#supervisorVersion === undefined
          ? {}
          : { supervisorVersion: this.#supervisorVersion }),
        observationHash: observation.observationHash,
        coreReceiptBaselineCount: this.#requireCoreReceiptBaselineCount(),
        coreReceiptBaselineHeadHash: this.#requireCoreReceiptBaselineHeadHash(),
        coreCheckpoint,
        archive: this.#requireArchive().snapshot(),
        worldModel: this.#worldModel.snapshot(),
      };
      const body = stableJson(rawBody) as ArcAvoCheckpointBody;
      const checkpoint = Object.freeze({ ...body, checkpointHash: hashArcValue(body) });
      this.#verifyCheckpointBindings(checkpoint);
      return checkpoint;
    });
  }

  async resume(checkpoint: ArcAvoCheckpoint): Promise<ArcAvoContext> {
    return this.#withMutation(async () => {
      if (this.#observation || this.#archive) {
        throw new ArcValidationError('ALREADY_STARTED', 'AVO resume requires a fresh loop');
      }
      const stable = this.#verifyCheckpoint(checkpoint);
      const archive = this.#newArchive();
      archive.load(stable.archive);
      const worldModel = new EvidenceRetrodictiveWorldModel(this.#config);
      worldModel.load(stable.worldModel);
      this.#verifyCheckpointBindings(stable);
      const observation = await this.#controller.resume(stable.coreCheckpoint);
      if (observation.observationHash !== stable.observationHash) {
        throw new ArcValidationError(
          'INVALID_AVO_CHECKPOINT',
          'AVO checkpoint observation differs from the resumed core',
        );
      }
      this.#archive = archive;
      this.#worldModel.load(worldModel.snapshot());
      this.#observation = observation;
      this.#coreReceiptBaselineCount = stable.coreReceiptBaselineCount;
      this.#coreReceiptBaselineHeadHash = stable.coreReceiptBaselineHeadHash;
      return this.context();
    });
  }

  status(): ReturnType<ArcController['status']> {
    return this.#controller.status();
  }

  asSupervisor(): ReturnType<ArcController['asSupervisor']> {
    return this.#controller.asSupervisor();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#withMutation(async () => {
      if (this.#ownsController) await this.#controller.close();
    });
    return this.#closePromise;
  }

  async #stepCritical(
    drafts: readonly ArcCandidatePlanDraft[],
  ): Promise<ArcAvoStepResult> {
    const observation = this.#requireObservation();
    const archive = this.#requireArchive();
    if (archive.outcomeCount >= this.#controller.status().maxActions) {
      throw new ArcValidationError(
        'AVO_DECISION_BUDGET_EXHAUSTED',
        'AVO decision archive reached the frozen controller action budget',
      );
    }
    const allMemory = this.#controller.queryMemory({ limit: 1_000 });
    const cognitiveRules = this.#config.features.semanticRuleMemory ? allMemory.rules : [];
    const candidates = archive.addCandidates(drafts, {
      observation,
      rules: cognitiveRules,
    });
    const rejectionCodes: Record<string, string> = {};
    for (const candidate of candidates) {
      const first = candidate.steps[0]!;
      const preview = this.#controller.previewActionLegality(first.action);
      if (!preview.legal) rejectionCodes[candidate.id] = preview.code;
      else if (first.directiveId !== undefined && first.directiveId !== preview.directiveId) {
        rejectionCodes[candidate.id] = 'STALE_DIRECTIVE';
      }
    }
    const frontier = this.#config.features.beliefFrontier
      ? this.#controller.graphFrontier(256)
      : Object.freeze([]);
    let selection: import('./avo-types.js').ArcPlanSelection;
    try {
      selection = archive.select(candidates, {
        observation,
        frontier,
        // Receipted transition outcomes are authoritative selector evidence in
        // every selection arm; semanticRuleMemory gates only cognitive rules.
        episodes: allMemory.episodes,
        rules: cognitiveRules,
        retrodictions: this.#config.features.retrodictiveWorldModel
          ? this.#worldModel.recent(1_000)
          : [],
      }, rejectionCodes);
    } catch (error) {
      archive.rollbackUnselectedCandidates(candidates);
      throw error;
    }
    const candidate = archive.candidate(selection.selectedCandidateId)!;
    const completed: ActResult[] = [];
    const updatedRules: SemanticRule[] = [];
    const retrodictions: ArcRetrodiction[] = [];
    let stopReason: 'COMPLETED' | 'DIVERGED' | 'ACTION_REJECTED' = 'COMPLETED';
    const appendFailureOutcome = (): void => {
      archive.appendOutcome({
        candidateId: candidate.id,
        selectionHash: selection.selectionHash,
        coreReceiptHashes: Object.freeze(completed.map(result => result.receipt.receiptHash)),
        retrodictionHashes: Object.freeze(retrodictions.map(record => record.retrodictionHash)),
        stopReason: 'ACTION_REJECTED',
      });
    };
    const stepCount = this.#config.features.guardedExecution ? candidate.steps.length : 1;
    for (let index = 0; index < stepCount; index += 1) {
      try {
        // Re-evaluate supervision between every irreversible action. A case
        // opened by step N can never be crossed by step N+1 inside one plan.
        if (index > 0) await this.#resolveSupervisorGate();
        const activeDirectiveId = this.#controller.status().activeDirectiveId;
        const source = candidate.steps[index]!;
        if (source.directiveId !== undefined && source.directiveId !== activeDirectiveId) {
          throw new ArcValidationError(
            'PLAN_SELECTION_MISMATCH',
            'candidate carries a stale or foreign supervisor directive',
          );
        }
        const { directiveId: _ignored, ...body } = source;
        const step = Object.freeze({
          ...body,
          ...(activeDirectiveId === undefined ? {} : { directiveId: activeDirectiveId }),
        });
        let actionResult: ActResult;
        if (this.#config.features.guardedExecution) {
          const guarded = await this.#controller.executeGuardedPlan({
            planId: `${selection.selectionHash}:${index}`,
            steps: [step],
          });
          if (guarded.completed.length === 0) {
            stopReason = 'ACTION_REJECTED';
            break;
          }
          actionResult = guarded.completed[0]!;
          if (guarded.stopReason === 'DIVERGED') stopReason = 'DIVERGED';
        } else {
          actionResult = await this.#controller.act({
            expectedObservationHash: step.expectedObservationHash,
            idempotencyKey: step.idempotencyKey,
            action: step.action,
            expectation: step.expectation,
            ...(step.directiveId === undefined ? {} : { directiveId: step.directiveId }),
          });
        }
        completed.push(actionResult);
        // Publish irreversible environment truth before fallible semantic or
        // world-model postprocessing. A terminal observation cannot be lost.
        this.#observation = actionResult.observation;
        const verdict = this.#config.features.retrodictiveWorldModel
          ? this.#worldModel.classify(actionResult.receipt.predictionError)
          : undefined;
        const rules = await this.#persistRuleEvidence(candidate, actionResult, verdict, index);
        updatedRules.push(...rules);
        if (this.#config.features.retrodictiveWorldModel) {
          const ids = rules.map(rule => rule.id);
          retrodictions.push(this.#worldModel.append({
            selectionHash: selection.selectionHash,
            candidateId: candidate.id,
            coreReceiptHash: actionResult.receipt.receiptHash,
            action: actionResult.receipt.action,
            predictionError: actionResult.receipt.predictionError,
            supportedRuleIds: verdict === 'SUPPORTED' ? ids : [],
            contradictedRuleIds: verdict === 'CONTRADICTED' ? ids : [],
          }));
        }
        if (stopReason === 'DIVERGED' || actionResult.observation.state === 'WIN') break;
      } catch (error) {
        if (completed.length > 0 && error instanceof ArcValidationError &&
            error.code === 'SUPERVISION_REQUIRED') {
          // The prior transition is irreversible. Return a successful partial
          // result so transport idempotency can replay it without re-running
          // the stale batch; the next fresh decision enters the boss lane.
          stopReason = 'ACTION_REJECTED';
          break;
        }
        appendFailureOutcome();
        throw error;
      }
    }
    archive.appendOutcome({
      candidateId: candidate.id,
      selectionHash: selection.selectionHash,
      coreReceiptHashes: Object.freeze(completed.map(result => result.receipt.receiptHash)),
      retrodictionHashes: Object.freeze(retrodictions.map(record => record.retrodictionHash)),
      stopReason,
    });
    return Object.freeze({
      selection,
      candidate,
      completed: Object.freeze(completed),
      stopReason,
      retrodictions: Object.freeze(retrodictions),
      updatedRules: Object.freeze(updatedRules),
      context: this.context(),
    });
  }

  async #persistRuleEvidence(
    candidate: ArcCandidatePlan,
    result: ActResult,
    verdict: ArcRetrodictionVerdict | undefined,
    resultIndex: number,
  ): Promise<readonly SemanticRule[]> {
    if (!this.#config.features.semanticRuleMemory) return Object.freeze([]);
    const receiptHash = result.receipt.receiptHash;
    if (!this.#config.features.retrodictiveWorldModel) {
      // The NVIDIA-inspired AVO profile stores proposed hypotheses but does not run an
      // automatic world-model verdict. Proposal evidence is deliberately
      // neutral so this arm cannot leak support/contradiction classification.
      if (resultIndex > 0) return Object.freeze([]);
      const committed: SemanticRule[] = [];
      for (const hypothesis of candidate.ruleHypotheses) {
        committed.push(await this.#controller.commitMemoryRule({
          ...(hypothesis.id === undefined ? {} : { id: hypothesis.id }),
          scope: hypothesis.scope,
          kind: hypothesis.kind,
          statement: hypothesis.statement,
          preconditions: hypothesis.preconditions,
          predictedEffect: hypothesis.predictedEffect,
          proposalReceiptHashes: [receiptHash],
          status: 'CANDIDATE',
        }));
      }
      return Object.freeze(committed);
    }
    const memory = this.#controller.queryMemory({ limit: 1_000 });
    const known = latestRules(memory.rules);
    if (verdict === undefined) {
      throw new ArcValidationError('INVALID_RETRODICTION', 'retrodiction verdict is unavailable');
    }
    if (verdict === 'INCONCLUSIVE') return Object.freeze([]);
    const targets = new Map<string, ArcRuleHypothesisDraft>();
    for (const id of candidate.citedRuleIds) {
      const existing = known.get(id);
      if (!existing) {
        throw new ArcValidationError('UNKNOWN_RULE', 'candidate rule disappeared before update');
      }
      targets.set(id, {
        id,
        scope: existing.scope,
        kind: existing.kind,
        statement: existing.statement,
        preconditions: existing.preconditions,
        predictedEffect: existing.predictedEffect,
      });
    }
    for (const hypothesis of candidate.ruleHypotheses) {
      targets.set(hypothesis.id ?? `new:${hashArcValue(hypothesis)}`, hypothesis);
    }
    const committed: SemanticRule[] = [];
    for (const hypothesis of targets.values()) {
      const existing = hypothesis.id === undefined ? undefined : known.get(hypothesis.id);
      const supportCount = (existing?.supportingReceiptHashes.length ?? 0) +
        (verdict === 'SUPPORTED' && !existing?.supportingReceiptHashes.includes(receiptHash) ? 1 : 0);
      const contradictionCount = (existing?.contradictingReceiptHashes.length ?? 0) +
        (verdict === 'CONTRADICTED' &&
          !existing?.contradictingReceiptHashes.includes(receiptHash) ? 1 : 0);
      const alpha = 1 + supportCount;
      const beta = 1 + contradictionCount;
      const status: SemanticRuleCommit['status'] = supportCount >= 2 && alpha / (alpha + beta) >= 0.75
        ? 'ACTIVE'
        : contradictionCount >= 2 && beta / (alpha + beta) >= 0.70
          ? 'FALSIFIED'
          : 'CANDIDATE';
      committed.push(await this.#controller.commitMemoryRule({
        ...(hypothesis.id === undefined ? {} : { id: hypothesis.id }),
        scope: hypothesis.scope,
        kind: hypothesis.kind,
        statement: hypothesis.statement,
        preconditions: hypothesis.preconditions,
        predictedEffect: hypothesis.predictedEffect,
        ...(verdict === 'SUPPORTED'
          ? { supportingReceiptHashes: [receiptHash] }
          : { contradictingReceiptHashes: [receiptHash] }),
        status,
      }));
    }
    return Object.freeze(committed);
  }

  async #resolveSupervisorGate(): Promise<SupervisorDirective | undefined> {
    if (this.#config.features.supervisorGate !== 'BLOCKING') return undefined;
    const detected = this.#controller.supervisorCaseBundle();
    if (!detected) return undefined;
    const bundle = this.#controller.openSupervisorCase() ?? detected;
    if (!this.#supervisor) {
      throw new ArcValidationError(
        'SUPERVISION_REQUIRED',
        'an open supervisor case requires the external boss lane',
      );
    }
    let stable: SupervisorDirectiveCommit;
    try {
      const proposed = await this.#supervisor.review(structuredClone(bundle));
      stable = snapshotArcJson(proposed) as unknown as SupervisorDirectiveCommit;
    } catch (error) {
      if (error instanceof ArcValidationError) throw error;
      throw new ArcValidationError(
        'INVALID_SUPERVISOR_DIRECTIVE',
        'supervisor returned an invalid directive',
      );
    }
    return this.#controller.commitSupervisorDirective(stable);
  }

  #verifyCheckpoint(checkpoint: ArcAvoCheckpoint): ArcAvoCheckpoint {
    let stable: ArcAvoCheckpoint;
    try {
      stable = snapshotArcJson(
        checkpoint,
        MAX_AVO_CHECKPOINT_JSON_NODES,
      ) as unknown as ArcAvoCheckpoint;
    } catch {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'AVO checkpoint is not strict JSON');
    }
    if (containsRawGameIdentityKey(stable)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'AVO checkpoint contains raw game identity',
      );
    }
    assertExactCheckpointRecord(
      stable,
      AVO_CHECKPOINT_KEYS,
      AVO_CHECKPOINT_REQUIRED_KEYS,
      'AVO checkpoint envelope',
    );
    if (stable.schema !== 'metaharness.arc_agi_3.avo_checkpoint.v1') {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'AVO checkpoint schema is invalid');
    }
    const { checkpointHash, ...body } = stable;
    assertExactCheckpointRecord(
      body,
      AVO_CHECKPOINT_BODY_KEYS,
      AVO_CHECKPOINT_BODY_REQUIRED_KEYS,
      'AVO checkpoint body',
    );
    if (!HEX_HASH.test(checkpointHash) || hashArcValue(body) !== checkpointHash) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'AVO checkpoint hash is invalid');
    }
    const config = resolveArcAvoConfig(stable.config);
    if (config.configHash !== this.#config.configHash ||
        stable.plannerVersion !== this.#plannerVersion ||
        stable.supervisorVersion !== this.#supervisorVersion) {
      throw new ArcValidationError(
        'AVO_CONFIG_MISMATCH',
        'AVO checkpoint runtime or feature configuration differs',
      );
    }
    try {
      verifyArcCheckpoint(stable.coreCheckpoint);
    } catch {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'embedded core checkpoint failed verification',
      );
    }
    if (stable.observationHash !== stable.coreCheckpoint.observation.observationHash) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'checkpoint observation is inconsistent');
    }
    return stable;
  }

  #verifyCheckpointBindings(checkpoint: ArcAvoCheckpoint): void {
    const receipts = new Map(
      checkpoint.coreCheckpoint.receipts.map(receipt => [receipt.receiptHash, receipt]),
    );
    const candidates = new Map(
      checkpoint.archive.candidates.map(candidate => [candidate.id, candidate]),
    );
    const selections = new Map(
      checkpoint.archive.selections.map(selection => [selection.selectionHash, selection]),
    );
    const records = new Map(
      checkpoint.worldModel.records.map(record => [record.retrodictionHash, record]),
    );
    const citedCoreReceipts = new Set<string>();
    const citedRetrodictions = new Set<string>();

    const baselineCount = checkpoint.coreReceiptBaselineCount;
    const baselineHead = checkpoint.coreReceiptBaselineHeadHash;
    if (!Number.isSafeInteger(baselineCount) || baselineCount < 0 ||
        baselineCount > checkpoint.coreCheckpoint.receipts.length ||
        !HEX_HASH.test(baselineHead) ||
        baselineHead !== (baselineCount === 0
          ? TRANSITION_RECEIPT_GENESIS
          : checkpoint.coreCheckpoint.receipts[baselineCount - 1]!.receiptHash)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'core receipt baseline is invalid',
      );
    }
    const loopReceipts = checkpoint.coreCheckpoint.receipts.slice(baselineCount);
    const loopReceiptHashes = new Set(loopReceipts.map(receipt => receipt.receiptHash));
    let expectedLoopReceiptIndex = 0;

    if (!this.#config.features.retrodictiveWorldModel && records.size > 0) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'retrodiction evidence is present while the feature is disabled',
      );
    }

    for (const outcome of checkpoint.archive.outcomes) {
      const candidate = candidates.get(outcome.candidateId);
      const selection = selections.get(outcome.selectionHash);
      if (!candidate || !selection || selection.selectedCandidateId !== candidate.id ||
          selection.observationHash !== candidate.baseObservationHash ||
          outcome.coreReceiptHashes.length > candidate.steps.length) {
        throw new ArcValidationError(
          'INVALID_AVO_CHECKPOINT',
          'plan outcome is not bound to its selected candidate',
        );
      }
      for (let index = 0; index < outcome.coreReceiptHashes.length; index += 1) {
        const receiptHash = outcome.coreReceiptHashes[index]!;
        const receipt = receipts.get(receiptHash);
        const step = candidate.steps[index];
        if (!receipt || !loopReceiptHashes.has(receiptHash) || !step ||
            citedCoreReceipts.has(receiptHash) ||
            receiptHash !== loopReceipts[expectedLoopReceiptIndex]?.receiptHash ||
            hashArcValue(receipt.action) !== hashArcValue(step.action) ||
            receipt.preObservationHash !== step.expectedObservationHash ||
            (index === 0 && receipt.preObservationHash !== selection.observationHash)) {
          throw new ArcValidationError(
            'INVALID_AVO_CHECKPOINT',
            'plan outcome receipt binding is invalid',
          );
        }
        citedCoreReceipts.add(receiptHash);
        expectedLoopReceiptIndex += 1;
      }
      for (const retrodictionHash of outcome.retrodictionHashes) {
        const record = records.get(retrodictionHash);
        if (!record || citedRetrodictions.has(retrodictionHash) ||
            record.selectionHash !== outcome.selectionHash ||
            record.candidateId !== outcome.candidateId ||
            !outcome.coreReceiptHashes.includes(record.coreReceiptHash)) {
          throw new ArcValidationError(
            'INVALID_AVO_CHECKPOINT',
            'plan outcome retrodiction binding is invalid',
          );
        }
        citedRetrodictions.add(retrodictionHash);
      }
    }

    for (const record of checkpoint.worldModel.records) {
      const receipt = receipts.get(record.coreReceiptHash);
      const candidate = candidates.get(record.candidateId);
      const selection = selections.get(record.selectionHash);
      if (!receipt || !candidate || !selection ||
          selection.selectedCandidateId !== candidate.id ||
          !selection.eligibleCandidateIds.includes(candidate.id) ||
          hashArcValue(record.action) !== hashArcValue(receipt.action) ||
          record.predictionError !== receipt.predictionError ||
          !citedRetrodictions.has(record.retrodictionHash)) {
        throw new ArcValidationError(
          'INVALID_AVO_CHECKPOINT',
          'world-model record is not bound to authoritative transition evidence',
        );
      }
    }
    if (citedRetrodictions.size !== records.size) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'world-model records and plan outcomes are not bijectively linked',
      );
    }
    if (expectedLoopReceiptIndex !== loopReceipts.length ||
        citedCoreReceipts.size !== loopReceiptHashes.size ||
        [...loopReceiptHashes].some(hash => !citedCoreReceipts.has(hash))) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'loop outcomes do not bijectively bind post-baseline core receipts',
      );
    }
  }

  #captureCoreReceiptBaseline(): void {
    const verification = this.#controller.verifyReceipts();
    if (!verification.ok) {
      throw new ArcValidationError(
        'INVALID_CORE_RECEIPTS',
        'cannot attach AVO to an invalid transition-receipt chain',
      );
    }
    this.#coreReceiptBaselineCount = verification.count;
    this.#coreReceiptBaselineHeadHash = verification.headHash;
  }

  #requireCoreReceiptBaselineCount(): number {
    if (this.#coreReceiptBaselineCount === undefined) {
      throw new ArcValidationError('NOT_STARTED', 'AVO receipt baseline is unavailable');
    }
    return this.#coreReceiptBaselineCount;
  }

  #requireCoreReceiptBaselineHeadHash(): string {
    if (this.#coreReceiptBaselineHeadHash === undefined) {
      throw new ArcValidationError('NOT_STARTED', 'AVO receipt baseline is unavailable');
    }
    return this.#coreReceiptBaselineHeadHash;
  }

  #newArchive(): ArcPlanArchive {
    return new ArcPlanArchive({
      principalScope: this.#controller.principalScope,
      opaqueGameScope: this.#controller.opaqueGameScope,
      runId: this.#controller.runId,
      config: this.#config,
    });
  }

  #requireObservation(): ActResult['observation'] {
    if (!this.#observation) {
      throw new ArcValidationError('NOT_STARTED', 'AVO loop is not started');
    }
    return this.#observation;
  }

  #requireArchive(): ArcPlanArchive {
    if (!this.#archive) throw new ArcValidationError('NOT_STARTED', 'AVO loop is not started');
    return this.#archive;
  }

  #assertVersionsStable(): void {
    if (this.#planner && boundedVersion(this.#planner.version, 'planner') !== this.#plannerVersion) {
      throw new ArcValidationError('AVO_VERSION_DRIFT', 'planner version changed during the run');
    }
    if (this.#supervisor &&
        boundedVersion(this.#supervisor.version, 'supervisor') !== this.#supervisorVersion) {
      throw new ArcValidationError('AVO_VERSION_DRIFT', 'supervisor version changed during the run');
    }
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#mutationTail;
    let release!: () => void;
    this.#mutationTail = new Promise<void>(resolve => { release = resolve; });
    return prior.catch(() => undefined).then(operation).finally(release);
  }
}

export function createArcAvoLoop(options: ArcAvoLoopOptions): ArcAvoLoop {
  return new ArcAvoLoop(options);
}
