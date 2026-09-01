import { hashArcValue, validateArcAction } from './canonical.js';
import type { BeliefGraph } from './belief-graph.js';
import type {
  ArcEpisode,
  ExactArcObservation,
  ExplicitSupervisorCaseRequest,
  SupervisorCase,
  SupervisorDirective,
  SupervisorDirectiveCommit,
  SupervisorMode,
  SupervisorThresholds,
  SupervisorTrigger,
  TransitionReceipt,
} from './types.js';

export const DEFAULT_SUPERVISOR_THRESHOLDS: SupervisorThresholds = Object.freeze({
  repeatedEdgeCount: 2,
  noEffectCount: 3,
  noEffectWindow: 6,
  predictionErrorMean: 0.35,
  predictionErrorWindow: 5,
  stagnationWindow: 8,
  cycleWithinComponentCount: 7,
  coordinateProbeCount: 8,
});

export function resolveSupervisorThresholds(
  partial: Partial<SupervisorThresholds> = {},
): SupervisorThresholds {
  const resolved = Object.freeze({ ...DEFAULT_SUPERVISOR_THRESHOLDS, ...partial });
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value <= 0 ||
        (key !== 'predictionErrorMean' && !Number.isInteger(value))) {
      throw new Error(`supervisor threshold ${key} must be positive`);
    }
  }
  if (resolved.predictionErrorMean > 1) {
    throw new Error('predictionErrorMean must be in 0..1');
  }
  return resolved;
}

interface DetectionInput {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly observation: ExactArcObservation;
  readonly episodes: readonly ArcEpisode[];
  readonly receipts: readonly TransitionReceipt[];
  readonly graph: BeliefGraph;
  readonly thresholds: SupervisorThresholds;
  readonly planDivergenceReceiptHash?: string;
  readonly explicit?: ExplicitSupervisorCaseRequest;
}

interface Detection {
  readonly trigger: SupervisorTrigger;
  readonly evidenceReceiptHashes: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
}

function tail<T>(values: readonly T[], count: number): readonly T[] {
  return values.slice(Math.max(0, values.length - count));
}

