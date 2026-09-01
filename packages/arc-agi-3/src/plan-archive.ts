import {
  ArcValidationError,
  containsRawGameIdentityKey,
  hashArcValue,
  snapshotArcJson,
  validateArcAction,
  validateExpectation,
} from './canonical.js';
import type {
  ArcCandidatePlan,
  ArcCandidatePlanDraft,
  ArcPlanArchiveSnapshot,
  ArcPlanOutcome,
  ArcPlanScore,
  ArcPlanScoringEvidence,
  ArcPlanSelection,
  ArcRuleHypothesisDraft,
} from './avo-types.js';
import type {
  GameState,
  GuardedPlanStep,
  ObservationPostcondition,
  SemanticRule,
} from './types.js';

export const ARC_PLAN_OUTCOME_GENESIS = '0'.repeat(64);
export const MAX_ARC_CANDIDATE_BATCH_BYTES = 256 * 1024;
export const MAX_ARC_PLAN_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_ARC_PLAN_ARCHIVE_NODES = 1_500_000;
const HEX_HASH = /^[0-9a-f]{64}$/;
const CANDIDATE_ID = /^arc_plan_[0-9a-f]{40}$/;
const RULE_SCOPES = new Set(['LEVEL', 'GAME', 'GENERIC']);
const RULE_KINDS = new Set([
  'ACTION_MAP',
  'OBJECT_ROLE',
  'TRANSITION',
  'GOAL',
  'CONSTRAINT',
  'STRATEGY',
]);
const GAME_STATES = new Set<GameState>(['NOT_PLAYED', 'NOT_FINISHED', 'WIN', 'GAME_OVER']);
const DRAFT_KEYS = new Set([
  'parentCandidateId',
  'baseObservationHash',
  'hypothesis',
  'citedRuleIds',
  'ruleHypotheses',
  'steps',
]);
const CANDIDATE_KEYS = new Set([
  ...DRAFT_KEYS,
  'id',
  'depth',
  'candidateHash',
]);
const ARCHIVE_KEYS = new Set([
  'schema',
  'candidates',
  'selections',
  'outcomes',
  'lineageHeadId',
  'outcomeHeadHash',
  'archiveHash',
]);
const ARCHIVE_REQUIRED_KEYS = new Set([
  'schema',
  'candidates',
  'selections',
  'outcomes',
  'outcomeHeadHash',
  'archiveHash',
]);
const SELECTION_KEYS = new Set([
  'observationHash',
  'offeredCandidateIds',
  'eligibleCandidateIds',
  'rejectionCodes',
  'scores',
  'selectedCandidateId',
  'configHash',
  'selectionHash',
]);
const OUTCOME_KEYS = new Set([
  'candidateId',
  'selectionHash',
  'coreReceiptHashes',
  'retrodictionHashes',
  'stopReason',
  'previousOutcomeHash',
  'outcomeHash',
]);
const RULE_KEYS = new Set([
  'id',
  'scope',
  'kind',
  'statement',
  'preconditions',
  'predictedEffect',
]);
const RULE_REQUIRED_KEYS = new Set([
  'scope',
  'kind',
  'statement',
  'preconditions',
  'predictedEffect',
]);
const STEP_KEYS = new Set([
  'expectedObservationHash',
  'idempotencyKey',
  'action',
  'expectation',
  'directiveId',
  'postcondition',
]);
const STEP_REQUIRED_KEYS = new Set([
  'expectedObservationHash',
  'idempotencyKey',
  'action',
  'expectation',
  'postcondition',
]);
const POSTCONDITION_KEYS = new Set([
  'expectedObservationHash',
  'expectedFrameHash',
  'state',
  'levelsCompleted',
]);
const SCORE_KEYS = new Set<keyof ArcPlanScore>([
  'expectedProgress',
  'predictionFit',
  'novelty',
  'ruleConfidence',
  'noEffectRisk',
  'normalizedActionCost',
  'utility',
]);

interface ArcPlanArchiveOptions {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly config: import('./avo-types.js').ArcAvoConfig;
}

interface AddCandidateEvidence {
  readonly observation: import('./types.js').ExactArcObservation;
  readonly rules: readonly SemanticRule[];
}

function assertExactRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', `${label} must be an object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key) ||
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !('value' in Object.getOwnPropertyDescriptor(value, key)!)) ||
      [...required].some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      `${label} fields do not match the exact schema`,
    );
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length || Reflect.ownKeys(value).some(key =>
        typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', `${label} must be a dense array`);
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      /[\u0000-\u001f]/.test(value)) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      `${label} must be non-empty bounded text`,
    );
  }
  return value.trim();
}

function validatePostcondition(value: unknown): asserts value is ObservationPostcondition {
  assertExactRecord(value, POSTCONDITION_KEYS, new Set(), 'postcondition');
  const postcondition = value as unknown as ObservationPostcondition;
  const keys = Object.keys(postcondition);
  if (keys.length === 0 || Object.values(postcondition).some(item => item === undefined)) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      'postcondition must contain at least one defined prediction',
    );
  }
  for (const [label, hash] of [
    ['expectedObservationHash', postcondition.expectedObservationHash],
    ['expectedFrameHash', postcondition.expectedFrameHash],
  ] as const) {
    if (hash !== undefined && (typeof hash !== 'string' || !HEX_HASH.test(hash))) {
      throw new ArcValidationError('INVALID_CANDIDATE_PLAN', `${label} must be a SHA-256 hash`);
    }
  }
  if (postcondition.state !== undefined && !GAME_STATES.has(postcondition.state)) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'postcondition state is invalid');
  }
  if (postcondition.levelsCompleted !== undefined &&
      (!Number.isSafeInteger(postcondition.levelsCompleted) || postcondition.levelsCompleted < 0)) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      'postcondition levelsCompleted must be a non-negative safe integer',
    );
  }
}

