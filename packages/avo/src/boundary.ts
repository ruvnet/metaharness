// SPDX-License-Identifier: MIT

import type { AgentActionDecision } from './ports.js';
import type {
  ActionObservation,
  EvaluationResult,
  EvolvableSurface,
  Hypothesis,
  PolicyDecision,
  ProtectedInvariants,
  ResourceBudget,
  SupervisorIntervention,
  VariationAction,
} from './types.js';

const SURFACES = new Set<EvolvableSurface>([
  'retrievalPolicy',
  'modelRouting',
  'contextPolicy',
  'testPolicy',
  'repairStrategy',
]);
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_COLLECTION = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(boundary: string, reason: string): never {
  throw new Error(`avo: invalid ${boundary}: ${reason}`);
}

function cloneInbound<T>(value: T, boundary: string): T {
  try {
    return structuredClone(value);
  } catch {
    return fail(boundary, 'value is not structured-cloneable');
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  // Non-empty typed arrays cannot be frozen. They are still isolated by the
  // preceding structured clone, so mutating one cannot alter authority.
  if (!ArrayBuffer.isView(object)) Object.freeze(object);
  return value;
}

/** Deep-copy then freeze data before it crosses an untrusted callback seam. */
export function frozenSnapshot<T>(value: T, boundary: string): T {
  return deepFreeze(cloneInbound(value, boundary));
}

function keys(value: Record<string, unknown>, boundary: string, allowed: readonly string[]): void {
  const permitted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !permitted.has(key));
  if (unexpected) fail(boundary, `unexpected field ${unexpected}`);
}

function stringField(value: unknown, boundary: string, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > MAX_TEXT || (!allowEmpty && value.trim().length === 0)) {
    fail(boundary, `${field} must be a bounded${allowEmpty ? '' : ' non-empty'} string`);
  }
}

function finiteNonnegative(value: unknown, boundary: string, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(boundary, `${field} must be finite and nonnegative`);
  }
}

function safeNonnegativeInteger(value: unknown, boundary: string, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(boundary, `${field} must be a nonnegative safe integer`);
  }
}

function booleanField(value: unknown, boundary: string, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(boundary, `${field} must be boolean`);
}