function detect(input: DetectionInput): Detection | null {
  if (input.explicit) {
    return {
      trigger: input.explicit.trigger,
      evidenceReceiptHashes: Object.freeze([...input.explicit.evidenceReceiptHashes]),
      metrics: Object.freeze({ ...(input.explicit.metrics ?? {}) }),
    };
  }
  if (input.observation.state === 'GAME_OVER') {
    const last = input.receipts.at(-1);
    return {
      trigger: 'GAME_OVER',
      evidenceReceiptHashes: Object.freeze(last ? [last.receiptHash] : []),
      metrics: Object.freeze({ stateGameOver: 1 }),
    };
  }
  if (input.planDivergenceReceiptHash) {
    return {
      trigger: 'PLAN_DIVERGENCE',
      evidenceReceiptHashes: Object.freeze([input.planDivergenceReceiptHash]),
      metrics: Object.freeze({ divergence: 1 }),
    };
  }

  const coordinateEpisodes = tail(
    input.episodes.filter(episode => episode.action.name === 'ACTION6' && episode.noEffect),
    input.thresholds.coordinateProbeCount,
  );
  if (coordinateEpisodes.length >= input.thresholds.coordinateProbeCount) {
    return {
      trigger: 'COORDINATE_PROBE',
      evidenceReceiptHashes: Object.freeze(coordinateEpisodes.map(e => e.receiptHash)),
      metrics: Object.freeze({ ineffectiveCoordinateProbes: coordinateEpisodes.length }),
    };
  }

  const recentForRepeat = tail(input.episodes, Math.max(8, input.thresholds.repeatedEdgeCount * 4));
  const repeated = new Map<string, ArcEpisode[]>();
  for (const episode of recentForRepeat) {
    const key = hashArcValue({ observation: episode.preObservationHash, action: episode.action });
    const group = repeated.get(key) ?? [];
    group.push(episode);
    repeated.set(key, group);
  }
  const repeatedGroup = [...repeated.values()]
    .filter(group => group.length >= input.thresholds.repeatedEdgeCount)
    .sort((a, b) => b.length - a.length || a[0]!.sequence - b[0]!.sequence)[0];
  if (repeatedGroup) {
    return {
      trigger: 'REPEATED_EDGE',
      evidenceReceiptHashes: Object.freeze(repeatedGroup.map(e => e.receiptHash)),
      metrics: Object.freeze({ repeatedEdgeCount: repeatedGroup.length }),
    };
  }

  const noEffectWindow = tail(input.episodes, input.thresholds.noEffectWindow);
  const noEffects = noEffectWindow.filter(episode => episode.noEffect);
  if (noEffects.length >= input.thresholds.noEffectCount) {
    return {
      trigger: 'NO_EFFECT',
      evidenceReceiptHashes: Object.freeze(noEffects.map(e => e.receiptHash)),
      metrics: Object.freeze({
        noEffectCount: noEffects.length,
        window: noEffectWindow.length,
      }),
    };
  }

  const predictionWindow = tail(input.episodes, input.thresholds.predictionErrorWindow);
  const predictionMean = predictionWindow.length === 0
    ? 0
    : predictionWindow.reduce((sum, episode) => sum + episode.predictionError, 0) /
      predictionWindow.length;
  if (predictionWindow.length >= input.thresholds.predictionErrorWindow &&
      predictionMean > input.thresholds.predictionErrorMean) {
    return {
      trigger: 'PREDICTION_ERROR',
      evidenceReceiptHashes: Object.freeze(predictionWindow.map(e => e.receiptHash)),
      metrics: Object.freeze({ predictionErrorMean: predictionMean }),
    };
  }

  const cycleWindow = tail(input.episodes, input.thresholds.cycleWithinComponentCount);
  const distinctCycleStates = new Set(cycleWindow.flatMap(episode => [
    episode.preObservationHash,
    episode.postObservationHash,
  ]));
  if (cycleWindow.length >= input.thresholds.cycleWithinComponentCount &&
      cycleWindow.every(episode => episode.progressDelta === 0) &&
      distinctCycleStates.size > 1 &&
      input.graph.componentSize(input.observation.observationHash) > 1) {
    return {
      trigger: 'CYCLE',
      evidenceReceiptHashes: Object.freeze(cycleWindow.map(e => e.receiptHash)),
      metrics: Object.freeze({
        actionsWithinComponent: cycleWindow.length,
        componentSize: input.graph.componentSize(input.observation.observationHash),
      }),
    };
  }

  const stagnationWindow = tail(input.episodes, input.thresholds.stagnationWindow);
  const distinctStagnantStates = new Set(stagnationWindow.map(e => e.postObservationHash));
  if (stagnationWindow.length >= input.thresholds.stagnationWindow &&
      stagnationWindow.every(episode => episode.progressDelta === 0) &&
      distinctStagnantStates.size <= 2) {
    return {
      trigger: 'STAGNATION',
      evidenceReceiptHashes: Object.freeze(stagnationWindow.map(e => e.receiptHash)),
      metrics: Object.freeze({
        stagnantActions: stagnationWindow.length,
        distinctStates: distinctStagnantStates.size,
      }),
    };
  }
  return null;
}

export function detectSupervisorCase(input: DetectionInput): SupervisorCase | null {
  const detected = detect(input);
  if (!detected) return null;
  const base = {
    principalScope: input.principalScope,
    opaqueGameScope: input.opaqueGameScope,
    runId: input.runId,
    trigger: detected.trigger,
    openedAtSequence: input.receipts.length,
    evidenceReceiptHashes: detected.evidenceReceiptHashes,
    metrics: detected.metrics,
    status: 'OPEN' as const,
  };
  const id = `supervisor_case_${hashArcValue(base).slice(0, 32)}`;
  const withId = { id, ...base };
  return Object.freeze({ ...withId, caseHash: hashArcValue(withId) });
}