function validateRuleHypothesis(value: unknown): asserts value is ArcRuleHypothesisDraft {
  assertExactRecord(value, RULE_KEYS, RULE_REQUIRED_KEYS, 'rule hypothesis');
  const rule = value as unknown as ArcRuleHypothesisDraft;
  if (rule.id !== undefined) boundedText(rule.id, 'rule hypothesis id', 256);
  if (!RULE_SCOPES.has(rule.scope) || !RULE_KINDS.has(rule.kind)) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'rule scope or kind is invalid');
  }
  boundedText(rule.statement, 'rule statement', 4_096);
  boundedText(rule.predictedEffect, 'rule predictedEffect', 4_096);
  assertDenseArray(rule.preconditions, 'rule preconditions');
  if (rule.preconditions.length > 128 || rule.preconditions.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > 1_024 ||
    /[\u0000-\u001f]/.test(item)) ||
    new Set(rule.preconditions).size !== rule.preconditions.length) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'rule preconditions are invalid');
  }
}

function validateStep(value: unknown): asserts value is GuardedPlanStep {
  assertExactRecord(value, STEP_KEYS, STEP_REQUIRED_KEYS, 'plan step');
  const step = value as unknown as GuardedPlanStep;
  if (typeof step.expectedObservationHash !== 'string' ||
      !HEX_HASH.test(step.expectedObservationHash)) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      'step expectedObservationHash must be a SHA-256 hash',
    );
  }
  if (typeof step.idempotencyKey !== 'string' || step.idempotencyKey.length < 8 ||
      step.idempotencyKey.length > 200 || /[^\x21-\x7e]/.test(step.idempotencyKey)) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'step idempotency key is invalid');
  }
  if (step.directiveId !== undefined) boundedText(step.directiveId, 'directiveId', 256);
  validateArcAction(step.action);
  validateExpectation(step.expectation);
  validatePostcondition(step.postcondition);
}

function validateCandidateDraft(value: unknown): asserts value is ArcCandidatePlanDraft {
  assertExactRecord(value, DRAFT_KEYS, DRAFT_KEYS, 'candidate plan');
  const draft = value as unknown as ArcCandidatePlanDraft;
  if (draft.parentCandidateId !== null && typeof draft.parentCandidateId !== 'string') {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'parentCandidateId is invalid');
  }
  if (typeof draft.baseObservationHash !== 'string' ||
      !HEX_HASH.test(draft.baseObservationHash)) {
    throw new ArcValidationError(
      'INVALID_CANDIDATE_PLAN',
      'baseObservationHash must be a SHA-256 hash',
    );
  }
  boundedText(draft.hypothesis, 'candidate hypothesis', 4_096);
  assertDenseArray(draft.citedRuleIds, 'citedRuleIds');
  assertDenseArray(draft.ruleHypotheses, 'ruleHypotheses');
  assertDenseArray(draft.steps, 'plan steps');
  if (draft.citedRuleIds.length > 64 || draft.citedRuleIds.some(id =>
    typeof id !== 'string' || !id.trim() || id.length > 256) ||
    new Set(draft.citedRuleIds).size !== draft.citedRuleIds.length) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'citedRuleIds are invalid');
  }
  if (draft.ruleHypotheses.length > 16) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'too many rule hypotheses');
  }
  for (const rule of draft.ruleHypotheses) validateRuleHypothesis(rule);
  for (const step of draft.steps) validateStep(step);
}

function latestRules(rules: readonly SemanticRule[]): Map<string, SemanticRule> {
  const map = new Map<string, SemanticRule>();
  for (const rule of rules) {
    const prior = map.get(rule.id);
    if (!prior || prior.version < rule.version) map.set(rule.id, rule);
  }
  return map;
}

function sameAction(left: import('./types.js').ArcAction, right: import('./types.js').ArcAction): boolean {
  return hashArcValue(left) === hashArcValue(right);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function stableNumber(value: number): number {
  return Number(value.toFixed(12));
}

interface JsonMetrics {
  readonly bytes: number;
  readonly nodes: number;
}

function jsonMetrics(value: unknown): JsonMetrics {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'archive value is not JSON');
  }
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === 'object') {
      stack.push(...Object.values(current as Record<string, unknown>));
    }
  }
  return Object.freeze({ bytes: Buffer.byteLength(encoded, 'utf8'), nodes });
}

function addMetrics(left: JsonMetrics, right: JsonMetrics): JsonMetrics {
  return { bytes: left.bytes + right.bytes, nodes: left.nodes + right.nodes };
}

function reservedOutcomeMetrics(
  candidate: ArcCandidatePlan,
  selectionHash: string,
  retrodictionEnabled: boolean,
): JsonMetrics {
  const maximumHashes = Object.freeze(
    Array.from({ length: candidate.steps.length }, () => 'f'.repeat(64)),
  );
  return jsonMetrics({
    candidateId: candidate.id,
    selectionHash,
    coreReceiptHashes: maximumHashes,
    retrodictionHashes: retrodictionEnabled ? maximumHashes : [],
    stopReason: 'ACTION_REJECTED',
    previousOutcomeHash: 'f'.repeat(64),
    outcomeHash: 'f'.repeat(64),
  });
}

