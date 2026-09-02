import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { observableEdgeKey, validateArcAction } from '@metaharness/arc-agi-3';

import type { LogicalClock } from './fixture.js';
import type {
  CandidateAction,
  DriverUsage,
  MeteredModelSummary,
  ModelDriver,
  ModelTurnRequest,
  ModelTurnResponse,
} from './types.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export const MAX_FILE_BROKER_RESPONSE_BYTES = 256 * 1024;

async function readBoundedResponse(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat();
    if (before.size > MAX_FILE_BROKER_RESPONSE_BYTES) {
      throw new Error(`file broker response exceeds ${MAX_FILE_BROKER_RESPONSE_BYTES} bytes`);
    }
    // The extra byte detects growth after stat without ever allocating or
    // reading proportional to an attacker-controlled file size.
    const buffer = Buffer.alloc(MAX_FILE_BROKER_RESPONSE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BROKER_RESPONSE_BYTES) {
      throw new Error(`file broker response exceeds ${MAX_FILE_BROKER_RESPONSE_BYTES} bytes`);
    }
    const after = await handle.stat();
    if (after.size > MAX_FILE_BROKER_RESPONSE_BYTES) {
      throw new Error(`file broker response exceeds ${MAX_FILE_BROKER_RESPONSE_BYTES} bytes`);
    }
    if (after.size !== offset) {
      throw new Error('file broker response changed while it was being read');
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactDataRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => {
    if (typeof key !== 'string' || !allowed.has(key)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  }) || [...required].some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(`${label} fields do not match the exact schema`);
  }
}

function assertPlainJson(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new TypeError(`${label} exceeds the maximum JSON depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) {
      throw new TypeError(`${label} must be a dense plain array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${label} must not contain sparse or accessor elements`);
      }
      assertPlainJson(descriptor.value, `${label}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must contain only plain JSON data`);
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label} must not contain symbols, accessors, or hidden fields`);
    }
    assertPlainJson(descriptor.value, `${label}.${key}`, depth + 1);
  }
}

function clonePlainJson<T>(value: T, label: string): T {
  assertPlainJson(value, label);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
    throw new TypeError(`${label} exceeds 256 KiB`);
  }
  return JSON.parse(encoded) as T;
}

function validateCandidate(value: unknown): CandidateAction {
  assertExactDataRecord(
    value,
    new Set(['action', 'hypothesis', 'confidence']),
    new Set(['action', 'hypothesis', 'confidence']),
    'candidate action',
  );
  if (!isRecord(value.action)) throw new TypeError('candidate action.action must be an object');
  const actionKeys = value.action.name === 'ACTION6'
    ? new Set(['name', 'x', 'y'])
    : new Set(['name']);
  assertExactDataRecord(value.action, actionKeys, actionKeys, 'candidate ARC action');
  validateArcAction(value.action as never);
  if (
    typeof value.hypothesis !== 'string'
    || value.hypothesis.trim().length === 0
    || value.hypothesis.length > 4_096
    || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new TypeError('candidate hypothesis or confidence is invalid');
  }
  return Object.freeze({
    action: Object.freeze({ ...value.action }) as CandidateAction['action'],
    hypothesis: value.hypothesis,
    confidence: value.confidence,
  });
}

function validateUsage(value: unknown): DriverUsage {
  assertExactDataRecord(
    value,
    new Set(['inputUnits', 'outputUnits', 'reasoningUnits']),
    new Set(),
    'model usage',
  );
  const usage: Record<string, number> = {};
  for (const key of ['inputUnits', 'outputUnits', 'reasoningUnits'] as const) {
    const unit = value[key];
    if (unit === undefined) continue;
    if (!Number.isSafeInteger(unit) || (unit as number) < 0 || (unit as number) > 1_000_000_000_000) {
      throw new TypeError(`${key} must be a non-negative safe integer no greater than 1e12`);
    }
    usage[key] = unit as number;
  }
  return Object.freeze(usage);
}