export function resolveSupervisorCase(supervisorCase: SupervisorCase): SupervisorCase {
  const { caseHash: _oldHash, ...body } = supervisorCase;
  const resolvedBody = { ...body, status: 'RESOLVED' as const };
  return Object.freeze({ ...resolvedBody, caseHash: hashArcValue(resolvedBody) });
}

export function commitTypedSupervisorDirective(input: {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly supervisorCase: SupervisorCase;
  readonly commit: SupervisorDirectiveCommit;
  readonly sequence: number;
}): SupervisorDirective {
  if (input.commit.caseId !== input.supervisorCase.id || input.supervisorCase.status !== 'OPEN') {
    throw new Error('directive must resolve the currently open supervisor case');
  }
  if (input.commit.caseHash !== input.supervisorCase.caseHash) {
    throw new Error('directive caseHash is stale');
  }
  const expectedObservationHash = input.commit.expectedObservationHash;
  const observationHash = input.commit.observationHash ?? expectedObservationHash;
  if (!expectedObservationHash.trim() || expectedObservationHash.length > 256 ||
      !observationHash.trim() || observationHash.length > 256 ||
      expectedObservationHash !== observationHash) {
    throw new Error('directive observation hashes must be equal, non-empty, and bounded');
  }
  if (!input.commit.diagnosis.trim() || input.commit.diagnosis.length > 4_096) {
    throw new Error('directive diagnosis must be non-empty and at most 4096 characters');
  }
  const modes: readonly SupervisorMode[] = [
    'CONTINUE',
    'FALSIFY_RULE',
    'EXPAND_FRONTIER',
    'REBUILD_MODEL',
    'ROLLBACK_PLAN',
    'RESET',
    'NEW_ACTOR_CONTEXT',
    'STOP',
  ];
  if (!modes.includes(input.commit.mode)) {
    throw new Error('directive mode is invalid');
  }
  if ((input.commit.requiredEvidence?.length ?? 0) > 256 ||
      (input.commit.prohibitedEdges?.length ?? 0) > 256 ||
      (input.commit.requiredEvidence ?? []).some(value => !value.trim() || value.length > 256) ||
      (input.commit.prohibitedEdges ?? []).some(value => !value.trim() || value.length > 256)) {
    throw new Error('directive evidence and prohibited edge lists exceed bounded limits');
  }
  if (!Number.isInteger(input.commit.actionBudget) || input.commit.actionBudget < 0 ||
      input.commit.actionBudget > 10_000) {
    throw new Error('directive actionBudget must be an integer in 0..10000');
  }
  if (!Number.isInteger(input.commit.expiresAfterActions) ||
      input.commit.expiresAfterActions < 0 || input.commit.expiresAfterActions > 10_000) {
    throw new Error('directive expiresAfterActions must be an integer in 0..10000');
  }
  if (input.commit.expiresAfterActions > input.commit.actionBudget) {
    throw new Error('directive expiresAfterActions cannot exceed actionBudget');
  }
  const hasAdvice = input.commit.hypotheses !== undefined ||
    input.commit.recommendedStrategy !== undefined || input.commit.constraints !== undefined;
  if (hasAdvice) {
    if (!Array.isArray(input.commit.hypotheses) || input.commit.hypotheses.length !== 3 ||
        typeof input.commit.recommendedStrategy !== 'string' ||
        !input.commit.recommendedStrategy.trim() || input.commit.recommendedStrategy.length > 4_096 ||
        !Array.isArray(input.commit.constraints) || input.commit.constraints.length > 64 ||
        input.commit.constraints.some((value: string) => !value.trim() || value.length > 1_024) ||
        new Set(input.commit.constraints).size !== input.commit.constraints.length) {
      throw new Error('supervisor advice must contain exactly three hypotheses and bounded strategy/constraints');
    }
    for (const hypothesis of input.commit.hypotheses) {
      if (!hypothesis || !hypothesis.hypothesis.trim() || hypothesis.hypothesis.length > 4_096 ||
          !hypothesis.falsifier.trim() || hypothesis.falsifier.length > 4_096 ||
          !Array.isArray(hypothesis.evidenceReceiptHashes) ||
          hypothesis.evidenceReceiptHashes.length > 128 ||
          new Set(hypothesis.evidenceReceiptHashes).size !== hypothesis.evidenceReceiptHashes.length ||
          hypothesis.evidenceReceiptHashes.some((value: string) => !value.trim() || value.length > 256)) {
        throw new Error('supervisor hypothesis is invalid or exceeds bounded limits');
      }
      validateArcAction(hypothesis.proposedNextAction);
    }
    const normalizedHypotheses = input.commit.hypotheses.map(hypothesis =>
      hypothesis.hypothesis.trim().replace(/\s+/g, ' ').toLowerCase());
    const normalizedFalsifiers = input.commit.hypotheses.map(hypothesis =>
      hypothesis.falsifier.trim().replace(/\s+/g, ' ').toLowerCase());
    if (new Set(normalizedHypotheses).size !== 3 || new Set(normalizedFalsifiers).size !== 3) {
      throw new Error('supervisor advice requires three distinct hypotheses and falsifiers');
    }
  }
  const commitHash = hashArcValue(input.commit);
  const base = {
    principalScope: input.principalScope,
    opaqueGameScope: input.opaqueGameScope,
    runId: input.runId,
    caseId: input.supervisorCase.id,
    caseHash: input.supervisorCase.caseHash,
    expectedObservationHash,
    observationHash,
    trigger: input.supervisorCase.trigger,
    mode: input.commit.mode,
    diagnosis: input.commit.diagnosis.trim(),
    requiredEvidence: Object.freeze([...new Set(input.commit.requiredEvidence ?? [])]),
    prohibitedEdges: Object.freeze([...new Set(input.commit.prohibitedEdges ?? [])]),
    actionBudget: input.commit.actionBudget,
    expiresAfterActions: input.commit.expiresAfterActions,
    hypotheses: input.commit.hypotheses === undefined
      ? undefined
      : Object.freeze(input.commit.hypotheses.map(hypothesis => Object.freeze({
          ...hypothesis,
          evidenceReceiptHashes: Object.freeze([...hypothesis.evidenceReceiptHashes]),
          proposedNextAction: Object.freeze({ ...hypothesis.proposedNextAction }),
        }))) as SupervisorDirective['hypotheses'],
    recommendedStrategy: input.commit.recommendedStrategy?.trim(),
    constraints: input.commit.constraints === undefined
      ? undefined
      : Object.freeze([...input.commit.constraints]),
    committedAtSequence: input.sequence,
    commitHash,
  };
  const id = `supervisor_directive_${hashArcValue(base).slice(0, 32)}`;
  const withId = { id, ...base };
  return Object.freeze({ ...withId, directiveHash: hashArcValue(withId) });
}