function selectionBody(selection: Omit<ArcPlanSelection, 'selectionHash'>): unknown {
  return selection;
}

function outcomeBody(outcome: Omit<ArcPlanOutcome, 'outcomeHash'>): unknown {
  return outcome;
}

export class ArcPlanArchive {
  private readonly candidates = new Map<string, ArcCandidatePlan>();
  private readonly candidateMetrics = new Map<string, JsonMetrics>();
  private readonly selections: ArcPlanSelection[] = [];
  private readonly selectionsByHash = new Map<string, ArcPlanSelection>();
  private readonly referencedCandidateIds = new Set<string>();
  private readonly outcomes: ArcPlanOutcome[] = [];
  private readonly outcomeSelectionHashes = new Set<string>();
  private readonly outcomeReservations = new Map<string, JsonMetrics>();
  private archiveBytes = 0;
  private archiveNodes = 0;
  private lineageHeadId?: string;
  private outcomeHeadHash = ARC_PLAN_OUTCOME_GENESIS;

  constructor(private readonly options: ArcPlanArchiveOptions) {}

  private assertCapacity(addition: JsonMetrics): void {
    if (this.archiveBytes + addition.bytes > MAX_ARC_PLAN_ARCHIVE_BYTES ||
        this.archiveNodes + addition.nodes > MAX_ARC_PLAN_ARCHIVE_NODES) {
      throw new ArcValidationError(
        'AVO_ARCHIVE_BUDGET_EXHAUSTED',
        'AVO plan archive reached its frozen pre-mutation capacity',
      );
    }
  }

  addCandidates(
    input: readonly ArcCandidatePlanDraft[],
    evidence: AddCandidateEvidence,
  ): readonly ArcCandidatePlan[] {
    let stable: readonly ArcCandidatePlanDraft[];
    try {
      stable = snapshotArcJson(input) as unknown as readonly ArcCandidatePlanDraft[];
    } catch {
      throw new ArcValidationError(
        'INVALID_CANDIDATE_PLAN',
        'candidate batch must be strict acyclic JSON',
      );
    }
    assertDenseArray(stable, 'candidate batch');
    const maximum = this.options.config.features.candidatePlanSelection
      ? this.options.config.maxCandidatesPerDecision
      : 1;
    if (stable.length < 1 || stable.length > maximum) {
      throw new ArcValidationError(
        'INVALID_CANDIDATE_BATCH',
        `candidate batch must contain 1..${maximum} plans`,
      );
    }
    if (containsRawGameIdentityKey(stable)) {
      throw new ArcValidationError('GAME_IDENTITY_LEAK', 'candidate batch contains raw game identity');
    }
    const knownRules = latestRules(evidence.rules);
    const hasCommittedLineage = this.lineageHeadId !== undefined;
    const created: ArcCandidatePlan[] = [];
    const createdMetrics = new Map<string, JsonMetrics>();
    const batchIds = new Set<string>();
    for (const raw of stable) {
      validateCandidateDraft(raw);
      const draft = raw as ArcCandidatePlanDraft;
      if (draft.baseObservationHash !== evidence.observation.observationHash) {
        throw new ArcValidationError('STALE_PLAN_BASE', 'candidate plan is based on a stale observation');
      }
      if (!this.options.config.features.semanticRuleMemory &&
          (draft.citedRuleIds.length > 0 || draft.ruleHypotheses.length > 0)) {
        throw new ArcValidationError(
          'AVO_FEATURE_DISABLED',
          'this ablation arm does not expose semantic rule memory',
        );
      }
      if (this.options.config.features.semanticRuleMemory &&
          draft.citedRuleIds.length + draft.ruleHypotheses.length === 0) {
        throw new ArcValidationError(
          'RULE_EVIDENCE_REQUIRED',
          'memory-enabled candidates must cite or propose at least one rule',
        );
      }
      for (const id of draft.citedRuleIds) {
        if (!knownRules.has(id)) {
          throw new ArcValidationError('UNKNOWN_RULE', 'candidate cites an unknown semantic rule');
        }
      }
      for (const rule of draft.ruleHypotheses) {
        if (rule.id !== undefined && !knownRules.has(rule.id)) {
          throw new ArcValidationError('UNKNOWN_RULE', 'rule revision cites an unknown semantic rule');
        }
      }
      if (draft.steps.length < 1 || draft.steps.length > this.options.config.maxPlanSteps ||
          (!this.options.config.features.guardedExecution && draft.steps.length !== 1)) {
        throw new ArcValidationError(
          'INVALID_CANDIDATE_PLAN',
          this.options.config.features.guardedExecution
            ? `plan must contain 1..${this.options.config.maxPlanSteps} steps`
            : 'this ablation arm permits exactly one plan step',
        );
      }
      if (draft.steps[0]!.expectedObservationHash !== draft.baseObservationHash) {
        throw new ArcValidationError(
          'STALE_PLAN_BASE',
          'first plan step must use the candidate base observation hash',
        );
      }
      for (let index = 1; index < draft.steps.length; index += 1) {
        if (draft.steps[index - 1]!.postcondition.expectedObservationHash === undefined ||
            draft.steps[index - 1]!.postcondition.expectedObservationHash !==
              draft.steps[index]!.expectedObservationHash) {
          throw new ArcValidationError(
            'UNGUARDED_PLAN_STEP',
            'multi-step plans require an exact observation-hash chain',
          );
        }
      }
      const firstAction = draft.steps[0]!.action;
      const observation = evidence.observation;
      if ((observation.state === 'NOT_PLAYED' || observation.state === 'GAME_OVER') &&
          firstAction.name !== 'RESET') {
        throw new ArcValidationError('RESET_REQUIRED', 'current state permits only RESET');
      }
      if (observation.state === 'NOT_FINISHED' &&
          (firstAction.name === 'RESET' || !observation.availableActions.includes(firstAction.name))) {
        throw new ArcValidationError('ACTION_UNAVAILABLE', 'candidate first action is unavailable');
      }
      if (observation.state === 'WIN') {
        throw new ArcValidationError('RUN_WON', 'WIN is terminal');
      }
      let depth = 0;
      if (!this.options.config.features.planLineage) {
        if (draft.parentCandidateId !== null) {
          throw new ArcValidationError('AVO_FEATURE_DISABLED', 'this arm does not expose plan lineage');
        }
      } else if (!hasCommittedLineage) {
        if (draft.parentCandidateId !== null) {
          throw new ArcValidationError('UNKNOWN_PLAN_PARENT', 'genesis candidates must have null parent');
        }
      } else {
        if (draft.parentCandidateId === null) {
          throw new ArcValidationError('UNKNOWN_PLAN_PARENT', 'non-genesis candidate requires a parent');
        }
        const parent = this.candidates.get(draft.parentCandidateId);
        if (!parent) {
          throw new ArcValidationError('UNKNOWN_PLAN_PARENT', 'candidate parent is unavailable');
        }
        depth = parent.depth + 1;
      }
      const candidateBody = {
        principalScope: this.options.principalScope,
        opaqueGameScope: this.options.opaqueGameScope,
        runId: this.options.runId,
        configHash: this.options.config.configHash,
        draft,
        depth,
      };
      const candidateHash = hashArcValue(candidateBody);
      const id = `arc_plan_${candidateHash.slice(0, 40)}`;
      if (this.candidates.has(id) || batchIds.has(id)) {
        throw new ArcValidationError('DUPLICATE_CANDIDATE', 'candidate plan is duplicated');
      }
      const candidate = Object.freeze({
        ...draft,
        id,
        depth,
        candidateHash,
      });
      created.push(candidate);
      createdMetrics.set(id, jsonMetrics(candidate));
      batchIds.add(id);
    }
    const batchMetrics = [...createdMetrics.values()].reduce(
      addMetrics,
      { bytes: 0, nodes: 0 },
    );
    if (batchMetrics.bytes > MAX_ARC_CANDIDATE_BATCH_BYTES) {
      throw new ArcValidationError(
        'INVALID_CANDIDATE_BATCH',
        `candidate batch exceeds ${MAX_ARC_CANDIDATE_BATCH_BYTES} bytes`,
      );
    }
    this.assertCapacity(batchMetrics);
    for (const candidate of created) {
      this.candidates.set(candidate.id, candidate);
      this.candidateMetrics.set(candidate.id, createdMetrics.get(candidate.id)!);
    }
    this.archiveBytes += batchMetrics.bytes;
    this.archiveNodes += batchMetrics.nodes;
    return Object.freeze(created);
  }

