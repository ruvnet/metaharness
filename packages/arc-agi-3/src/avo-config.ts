import { ArcValidationError, hashArcValue } from './canonical.js';
import type {
  ArcAblationArm,
  ArcAvoConfig,
  ArcAvoConfigInput,
  ArcAvoFeatures,
  ArcPlanSelectorWeights,
} from './avo-types.js';

const DEFAULT_SELECTOR: ArcPlanSelectorWeights = Object.freeze({
  expectedProgress: 0.45,
  predictionFit: 0.20,
  novelty: 0.20,
  ruleConfidence: 0.15,
  noEffectRisk: 0.20,
  actionCost: 0.10,
});

const OFF: ArcAvoFeatures = Object.freeze({
  candidatePlanSelection: false,
  planLineage: false,
  semanticRuleMemory: false,
  beliefFrontier: false,
  supervisorGate: 'OFF',
  guardedExecution: false,
  retrodictiveWorldModel: false,
});

const NAMED_FEATURES: Readonly<Record<Exclude<ArcAblationArm, 'CUSTOM'>, ArcAvoFeatures>> =
  Object.freeze({
    DIRECT_ACTOR: OFF,
    AVO_LINEAGE: Object.freeze({
      ...OFF,
      candidatePlanSelection: true,
      planLineage: true,
    }),
    AVO_MEMORY: Object.freeze({
      ...OFF,
      candidatePlanSelection: true,
      planLineage: true,
      semanticRuleMemory: true,
    }),
    AVO_SUPERVISOR_MEMORY: Object.freeze({
      ...OFF,
      candidatePlanSelection: true,
      planLineage: true,
      semanticRuleMemory: true,
      supervisorGate: 'BLOCKING',
    }),
    AVO_FULL: Object.freeze({
      candidatePlanSelection: true,
      planLineage: true,
      semanticRuleMemory: true,
      beliefFrontier: true,
      supervisorGate: 'BLOCKING',
      guardedExecution: true,
      retrodictiveWorldModel: false,
    }),
    AVO_FULL_RETRODICTION: Object.freeze({
      candidatePlanSelection: true,
      planLineage: true,
      semanticRuleMemory: true,
      beliefFrontier: true,
      supervisorGate: 'BLOCKING',
      guardedExecution: true,
      retrodictiveWorldModel: true,
    }),
  });

const ARMS = new Set<ArcAblationArm>([
  'DIRECT_ACTOR',
  'AVO_LINEAGE',
  'AVO_MEMORY',
  'AVO_SUPERVISOR_MEMORY',
  'AVO_FULL',
  'AVO_FULL_RETRODICTION',
  'CUSTOM',
]);
const INPUT_KEYS = new Set([
  'arm',
  'features',
  'maxCandidatesPerDecision',
  'maxPlanSteps',
  'supportErrorMax',
  'contradictionErrorMin',
  'selector',
  'configHash',
]);
const FEATURE_KEYS = new Set<keyof ArcAvoFeatures>([
  'candidatePlanSelection',
  'planLineage',
  'semanticRuleMemory',
  'beliefFrontier',
  'supervisorGate',
  'guardedExecution',
  'retrodictiveWorldModel',
]);
const SELECTOR_KEYS = new Set<keyof ArcPlanSelectorWeights>([
  'expectedProgress',
  'predictionFit',
  'novelty',
  'ruleConfidence',
  'noEffectRisk',
  'actionCost',
]);

function assertPlain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key =>
        typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', `${label} must be a plain data object`);
  }
}

function resolveFeatures(arm: ArcAblationArm, input: unknown): ArcAvoFeatures {
  if (arm !== 'CUSTOM') {
    if (input !== undefined) {
      throw new ArcValidationError(
        'INVALID_AVO_CONFIG',
        'named AVO arms cannot override their feature set',
      );
    }
    return NAMED_FEATURES[arm];
  }
  assertPlain(input, 'CUSTOM features');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== FEATURE_KEYS.size || keys.some(key =>
    typeof key !== 'string' || !FEATURE_KEYS.has(key as keyof ArcAvoFeatures))) {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      'CUSTOM features must contain the complete exact feature set',
    );
  }
  for (const key of FEATURE_KEYS) {
    if (key === 'supervisorGate') continue;
    if (typeof input[key] !== 'boolean') {
      throw new ArcValidationError('INVALID_AVO_CONFIG', `${key} must be boolean`);
    }
  }
  if (input.supervisorGate !== 'OFF' && input.supervisorGate !== 'BLOCKING') {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      'supervisorGate must be OFF or BLOCKING',
    );
  }
  const features = Object.freeze({ ...input }) as unknown as ArcAvoFeatures;
  if (features.planLineage && !features.candidatePlanSelection) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', 'planLineage requires candidatePlanSelection');
  }
  if (features.guardedExecution && !features.candidatePlanSelection) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', 'guardedExecution requires candidatePlanSelection');
  }
  if (features.retrodictiveWorldModel &&
      (!features.candidatePlanSelection || !features.semanticRuleMemory)) {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      'retrodictiveWorldModel requires candidate selection and semantic rule memory',
    );
  }
  return features;
}