function assertJsonData(value: unknown, boundary: string): void {
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (entry: unknown, depth: number): void => {
    if (++visited > 100_000 || depth > 64) fail(boundary, 'data exceeds structural limits');
    if (entry === null || entry === undefined || typeof entry === 'boolean') return;
    if (typeof entry === 'string') {
      if (entry.length > MAX_TEXT) fail(boundary, 'data contains an oversized string');
      return;
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail(boundary, 'data contains a nonfinite number');
      return;
    }
    if (typeof entry !== 'object') fail(boundary, 'data must be canonical JSON-compatible content');
    const object = entry as object;
    if (seen.has(object)) fail(boundary, 'data must not contain cycles');
    seen.add(object);
    if (Array.isArray(entry)) {
      if (entry.length > MAX_COLLECTION) fail(boundary, 'data array exceeds limit');
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!isRecord(entry)) fail(boundary, 'data contains a non-plain object');
    const entries = Object.entries(entry);
    if (entries.length > MAX_COLLECTION) fail(boundary, 'data object exceeds limit');
    for (const [key, item] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(boundary, `data contains forbidden key ${key}`);
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}

function hypothesis(value: unknown, boundary: string): Hypothesis {
  if (!isRecord(value)) fail(boundary, 'hypothesis must be an object');
  keys(value, boundary, ['id', 'statement', 'causalMechanism', 'expectedEvidence', 'surface']);
  stringField(value.id, boundary, 'id');
  stringField(value.statement, boundary, 'statement');
  stringField(value.causalMechanism, boundary, 'causalMechanism');
  if (!Array.isArray(value.expectedEvidence) || value.expectedEvidence.length > 256) {
    fail(boundary, 'expectedEvidence must be a bounded string array');
  }
  value.expectedEvidence.forEach((entry, index) => stringField(entry, boundary, `expectedEvidence[${index}]`));
  if (!SURFACES.has(value.surface as EvolvableSurface)) fail(boundary, 'surface is not evolvable');
  return value as unknown as Hypothesis;
}

export function validatedAction(value: unknown, boundary = 'agent action'): VariationAction {
  const cloned = cloneInbound(value, boundary);
  if (!isRecord(cloned) || typeof cloned.kind !== 'string') fail(boundary, 'action must be an object with a kind');
  switch (cloned.kind) {
    case 'inspect':
      keys(cloned, boundary, ['kind', 'path']);
      stringField(cloned.path, boundary, 'path');
      break;
    case 'search':
      keys(cloned, boundary, ['kind', 'query', 'paths']);
      stringField(cloned.query, boundary, 'query');
      if (cloned.paths !== undefined) {
        if (!Array.isArray(cloned.paths) || cloned.paths.length > 256) fail(boundary, 'paths must be a bounded string array');
        cloned.paths.forEach((path, index) => stringField(path, boundary, `paths[${index}]`));
      }
      break;
    case 'hypothesize':
      keys(cloned, boundary, ['kind', 'hypothesis']);
      cloned.hypothesis = hypothesis(cloned.hypothesis, `${boundary}.hypothesis`);
      break;
    case 'edit':
      keys(cloned, boundary, ['kind', 'path', 'content', 'surface']);
      stringField(cloned.path, boundary, 'path');
      stringField(cloned.content, boundary, 'content', true);
      if (!SURFACES.has(cloned.surface as EvolvableSurface)) fail(boundary, 'surface is not evolvable');
      break;
    case 'execute':
      keys(cloned, boundary, ['kind', 'command']);
      stringField(cloned.command, boundary, 'command');
      break;
    case 'evaluate':
      keys(cloned, boundary, ['kind']);
      break;
    case 'revert':
      keys(cloned, boundary, ['kind', 'checkpointId']);
      if (cloned.checkpointId !== undefined) stringField(cloned.checkpointId, boundary, 'checkpointId');
      break;
    case 'branch':
      keys(cloned, boundary, ['kind', 'parentCandidateId']);
      stringField(cloned.parentCandidateId, boundary, 'parentCandidateId');
      break;
    case 'consultMemory':
      keys(cloned, boundary, ['kind', 'query', 'limit']);
      stringField(cloned.query, boundary, 'query');
      if (cloned.limit !== undefined
        && (!Number.isSafeInteger(cloned.limit) || (cloned.limit as number) <= 0 || (cloned.limit as number) > 100)) {
        fail(boundary, 'limit must be a safe integer between 1 and 100');
      }
      break;
    case 'commit':
      keys(cloned, boundary, ['kind', 'summary']);
      stringField(cloned.summary, boundary, 'summary');
      break;
    default:
      fail(boundary, `unknown action kind ${cloned.kind}`);
  }
  return cloned as unknown as VariationAction;
}

export function validatedAgentSelection(value: unknown): VariationAction | AgentActionDecision {
  const cloned = cloneInbound(value, 'agent decision');
  if (!isRecord(cloned) || !Object.hasOwn(cloned, 'action')) return validatedAction(cloned);
  keys(cloned, 'agent decision', ['action', 'costUsd', 'durationMs', 'receipt']);
  finiteNonnegative(cloned.costUsd, 'agent decision', 'costUsd');
  finiteNonnegative(cloned.durationMs, 'agent decision', 'durationMs');
  const action = validatedAction(cloned.action);
  if (cloned.receipt !== undefined) {
    if (!isRecord(cloned.receipt)) fail('agent decision', 'receipt must be a plain object');
    assertJsonData(cloned.receipt, 'agent decision receipt');
  }
  return { action, costUsd: cloned.costUsd, durationMs: cloned.durationMs, receipt: cloned.receipt };
}

export function validatedPolicyDecision(value: unknown, expectedVersion: string): PolicyDecision {
  const cloned = cloneInbound(value, 'policy decision');
  if (!isRecord(cloned)) fail('policy decision', 'decision must be an object');
  keys(cloned, 'policy decision', ['verdict', 'reason', 'policyVersion', 'riskCharge']);
  if (!['allow', 'deny', 'require-approval'].includes(String(cloned.verdict))) fail('policy decision', 'verdict is invalid');
  stringField(cloned.reason, 'policy decision', 'reason');
  if (cloned.policyVersion !== expectedVersion) fail('policy decision', 'policyVersion does not match the active policy');
  finiteNonnegative(cloned.riskCharge, 'policy decision', 'riskCharge');
  return cloned as unknown as PolicyDecision;
}

export function validatedApproval(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('approval decision', 'approval must be boolean');
  return value;
}

export function validatedEvaluation(value: unknown, expectedVersion: string): EvaluationResult {
  const cloned = cloneInbound(value, 'evaluation result');
  if (!isRecord(cloned)) fail('evaluation result', 'result must be an object');
  keys(cloned, 'evaluation result', [
    'evaluatorVersion', 'correct', 'safe', 'replayable', 'noRegression', 'budgetValid',
    'quality', 'costUsd', 'wallTimeMs', 'policyViolations', 'rollbackRequired',
    'protectedTestsPassed', 'scoreSamples', 'lowerConfidenceBound', 'evidence', 'failureSignature',
  ]);
  if (cloned.evaluatorVersion !== expectedVersion) fail('evaluation result', 'evaluatorVersion does not match the active evaluator');
  for (const field of ['correct', 'safe', 'replayable', 'noRegression', 'budgetValid', 'protectedTestsPassed'] as const) {
    booleanField(cloned[field], 'evaluation result', field);
  }
  if (cloned.rollbackRequired !== undefined) booleanField(cloned.rollbackRequired, 'evaluation result', 'rollbackRequired');
  finiteNonnegative(cloned.quality, 'evaluation result', 'quality');
  if (cloned.quality > 1) fail('evaluation result', 'quality must not exceed 1');
  finiteNonnegative(cloned.costUsd, 'evaluation result', 'costUsd');
  finiteNonnegative(cloned.wallTimeMs, 'evaluation result', 'wallTimeMs');
  safeNonnegativeInteger(cloned.policyViolations, 'evaluation result', 'policyViolations');
  if (cloned.lowerConfidenceBound !== undefined) {
    finiteNonnegative(cloned.lowerConfidenceBound, 'evaluation result', 'lowerConfidenceBound');
  }
  if (cloned.scoreSamples !== undefined) {
    if (!Array.isArray(cloned.scoreSamples) || cloned.scoreSamples.length > MAX_COLLECTION) {
      fail('evaluation result', 'scoreSamples must be a bounded numeric array');
    }
    for (const [index, sample] of cloned.scoreSamples.entries()) {
      finiteNonnegative(sample, 'evaluation result', `scoreSamples[${index}]`);
      if (sample > 1) fail('evaluation result', `scoreSamples[${index}] must not exceed 1`);
    }
  }
  if (!isRecord(cloned.evidence)) fail('evaluation result', 'evidence must be a plain object');
  assertJsonData(cloned.evidence, 'evaluation evidence');
  if (cloned.failureSignature !== undefined) stringField(cloned.failureSignature, 'evaluation result', 'failureSignature');
  return cloned as unknown as EvaluationResult;
}

export function validatedObservation(value: unknown): ActionObservation {
  const cloned = cloneInbound(value, 'environment observation');
  if (!isRecord(cloned)) fail('environment observation', 'observation must be an object');
  keys(cloned, 'environment observation', [
    'ok', 'stdout', 'stderr', 'exitCode', 'durationMs', 'costUsd', 'workspaceDigest', 'data', 'failureSignature',
  ]);
  booleanField(cloned.ok, 'environment observation', 'ok');
  if (cloned.stdout !== undefined) stringField(cloned.stdout, 'environment observation', 'stdout', true);
  if (cloned.stderr !== undefined) stringField(cloned.stderr, 'environment observation', 'stderr', true);
  if (cloned.exitCode !== undefined) safeNonnegativeInteger(cloned.exitCode, 'environment observation', 'exitCode');
  finiteNonnegative(cloned.durationMs, 'environment observation', 'durationMs');
  finiteNonnegative(cloned.costUsd, 'environment observation', 'costUsd');
  stringField(cloned.workspaceDigest, 'environment observation', 'workspaceDigest');
  if (cloned.data !== undefined) assertJsonData(cloned.data, 'environment observation data');
  if (cloned.failureSignature !== undefined) stringField(cloned.failureSignature, 'environment observation', 'failureSignature');
  return cloned as unknown as ActionObservation;
}

export function validatedBranch(value: unknown): { branchId: string; workspaceDigest: string } {
  const cloned = cloneInbound(value, 'environment branch');
  if (!isRecord(cloned)) fail('environment branch', 'branch must be an object');
  keys(cloned, 'environment branch', ['branchId', 'workspaceDigest']);
  stringField(cloned.branchId, 'environment branch', 'branchId');
  stringField(cloned.workspaceDigest, 'environment branch', 'workspaceDigest');
  return cloned as { branchId: string; workspaceDigest: string };
}

export function validatedIntervention(value: unknown, expectedPolicyVersion: string): SupervisorIntervention | null {
  const cloned = cloneInbound(value, 'supervisor decision');
  if (cloned === null) return null;
  if (!isRecord(cloned)) fail('supervisor decision', 'intervention must be an object or null');
  keys(cloned, 'supervisor decision', [
    'trigger', 'reason', 'dominantFailure', 'alternateCandidateId', 'strategies', 'explorationAllocation', 'policyVersion',
  ]);
  if (!['plateau', 'repeated-failure', 'low-novelty', 'cost-progress'].includes(String(cloned.trigger))) {
    fail('supervisor decision', 'trigger is invalid');
  }
  stringField(cloned.reason, 'supervisor decision', 'reason');
  if (cloned.dominantFailure !== undefined) stringField(cloned.dominantFailure, 'supervisor decision', 'dominantFailure');
  if (cloned.alternateCandidateId !== undefined) stringField(cloned.alternateCandidateId, 'supervisor decision', 'alternateCandidateId');
  if (!Array.isArray(cloned.strategies) || cloned.strategies.length !== 3) {
    fail('supervisor decision', 'strategies must contain exactly three hypotheses');
  }
  cloned.strategies = cloned.strategies.map((entry, index) => hypothesis(entry, `supervisor strategy ${index}`));
  finiteNonnegative(cloned.explorationAllocation, 'supervisor decision', 'explorationAllocation');
  if (cloned.explorationAllocation > 1) fail('supervisor decision', 'explorationAllocation must not exceed 1');
  if (cloned.policyVersion !== expectedPolicyVersion) fail('supervisor decision', 'policyVersion does not match the active policy');
  return cloned as unknown as SupervisorIntervention;
}

export function validateConfiguration(budget: ResourceBudget, invariants: ProtectedInvariants): void {
  if (!Number.isSafeInteger(budget.maxActions) || budget.maxActions <= 0) fail('resource budget', 'maxActions must be positive');
  if (!Number.isSafeInteger(budget.maxBranchActions) || budget.maxBranchActions <= 0) {
    fail('resource budget', 'maxBranchActions must be positive');
  }
  finiteNonnegative(budget.maxCostUsd, 'resource budget', 'maxCostUsd');
  finiteNonnegative(budget.maxWallTimeMs, 'resource budget', 'maxWallTimeMs');
  finiteNonnegative(budget.riskBudget, 'resource budget', 'riskBudget');
  finiteNonnegative(invariants.promotionDelta, 'protected invariants', 'promotionDelta');
}