  select(
    candidates: readonly ArcCandidatePlan[],
    evidence: ArcPlanScoringEvidence,
    rejectionCodes: Readonly<Record<string, string>> = Object.freeze({}),
  ): ArcPlanSelection {
    if (candidates.length < 1 || candidates.some(candidate =>
      this.candidates.get(candidate.id)?.candidateHash !== candidate.candidateHash ||
      candidate.baseObservationHash !== evidence.observation.observationHash)) {
      throw new ArcValidationError('INVALID_CANDIDATE_BATCH', 'candidate selection set is invalid');
    }
    const offeredIds = new Set(candidates.map(candidate => candidate.id));
    const rejectionEntries = Object.entries(rejectionCodes);
    if (rejectionEntries.some(([id, code]) => !offeredIds.has(id) ||
        typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(code))) {
      throw new ArcValidationError(
        'INVALID_CANDIDATE_BATCH',
        'candidate rejection evidence is invalid',
      );
    }
    const eligibleCandidates = candidates.filter(candidate => !(candidate.id in rejectionCodes));
    if (eligibleCandidates.length === 0) {
      throw new ArcValidationError(
        'NO_LEGAL_CANDIDATE',
        'no candidate is legal under the active environment and supervisor policy',
      );
    }
    const rules = latestRules(evidence.rules);
    const scores = new Map<string, ArcPlanScore>();
    for (const candidate of candidates) {
      const firstAction = candidate.steps[0]!.action;
      // Progress utility is learned only from receipted transitions. Planner
      // predictions remain useful for post-action error, but cannot buy score
      // by claiming WIN or an invented level count.
      const actionHistory = evidence.episodes.filter(episode =>
        sameAction(episode.action, firstAction)).slice(-16);
      const remainingLevels = Math.max(
        1,
        evidence.observation.winLevels - evidence.observation.levelsCompleted,
      );
      const expectedProgress = actionHistory.length === 0
        ? 0
        : clamp(actionHistory.reduce(
          (sum, episode) => sum + Math.max(0, episode.progressDelta) / remainingLevels,
          0,
        ) / actionHistory.length);
      const actionRetrodictions = evidence.retrodictions.filter(record =>
        sameAction(record.action, firstAction));
      const predictionFit = actionRetrodictions.length === 0
        ? 0.5
        : clamp(actionRetrodictions.reduce(
          (sum, record) => sum + (1 - record.predictionError),
          0,
        ) / actionRetrodictions.length);
      const exactEpisodes = evidence.episodes.filter(episode =>
        episode.preObservationHash === evidence.observation.observationHash &&
        sameAction(episode.action, firstAction));
      const frontierNovelty = evidence.frontier.find(edge =>
        edge.actionName === firstAction.name)?.noveltyPriority ?? 1;
      const novelty = exactEpisodes.length > 0
        ? 1 / (1 + exactEpisodes.length)
        : clamp(frontierNovelty);
      const cited = candidate.citedRuleIds.map(id => rules.get(id)).filter(
        (rule): rule is SemanticRule => rule !== undefined,
      );
      const ruleConfidence = cited.length === 0
        ? 0.5
        : clamp(cited.reduce((sum, rule) => sum + rule.alpha / (rule.alpha + rule.beta), 0) /
          cited.length);
      const noEffectRisk = exactEpisodes.length === 0
        ? 0
        : clamp(exactEpisodes.filter(episode => episode.noEffect).length / exactEpisodes.length);
      const normalizedActionCost = clamp(candidate.steps.length / this.options.config.maxPlanSteps);
      const weights = this.options.config.selector;
      const utility = stableNumber(
        weights.expectedProgress * expectedProgress +
        weights.predictionFit * predictionFit +
        weights.novelty * novelty +
        weights.ruleConfidence * ruleConfidence -
        weights.noEffectRisk * noEffectRisk -
        weights.actionCost * normalizedActionCost,
      );
      scores.set(candidate.id, Object.freeze({
        expectedProgress: stableNumber(expectedProgress),
        predictionFit: stableNumber(predictionFit),
        novelty: stableNumber(novelty),
        ruleConfidence: stableNumber(ruleConfidence),
        noEffectRisk: stableNumber(noEffectRisk),
        normalizedActionCost: stableNumber(normalizedActionCost),
        utility,
      }));
    }
    const ordered = [...eligibleCandidates].sort((left, right) => {
      if (!this.options.config.features.candidatePlanSelection) return 0;
      const utilityDifference = scores.get(right.id)!.utility - scores.get(left.id)!.utility;
      if (utilityDifference !== 0) return utilityDifference;
      const lengthDifference = left.steps.length - right.steps.length;
      if (lengthDifference !== 0) return lengthDifference;
      // Candidate order is the planner's bounded ordinal preference. It can
      // break an exact evidence/action-cost tie, but it cannot override an
      // evidence-derived utility difference.
      const preferenceDifference = candidates.indexOf(left) - candidates.indexOf(right);
      return preferenceDifference !== 0 ? preferenceDifference : left.id.localeCompare(right.id);
    });
    const offeredCandidateIds = Object.freeze(candidates.map(candidate => candidate.id));
    const eligibleCandidateIds = Object.freeze(
      eligibleCandidates.map(candidate => candidate.id),
    );
    const stableRejectionCodes = Object.freeze(Object.fromEntries(
      rejectionEntries.sort(([left], [right]) => left.localeCompare(right)),
    ));
    const scoreRecord = Object.freeze(Object.fromEntries(
      offeredCandidateIds.map(id => [id, scores.get(id)!]),
    ));
    const body = Object.freeze({
      observationHash: evidence.observation.observationHash,
      offeredCandidateIds,
      eligibleCandidateIds,
      rejectionCodes: stableRejectionCodes,
      scores: scoreRecord,
      selectedCandidateId: ordered[0]!.id,
      configHash: this.options.config.configHash,
    });
    const selection = Object.freeze({ ...body, selectionHash: hashArcValue(body) });
    const selectionMetrics = jsonMetrics(selection);
    const outcomeReservation = reservedOutcomeMetrics(
      ordered[0]!,
      selection.selectionHash,
      this.options.config.features.retrodictiveWorldModel,
    );
    this.assertCapacity(addMetrics(selectionMetrics, outcomeReservation));
    this.selections.push(selection);
    this.selectionsByHash.set(selection.selectionHash, selection);
    for (const candidateId of selection.offeredCandidateIds) {
      this.referencedCandidateIds.add(candidateId);
    }
    this.outcomeReservations.set(selection.selectionHash, outcomeReservation);
    this.archiveBytes += selectionMetrics.bytes + outcomeReservation.bytes;
    this.archiveNodes += selectionMetrics.nodes + outcomeReservation.nodes;
    return selection;
  }