function resolveSelector(input: unknown): ArcPlanSelectorWeights {
  if (input !== undefined) {
    assertPlain(input, 'selector');
    if (Reflect.ownKeys(input).some(key =>
      typeof key !== 'string' || !SELECTOR_KEYS.has(key as keyof ArcPlanSelectorWeights))) {
      throw new ArcValidationError('INVALID_AVO_CONFIG', 'selector contains an unexpected field');
    }
  }
  const selector = { ...DEFAULT_SELECTOR, ...(input ?? {}) } as ArcPlanSelectorWeights;
  for (const [name, value] of Object.entries(selector)) {
    if (!Number.isFinite(value) || value < 0 || value > 10) {
      throw new ArcValidationError(
        'INVALID_AVO_CONFIG',
        `selector weight ${name} must be finite and in 0..10`,
      );
    }
  }
  if (Object.values(selector).every(value => value === 0)) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', 'at least one selector weight is required');
  }
  return Object.freeze(selector);
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1 || (resolved as number) > maximum) {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      `${label} must be an integer in 1..${maximum}`,
    );
  }
  return resolved as number;
}

function unitInterval(value: unknown, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || (resolved as number) < 0 || (resolved as number) > 1) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', `${label} must be in 0..1`);
  }
  return resolved as number;
}

/** Resolve and hash the exact cognitive feature profile used by an ARC run. */
export function resolveArcAvoConfig(
  raw: ArcAvoConfig | ArcAvoConfigInput,
): ArcAvoConfig {
  assertPlain(raw, 'AVO config');
  if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !INPUT_KEYS.has(key))) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', 'AVO config contains an unexpected field');
  }
  const arm = raw.arm;
  if (typeof arm !== 'string' || !ARMS.has(arm as ArcAblationArm)) {
    throw new ArcValidationError('INVALID_AVO_CONFIG', 'AVO arm is invalid');
  }
  const features = resolveFeatures(
    arm as ArcAblationArm,
    arm === 'CUSTOM' ? raw.features : undefined,
  );
  if (arm !== 'CUSTOM' && 'features' in raw && !('configHash' in raw)) {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      'named AVO arms cannot override their feature set',
    );
  }
  if ('configHash' in raw && arm !== 'CUSTOM') {
    const expected = NAMED_FEATURES[arm as Exclude<ArcAblationArm, 'CUSTOM'>];
    if (hashArcValue(raw.features) !== hashArcValue(expected)) {
      throw new ArcValidationError('INVALID_AVO_CONFIG', 'resolved named-arm features differ');
    }
  }
  const supportErrorMax = unitInterval(raw.supportErrorMax, 0.20, 'supportErrorMax');
  const contradictionErrorMin = unitInterval(
    raw.contradictionErrorMin,
    0.60,
    'contradictionErrorMin',
  );
  if (supportErrorMax >= contradictionErrorMin) {
    throw new ArcValidationError(
      'INVALID_AVO_CONFIG',
      'supportErrorMax must be less than contradictionErrorMin',
    );
  }
  const body = Object.freeze({
    arm: arm as ArcAblationArm,
    features,
    maxCandidatesPerDecision: boundedInteger(
      raw.maxCandidatesPerDecision,
      4,
      8,
      'maxCandidatesPerDecision',
    ),
    maxPlanSteps: boundedInteger(raw.maxPlanSteps, 8, 32, 'maxPlanSteps'),
    supportErrorMax,
    contradictionErrorMin,
    selector: resolveSelector(raw.selector),
  });
  const config = Object.freeze({ ...body, configHash: hashArcValue(body) });
  if ('configHash' in raw && raw.configHash !== config.configHash) {
    throw new ArcValidationError('AVO_CONFIG_MISMATCH', 'AVO config hash does not match its body');
  }
  return config;
}

export function arcAvoFeaturesForArm(
  arm: Exclude<ArcAblationArm, 'CUSTOM'>,
): ArcAvoFeatures {
  return NAMED_FEATURES[arm];
}

export { DEFAULT_SELECTOR as DEFAULT_ARC_PLAN_SELECTOR };