export function validateModelTurnResponse(
  value: unknown,
  request: ModelTurnRequest,
): ModelTurnResponse {
  const common = ['schema', 'requestId', 'latencyMs', 'usage'];
  const kindField = request.kind === 'PLAN'
    ? 'candidateActions'
    : request.kind === 'REFLECT' ? 'reflection' : 'supervisorDirective';
  assertExactDataRecord(
    value,
    new Set([...common, kindField]),
    new Set(['schema', 'requestId', kindField]),
    `${request.kind} model response`,
  );
  if (value.schema !== 'metaharness.arc_agi_3.model_turn_response.v1'
      || value.requestId !== request.requestId) {
    throw new TypeError('model response schema or request id is invalid');
  }
  if (value.latencyMs !== undefined && (
    typeof value.latencyMs !== 'number'
    || !Number.isFinite(value.latencyMs)
    || value.latencyMs < 0
    || value.latencyMs > 86_400_000
  )) {
    throw new TypeError('model response latencyMs must be finite and in 0..86400000');
  }
  const usage = value.usage === undefined ? undefined : validateUsage(value.usage);
  let candidates: readonly CandidateAction[] | undefined;
  if (request.kind === 'PLAN') {
    if (!Array.isArray(value.candidateActions) || value.candidateActions.length > 8) {
      throw new TypeError('candidateActions must be an array with at most eight items');
    }
    assertPlainJson(value.candidateActions, 'candidateActions');
    candidates = Object.freeze(value.candidateActions.map(validateCandidate));
    if (candidates.length === 0) {
      throw new TypeError('PLAN responses require at least one candidate action');
    }
  }
  if (request.kind === 'REFLECT' && (
    typeof value.reflection !== 'string'
    || value.reflection.trim().length === 0
    || value.reflection.length > 16_000
  )) {
    throw new TypeError('REFLECT responses require bounded reflection text');
  }
  if (request.kind === 'SUPERVISE' && !isRecord(value.supervisorDirective)) {
    throw new TypeError('SUPERVISE responses require a typed supervisorDirective');
  }
  const supervisorDirective = request.kind === 'SUPERVISE'
    ? clonePlainJson(value.supervisorDirective, 'supervisorDirective')
    : undefined;
  return Object.freeze({
    schema: 'metaharness.arc_agi_3.model_turn_response.v1',
    requestId: request.requestId,
    ...(candidates === undefined ? {} : { candidateActions: candidates }),
    ...(request.kind === 'REFLECT' ? { reflection: value.reflection as string } : {}),
    ...(supervisorDirective === undefined ? {} : {
      supervisorDirective: supervisorDirective as ModelTurnResponse['supervisorDirective'],
    }),
    ...(value.latencyMs === undefined ? {} : { latencyMs: value.latencyMs as number }),
    ...(usage === undefined ? {} : { usage }),
  });
}

export class ModelTurnBudgetError extends Error {
  constructor() {
    super('frozen model-turn budget exhausted');
    this.name = 'ModelTurnBudgetError';
  }
}

export class MeteredModelDriver implements ModelDriver {
  readonly id: string;
  readonly latencySource: ModelDriver['latencySource'];
  readonly #inner: ModelDriver;
  readonly #maxTurns: number;
  readonly #clock?: LogicalClock;
  #turnCount = 0;
  #planTurns = 0;
  #reflectionTurns = 0;
  #supervisorTurns = 0;
  #failedTurnCount = 0;
  #latencyMs = 0;
  #turnsMissingUsage = 0;
  #usage: Required<DriverUsage> = { inputUnits: 0, outputUnits: 0, reasoningUnits: 0 };