  appendOutcome(input: Omit<ArcPlanOutcome, 'previousOutcomeHash' | 'outcomeHash'>): ArcPlanOutcome {
    const selection = this.selectionsByHash.get(input.selectionHash);
    if (!selection || selection.selectedCandidateId !== input.candidateId ||
        !this.candidates.has(input.candidateId)) {
      throw new ArcValidationError('PLAN_SELECTION_MISMATCH', 'plan outcome has no valid selection');
    }
    if (!Array.isArray(input.coreReceiptHashes) || !Array.isArray(input.retrodictionHashes) ||
        new Set(input.coreReceiptHashes).size !== input.coreReceiptHashes.length ||
        new Set(input.retrodictionHashes).size !== input.retrodictionHashes.length ||
        [...input.coreReceiptHashes, ...input.retrodictionHashes].some(hash => !HEX_HASH.test(hash))) {
      throw new ArcValidationError('INVALID_PLAN_OUTCOME', 'plan outcome hashes are invalid');
    }
    if (!['COMPLETED', 'DIVERGED', 'ACTION_REJECTED'].includes(input.stopReason)) {
      throw new ArcValidationError('INVALID_PLAN_OUTCOME', 'plan outcome stopReason is invalid');
    }
    if (this.outcomeSelectionHashes.has(input.selectionHash)) {
      throw new ArcValidationError('INVALID_PLAN_OUTCOME', 'selection already has an outcome');
    }
    const reservation = this.outcomeReservations.get(input.selectionHash);
    if (!reservation) {
      throw new ArcValidationError('INVALID_PLAN_OUTCOME', 'outcome has no capacity reservation');
    }
    const body = Object.freeze({ ...input, previousOutcomeHash: this.outcomeHeadHash });
    const outcome = Object.freeze({ ...body, outcomeHash: hashArcValue(body) });
    const outcomeMetrics = jsonMetrics(outcome);
    if (outcomeMetrics.bytes > reservation.bytes || outcomeMetrics.nodes > reservation.nodes) {
      throw new ArcValidationError(
        'INVALID_PLAN_OUTCOME',
        'outcome exceeded its pre-mutation archive reservation',
      );
    }
    this.outcomes.push(outcome);
    this.outcomeSelectionHashes.add(input.selectionHash);
    this.outcomeReservations.delete(input.selectionHash);
    this.archiveBytes += outcomeMetrics.bytes - reservation.bytes;
    this.archiveNodes += outcomeMetrics.nodes - reservation.nodes;
    this.outcomeHeadHash = outcome.outcomeHash;
    if (outcome.coreReceiptHashes.length > 0) this.lineageHeadId = outcome.candidateId;
    return outcome;
  }