function defaultMode(trigger: SupervisorTrigger): SupervisorMode {
  switch (trigger) {
    case 'GAME_OVER': return 'RESET';
    case 'PLAN_DIVERGENCE': return 'ROLLBACK_PLAN';
    case 'MODEL_CONTRADICTION':
    case 'PREDICTION_ERROR': return 'REBUILD_MODEL';
    case 'NO_EFFECT': return 'FALSIFY_RULE';
    case 'REPEATED_EDGE':
    case 'STAGNATION':
    case 'CYCLE':
    case 'COORDINATE_PROBE': return 'EXPAND_FRONTIER';
  }
}

export function defaultSupervisorCommit(
  supervisorCase: SupervisorCase,
  expectedObservationHash: string,
): SupervisorDirectiveCommit {
  return Object.freeze({
    caseId: supervisorCase.id,
    caseHash: supervisorCase.caseHash,
    observationHash: expectedObservationHash,
    expectedObservationHash,
    mode: defaultMode(supervisorCase.trigger),
    diagnosis: `Deterministic supervisor trigger: ${supervisorCase.trigger}`,
    requiredEvidence: supervisorCase.evidenceReceiptHashes,
    prohibitedEdges: Object.freeze([]),
    actionBudget: supervisorCase.trigger === 'GAME_OVER' ? 1 : 16,
    expiresAfterActions: supervisorCase.trigger === 'GAME_OVER' ? 1 : 16,
  });
}