  constructor(inner: ModelDriver, maxTurns: number, clock?: LogicalClock) {
    if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
      throw new TypeError('max model turns must be a positive integer');
    }
    this.#inner = inner;
    this.#maxTurns = maxTurns;
    this.#clock = clock;
    this.id = inner.id;
    this.latencySource = inner.latencySource;
  }

  get nextTurnIndex(): number {
    return this.#turnCount;
  }

  get remainingTurns(): number {
    return this.#maxTurns - this.#turnCount;
  }

  async turn(request: Readonly<ModelTurnRequest>): Promise<ModelTurnResponse> {
    if (this.#turnCount >= this.#maxTurns) throw new ModelTurnBudgetError();
    if (request.turnIndex !== this.#turnCount) {
      throw new Error(`model turn index ${request.turnIndex} does not match ${this.#turnCount}`);
    }
    // Dispatch consumes a frozen compute slot even if the provider fails or
    // returns an invalid payload. Bad responses cannot evade the turn budget.
    this.#turnCount += 1;
    if (request.kind === 'PLAN') this.#planTurns += 1;
    if (request.kind === 'REFLECT') this.#reflectionTurns += 1;
    if (request.kind === 'SUPERVISE') this.#supervisorTurns += 1;
    const started = performance.now();
    try {
      const raw = await this.#inner.turn(request);
      const elapsed = performance.now() - started;
      const response = validateModelTurnResponse(raw, request);
      const latency = response.latencyMs ?? elapsed;
      this.#latencyMs += latency;
      this.#clock?.advance(latency);
      if (response.usage?.inputUnits === undefined
          || response.usage.outputUnits === undefined
          || response.usage.reasoningUnits === undefined) {
        this.#turnsMissingUsage += 1;
      }
      this.#usage = {
        inputUnits: this.#usage.inputUnits + (response.usage?.inputUnits ?? 0),
        outputUnits: this.#usage.outputUnits + (response.usage?.outputUnits ?? 0),
        reasoningUnits: this.#usage.reasoningUnits + (response.usage?.reasoningUnits ?? 0),
      };
      return response;
    } catch (error) {
      const failedLatency = performance.now() - started;
      this.#failedTurnCount += 1;
      this.#turnsMissingUsage += 1;
      this.#latencyMs += failedLatency;
      this.#clock?.advance(failedLatency);
      throw error;
    }
  }

  summary(): MeteredModelSummary {
    return Object.freeze({
      turnCount: this.#turnCount,
      failedTurnCount: this.#failedTurnCount,
      planTurns: this.#planTurns,
      reflectionTurns: this.#reflectionTurns,
      supervisorTurns: this.#supervisorTurns,
      latencyMs: this.#latencyMs,
      latencySource: this.latencySource,
      usage: Object.freeze({ ...this.#usage }),
      totalUsageUnits: this.#usage.inputUnits
        + this.#usage.outputUnits
        + this.#usage.reasoningUnits,
      usageComplete: this.#turnsMissingUsage === 0,
    });
  }
}

export class ScriptedMechanismDriver implements ModelDriver {
  readonly id = 'scripted-mechanism-driver-v1';
  readonly latencySource = 'fixture-simulated' as const;

  async turn(request: Readonly<ModelTurnRequest>): Promise<ModelTurnResponse> {
    if (request.kind === 'REFLECT') {
      return {
        schema: 'metaharness.arc_agi_3.model_turn_response.v1',
        requestId: request.requestId,
        reflection: 'The last choice may be inert; compare alternatives without assuming hidden rules.',
        latencyMs: 6,
        usage: { inputUnits: 96, outputUnits: 32, reasoningUnits: 24 },
      };
    }
    if (request.kind === 'SUPERVISE') {
      const bundle = request.supervisorCase;
      if (!bundle) throw new Error('scripted supervisor requires a case bundle');
      const evidence = new Set(bundle.case.evidenceReceiptHashes);
      const repeated = [...bundle.receiptSummary.recent].reverse()
        .find(receipt => evidence.has(receipt.receiptHash));
      const prohibitedEdges = repeated
        ? [observableEdgeKey(repeated.preObservationHash, repeated.action)]
        : [];
      return {
        schema: 'metaharness.arc_agi_3.model_turn_response.v1',
        requestId: request.requestId,
        supervisorDirective: {
          caseId: bundle.case.id,
          caseHash: bundle.case.caseHash,
          expectedObservationHash: bundle.observation.observationHash,
          observationHash: bundle.observation.observationHash,
          mode: 'EXPAND_FRONTIER',
          diagnosis: `Scripted bounded response to ${bundle.case.trigger}`,
          requiredEvidence: bundle.case.evidenceReceiptHashes,
          prohibitedEdges,
          actionBudget: 8,
          expiresAfterActions: 8,
        },
        latencyMs: 6,
        usage: { inputUnits: 96, outputUnits: 32, reasoningUnits: 24 },
      };
    }

    const actions = [...(request.availableActions ?? [])]
      .filter(name => name !== 'RESET' && name !== 'ACTION6')
      .sort();
    if (actions.length === 0) throw new Error('scripted planner has no supported offered action');
    const selected = request.arm === 'avo' ? actions : actions.slice(0, 1);
    return {
      schema: 'metaharness.arc_agi_3.model_turn_response.v1',
      requestId: request.requestId,
      candidateActions: selected.map((name, index) => ({
        action: { name },
        hypothesis: request.arm === 'avo'
          ? `Bounded variant ${index + 1}: test ${name} against the current frontier.`
          : `Direct choice: test the first offered action ${name}.`,
        confidence: 0.5,
      })),
      latencyMs: 6,
      usage: {
        inputUnits: 80,
        outputUnits: request.arm === 'direct' ? 20 : 60,
        reasoningUnits: request.arm === 'direct' ? 16 : 32,
      },
    };
  }
}

export interface FileBrokerDriverOptions {
  readonly directory: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

/**
 * Generic file broker for a manual ChatGPT conversation or any external model.
 * It deliberately contains no provider SDK and never reads an API key.
 */
export class FileBrokerModelDriver implements ModelDriver {
  readonly id = 'file-broker-model-driver-v1';
  readonly latencySource = 'wall-clock' as const;
  readonly #directory: string;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;

  constructor(options: FileBrokerDriverOptions) {
    if (!options.directory.trim()) throw new TypeError('file broker directory is required');
    this.#directory = options.directory;
    this.#timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.#pollIntervalMs = options.pollIntervalMs ?? 200;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError('file broker timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 10) {
      throw new TypeError('file broker poll interval must be at least 10ms');
    }
  }

  async turn(request: Readonly<ModelTurnRequest>): Promise<ModelTurnResponse> {
    const requests = join(this.#directory, 'requests');
    const responses = join(this.#directory, 'responses');
    const archive = join(this.#directory, 'archive');
    await Promise.all([
      mkdir(requests, { recursive: true, mode: 0o700 }),
      mkdir(responses, { recursive: true, mode: 0o700 }),
      mkdir(archive, { recursive: true, mode: 0o700 }),
    ]);
    const requestPath = join(requests, `${request.requestId}.json`);
    const responsePath = join(responses, `${request.requestId}.json`);
    const temporaryPath = `${requestPath}.partial`;
    await writeFile(temporaryPath, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, requestPath);

    const started = performance.now();
    let responseText: string | undefined;
    while (performance.now() - started < this.#timeoutMs) {
      try {
        responseText = await readBoundedResponse(responsePath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(this.#pollIntervalMs);
    }
    if (responseText === undefined) {
      throw new Error(`file broker timed out waiting for ${responsePath}`);
    }
    const parsed = JSON.parse(responseText) as unknown;
    const response = validateModelTurnResponse(parsed, request);
    await Promise.all([
      rename(requestPath, join(archive, `${request.requestId}.request.json`)),
      rename(responsePath, join(archive, `${request.requestId}.response.json`)),
    ]);
    return response;
  }
}