  candidate(id: string): ArcCandidatePlan | undefined {
    return this.candidates.get(id);
  }

  /** Roll back a just-added batch when no auditable selection was committed. */
  rollbackUnselectedCandidates(candidates: readonly ArcCandidatePlan[]): void {
    const ids = new Set(candidates.map(candidate => candidate.id));
    if ([...ids].some(id => this.referencedCandidateIds.has(id))) {
      throw new ArcValidationError(
        'PLAN_SELECTION_MISMATCH',
        'cannot roll back candidates referenced by a selection',
      );
    }
    for (const candidate of candidates) {
      if (this.candidates.get(candidate.id)?.candidateHash !== candidate.candidateHash) {
        throw new ArcValidationError(
          'PLAN_SELECTION_MISMATCH',
          'candidate rollback set is not owned by this archive',
        );
      }
    }
    for (const candidate of candidates) {
      const metrics = this.candidateMetrics.get(candidate.id);
      if (metrics) {
        this.archiveBytes -= metrics.bytes;
        this.archiveNodes -= metrics.nodes;
      }
      this.candidateMetrics.delete(candidate.id);
      this.candidates.delete(candidate.id);
    }
  }

  recentCandidates(limit = 32): readonly ArcCandidatePlan[] {
    return Object.freeze([...this.candidates.values()].slice(-limit));
  }

  recentOutcomes(limit = 32): readonly ArcPlanOutcome[] {
    return Object.freeze(this.outcomes.slice(-limit));
  }

  get currentLineageHeadId(): string | undefined {
    return this.lineageHeadId;
  }

  get outcomeCount(): number {
    return this.outcomes.length;
  }

  snapshot(): ArcPlanArchiveSnapshot {
    const body = Object.freeze({
      schema: 'metaharness.arc_agi_3.plan_archive.v1' as const,
      candidates: Object.freeze([...this.candidates.values()]),
      selections: Object.freeze([...this.selections]),
      outcomes: Object.freeze([...this.outcomes]),
      ...(this.lineageHeadId === undefined ? {} : { lineageHeadId: this.lineageHeadId }),
      outcomeHeadHash: this.outcomeHeadHash,
    });
    return Object.freeze({ ...body, archiveHash: hashArcValue(body) });
  }

  load(snapshot: ArcPlanArchiveSnapshot): void {
    let stable: ArcPlanArchiveSnapshot;
    try {
      stable = snapshotArcJson(snapshot, 2_000_000) as unknown as ArcPlanArchiveSnapshot;
    } catch {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive is not strict JSON');
    }
    if (containsRawGameIdentityKey(stable)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'plan archive contains raw game identity',
      );
    }
    try {
      assertExactRecord(stable, ARCHIVE_KEYS, ARCHIVE_REQUIRED_KEYS, 'plan archive');
    } catch {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive schema is invalid');
    }
    if (stable.schema !== 'metaharness.arc_agi_3.plan_archive.v1') {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive schema is invalid');
    }
    if (!Array.isArray(stable.candidates) || !Array.isArray(stable.selections) ||
        !Array.isArray(stable.outcomes)) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive arrays are invalid');
    }
    const { archiveHash, ...archiveBody } = stable;
    if (!HEX_HASH.test(archiveHash) || hashArcValue(archiveBody) !== archiveHash) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive hash is invalid');
    }
    const candidates = new Map<string, ArcCandidatePlan>();
    for (const rawCandidate of stable.candidates) {
      let candidate: ArcCandidatePlan;
      try {
        assertExactRecord(
          rawCandidate,
          CANDIDATE_KEYS,
          CANDIDATE_KEYS,
          'persisted candidate plan',
        );
        const {
          id,
          depth,
          candidateHash,
          ...candidateDraft
        } = rawCandidate as unknown as ArcCandidatePlan;
        validateCandidateDraft(candidateDraft);
        candidate = rawCandidate as unknown as ArcCandidatePlan;
        if (!CANDIDATE_ID.test(id) || !HEX_HASH.test(candidateHash) ||
            !Number.isSafeInteger(depth) || depth < 0 ||
            candidateDraft.steps.length < 1 ||
            candidateDraft.steps.length > this.options.config.maxPlanSteps ||
            (!this.options.config.features.guardedExecution && candidateDraft.steps.length !== 1) ||
            (!this.options.config.features.semanticRuleMemory &&
              (candidateDraft.citedRuleIds.length > 0 ||
                candidateDraft.ruleHypotheses.length > 0)) ||
            (this.options.config.features.semanticRuleMemory &&
              candidateDraft.citedRuleIds.length + candidateDraft.ruleHypotheses.length === 0) ||
            (!this.options.config.features.planLineage &&
              candidateDraft.parentCandidateId !== null) ||
            candidateDraft.steps[0]!.expectedObservationHash !==
              candidateDraft.baseObservationHash) {
          throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'candidate invariants are invalid');
        }
        for (let index = 1; index < candidateDraft.steps.length; index += 1) {
          if (candidateDraft.steps[index - 1]!.postcondition.expectedObservationHash === undefined ||
              candidateDraft.steps[index - 1]!.postcondition.expectedObservationHash !==
                candidateDraft.steps[index]!.expectedObservationHash) {
            throw new ArcValidationError(
              'INVALID_CANDIDATE_PLAN',
              'candidate observation-hash chain is invalid',
            );
          }
        }
      } catch {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan candidate is invalid');
      }
      const { id, depth, candidateHash, ...draft } = candidate;
      if (candidates.has(id)) {
        throw new ArcValidationError(
          'INVALID_AVO_CHECKPOINT',
          'plan archive contains a duplicate candidate id',
        );
      }
      const expectedDepth = draft.parentCandidateId === null
        ? 0
        : (candidates.get(draft.parentCandidateId)?.depth ?? Number.NaN) + 1;
      const computed = hashArcValue({
        principalScope: this.options.principalScope,
        opaqueGameScope: this.options.opaqueGameScope,
        runId: this.options.runId,
        configHash: this.options.config.configHash,
        draft,
        depth,
      });
      if (depth !== expectedDepth || candidateHash !== computed ||
          id !== `arc_plan_${computed.slice(0, 40)}`) {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan candidate lineage is invalid');
      }
      candidates.set(id, candidate);
    }
    const selections: ArcPlanSelection[] = [];
    const selectionsByHash = new Map<string, ArcPlanSelection>();
    const candidateOfferCounts = new Map(
      [...candidates.keys()].map(id => [id, 0]),
    );
    for (const rawSelection of stable.selections) {
      let selection: ArcPlanSelection;
      try {
        assertExactRecord(
          rawSelection,
          SELECTION_KEYS,
          SELECTION_KEYS,
          'persisted plan selection',
        );
        selection = rawSelection as unknown as ArcPlanSelection;
        assertDenseArray(selection.offeredCandidateIds, 'offeredCandidateIds');
        assertDenseArray(selection.eligibleCandidateIds, 'eligibleCandidateIds');
        if (!selection.rejectionCodes || typeof selection.rejectionCodes !== 'object' ||
            Array.isArray(selection.rejectionCodes) ||
            !selection.scores || typeof selection.scores !== 'object' ||
            Array.isArray(selection.scores)) {
          throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'selection maps are invalid');
        }
      } catch {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan selection is invalid');
      }
      const { selectionHash, ...body } = selection;
      const offered = selection.offeredCandidateIds;
      const eligible = selection.eligibleCandidateIds;
      const rejected = Object.keys(selection.rejectionCodes);
      const scoreIds = Object.keys(selection.scores);
      const maximumOffered = this.options.config.features.candidatePlanSelection
        ? this.options.config.maxCandidatesPerDecision
        : 1;
      const scoresAreValid = scoreIds.every(id => {
        const score = selection.scores[id];
        if (!score || typeof score !== 'object' || Array.isArray(score) ||
            Reflect.ownKeys(score).length !== SCORE_KEYS.size ||
            Reflect.ownKeys(score).some(key => typeof key !== 'string' ||
              !SCORE_KEYS.has(key as keyof ArcPlanScore))) return false;
        return SCORE_KEYS.size === Object.values(score).length &&
          Object.values(score).every(value => typeof value === 'number' && Number.isFinite(value));
      });
      if (!HEX_HASH.test(selectionHash) || selectionsByHash.has(selectionHash) ||
          hashArcValue(selectionBody(body)) !== selectionHash ||
          selection.configHash !== this.options.config.configHash ||
          !HEX_HASH.test(selection.observationHash) ||
          offered.length < 1 || offered.length > maximumOffered ||
          new Set(offered).size !== offered.length || new Set(eligible).size !== eligible.length ||
          scoreIds.length !== offered.length || scoreIds.some(id => !offered.includes(id)) ||
          !scoresAreValid ||
          !eligible.includes(selection.selectedCandidateId) ||
          offered.some(id => !candidates.has(id)) || eligible.some(id => !offered.includes(id)) ||
          offered.some(id => candidates.get(id)?.baseObservationHash !==
            selection.observationHash) ||
          rejected.some(id => !offered.includes(id) || eligible.includes(id) ||
            !/^[A-Z][A-Z0-9_]{0,127}$/.test(selection.rejectionCodes[id]!)) ||
          offered.some(id => eligible.includes(id) === Object.prototype.hasOwnProperty.call(
            selection.rejectionCodes,
            id,
          ))) {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan selection is invalid');
      }
      selections.push(selection);
      selectionsByHash.set(selectionHash, selection);
      for (const candidateId of offered) {
        candidateOfferCounts.set(candidateId, candidateOfferCounts.get(candidateId)! + 1);
      }
    }
    if ([...candidateOfferCounts.values()].some(count => count !== 1)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'each plan candidate must be offered by exactly one selection',
      );
    }
    const outcomes: ArcPlanOutcome[] = [];
    const selectionOutcomeCounts = new Map(
      [...selectionsByHash.keys()].map(hash => [hash, 0]),
    );
    let head = ARC_PLAN_OUTCOME_GENESIS;
    let lineageHead: string | undefined;
    for (let outcomeIndex = 0; outcomeIndex < stable.outcomes.length; outcomeIndex += 1) {
      const rawOutcome = stable.outcomes[outcomeIndex]!;
      let outcome: ArcPlanOutcome;
      try {
        assertExactRecord(
          rawOutcome,
          OUTCOME_KEYS,
          OUTCOME_KEYS,
          'persisted plan outcome',
        );
        outcome = rawOutcome as unknown as ArcPlanOutcome;
        assertDenseArray(outcome.coreReceiptHashes, 'coreReceiptHashes');
        assertDenseArray(outcome.retrodictionHashes, 'retrodictionHashes');
        if (!CANDIDATE_ID.test(outcome.candidateId) ||
            !HEX_HASH.test(outcome.selectionHash) ||
            new Set(outcome.coreReceiptHashes).size !== outcome.coreReceiptHashes.length ||
            new Set(outcome.retrodictionHashes).size !== outcome.retrodictionHashes.length ||
            [...outcome.coreReceiptHashes, ...outcome.retrodictionHashes].some(hash =>
              typeof hash !== 'string' || !HEX_HASH.test(hash)) ||
            !['COMPLETED', 'DIVERGED', 'ACTION_REJECTED'].includes(outcome.stopReason)) {
          throw new ArcValidationError('INVALID_CANDIDATE_PLAN', 'outcome fields are invalid');
        }
      } catch {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan outcome is invalid');
      }
      const { outcomeHash, ...body } = outcome;
      const selection = selectionsByHash.get(outcome.selectionHash);
      if (!HEX_HASH.test(outcomeHash) || outcome.previousOutcomeHash !== head ||
          hashArcValue(outcomeBody(body)) !== outcomeHash ||
          !selection || selection.selectedCandidateId !== outcome.candidateId ||
          selections[outcomeIndex]?.selectionHash !== outcome.selectionHash) {
        throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan outcome chain is invalid');
      }
      head = outcomeHash;
      if (outcome.coreReceiptHashes.length > 0) lineageHead = outcome.candidateId;
      outcomes.push(outcome);
      selectionOutcomeCounts.set(
        outcome.selectionHash,
        selectionOutcomeCounts.get(outcome.selectionHash)! + 1,
      );
    }
    if ([...selectionOutcomeCounts.values()].some(count => count !== 1)) {
      throw new ArcValidationError(
        'INVALID_AVO_CHECKPOINT',
        'each plan selection must have exactly one outcome',
      );
    }
    if (stable.outcomeHeadHash !== head || stable.lineageHeadId !== lineageHead) {
      throw new ArcValidationError('INVALID_AVO_CHECKPOINT', 'plan archive heads are invalid');
    }
    this.candidates.clear();
    this.candidateMetrics.clear();
    this.selectionsByHash.clear();
    this.referencedCandidateIds.clear();
    this.outcomeSelectionHashes.clear();
    this.outcomeReservations.clear();
    this.archiveBytes = 0;
    this.archiveNodes = 0;
    for (const [id, candidate] of candidates) {
      const metrics = jsonMetrics(candidate);
      this.candidates.set(id, candidate);
      this.candidateMetrics.set(id, metrics);
      this.archiveBytes += metrics.bytes;
      this.archiveNodes += metrics.nodes;
    }
    this.selections.splice(0, this.selections.length, ...selections);
    this.outcomes.splice(0, this.outcomes.length, ...outcomes);
    for (const selection of selections) {
      this.selectionsByHash.set(selection.selectionHash, selection);
      for (const candidateId of selection.offeredCandidateIds) {
        this.referencedCandidateIds.add(candidateId);
      }
      const metrics = jsonMetrics(selection);
      this.archiveBytes += metrics.bytes;
      this.archiveNodes += metrics.nodes;
    }
    for (const outcome of outcomes) {
      this.outcomeSelectionHashes.add(outcome.selectionHash);
      const metrics = jsonMetrics(outcome);
      this.archiveBytes += metrics.bytes;
      this.archiveNodes += metrics.nodes;
    }
    this.assertCapacity({ bytes: 0, nodes: 0 });
    this.outcomeHeadHash = head;
    this.lineageHeadId = lineageHead;
  }
}
