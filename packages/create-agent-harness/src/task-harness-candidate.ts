// SPDX-License-Identifier: MIT
//
// A deliberately non-executable envelope for machine-generated, task-specific
// harness proposals. Generated harnesses are evidence until independently
// evaluated and explicitly admitted by an operator-controlled runtime.

import { sha256 } from './manifest.js';

export const TASK_HARNESS_CANDIDATE_SCHEMA = 'metaharness-task-harness-candidate/v1' as const;
export const TASK_HARNESS_MODULE_KINDS = ['memory', 'planning', 'action', 'capability'] as const;

export type TaskHarnessModuleKind = (typeof TASK_HARNESS_MODULE_KINDS)[number];

export interface TaskHarnessModule {
  kind: TaskHarnessModuleKind;
  id: string;
  artifactDigest: string;
  configDigest: string;
}

export interface TaskHarnessGenerator {
  id: string;
  version: string;
  sourceDigest: string;
}

export interface TaskHarnessCandidate {
  schema: typeof TASK_HARNESS_CANDIDATE_SCHEMA;
  candidateId: string;
  taskDigest: string;
  parentDigest?: string;
  generator: TaskHarnessGenerator;
  modules: TaskHarnessModule[];
  requestedCapabilities: string[];
  generatedAt: string;
  authority: 'none';
}

export interface ValidatedTaskHarnessCandidate {
  candidate: TaskHarnessCandidate;
  candidateDigest: string;
  capabilityCeiling: string[];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MODULE_ORDER = new Map<TaskHarnessModuleKind, number>(
  TASK_HARNESS_MODULE_KINDS.map((kind, index) => [kind, index]),
);

export function validateTaskHarnessCandidate(
  unsafeInput: unknown,
  unsafeCapabilityCeiling: readonly string[],
): ValidatedTaskHarnessCandidate {
  const input = exactObject(unsafeInput, 'candidate');
  assertExactKeys(
    input,
    ['schema', 'candidateId', 'taskDigest', 'generator', 'modules', 'requestedCapabilities', 'generatedAt', 'authority'],
    ['parentDigest'],
  );

  if (input.schema !== TASK_HARNESS_CANDIDATE_SCHEMA) invalid('Unsupported task harness candidate schema');
  if (input.authority !== 'none') invalid('Task harness candidates cannot carry authority');

  const candidateId = identifier(input.candidateId, 'candidateId');
  const taskDigest = digest(input.taskDigest, 'taskDigest');
  const parentDigest = input.parentDigest === undefined ? undefined : digest(input.parentDigest, 'parentDigest');
  const generatedAt = canonicalTimestamp(input.generatedAt, 'generatedAt');
  const generator = parseGenerator(input.generator);
  const modules = parseModules(input.modules);
  const capabilityCeiling = parseCapabilityList(unsafeCapabilityCeiling, 'capability ceiling');
  const requestedCapabilities = parseCapabilityList(input.requestedCapabilities, 'requestedCapabilities');
  const allowed = new Set(capabilityCeiling);
  for (const capability of requestedCapabilities) {
    if (!allowed.has(capability)) invalid(`Requested capability exceeds operator ceiling: ${capability}`);
  }

  const candidate: TaskHarnessCandidate = {
    schema: TASK_HARNESS_CANDIDATE_SCHEMA,
    candidateId,
    taskDigest,
    ...(parentDigest === undefined ? {} : { parentDigest }),
    generator,
    modules,
    requestedCapabilities,
    generatedAt,
    authority: 'none',
  };

  return {
    candidate,
    candidateDigest: digestTaskHarnessCandidate(candidate),
    capabilityCeiling,
  };
}

export function digestTaskHarnessCandidate(candidate: TaskHarnessCandidate): string {
  return sha256(canonicalJson(candidate));
}

function parseGenerator(input: unknown): TaskHarnessGenerator {
  const generator = exactObject(input, 'generator');
  assertExactKeys(generator, ['id', 'version', 'sourceDigest']);
  const id = identifier(generator.id, 'generator.id');
  if (typeof generator.version !== 'string' || !VERSION_RE.test(generator.version)) {
    invalid('generator.version must be semantic version shaped');
  }
  return {
    id,
    version: generator.version,
    sourceDigest: digest(generator.sourceDigest, 'generator.sourceDigest'),
  };
}

function parseModules(input: unknown): TaskHarnessModule[] {
  if (!Array.isArray(input) || input.length !== TASK_HARNESS_MODULE_KINDS.length) {
    invalid('Task harness candidate requires exactly four modules');
  }
  const modules = input.map((entry, index) => {
    const module = exactObject(entry, `modules[${index}]`);
    assertExactKeys(module, ['kind', 'id', 'artifactDigest', 'configDigest']);
    if (typeof module.kind !== 'string' || !TASK_HARNESS_MODULE_KINDS.includes(module.kind as TaskHarnessModuleKind)) {
      invalid(`modules[${index}].kind is unsupported`);
    }
    return {
      kind: module.kind as TaskHarnessModuleKind,
      id: identifier(module.id, `modules[${index}].id`),
      artifactDigest: digest(module.artifactDigest, `modules[${index}].artifactDigest`),
      configDigest: digest(module.configDigest, `modules[${index}].configDigest`),
    } satisfies TaskHarnessModule;
  });
  const kinds = modules.map((module) => module.kind);
  if (new Set(kinds).size !== TASK_HARNESS_MODULE_KINDS.length) invalid('Task harness module kinds must be unique');
  for (const kind of TASK_HARNESS_MODULE_KINDS) {
    if (!kinds.includes(kind)) invalid(`Task harness candidate is missing ${kind} module`);
  }
  return modules.sort((a, b) => (MODULE_ORDER.get(a.kind) ?? 99) - (MODULE_ORDER.get(b.kind) ?? 99));
}

function parseCapabilityList(input: unknown, field: string): string[] {
  if (!Array.isArray(input) || input.length > 128) invalid(`${field} must be an array with at most 128 entries`);
  const values = input.map((value, index) => {
    if (typeof value !== 'string' || !CAPABILITY_RE.test(value)) invalid(`${field}[${index}] is invalid`);
    return value;
  });
  if (new Set(values).size !== values.length) invalid(`${field} contains duplicates`);
  return [...values].sort();
}

function canonicalTimestamp(input: unknown, field: string): string {
  if (typeof input !== 'string') invalid(`${field} must be a canonical ISO 8601 timestamp`);
  const parsed = new Date(input);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== input) {
    invalid(`${field} must be a canonical ISO 8601 timestamp`);
  }
  return input;
}

function identifier(input: unknown, field: string): string {
  if (typeof input !== 'string' || !ID_RE.test(input)) invalid(`${field} is invalid`);
  return input;
}

function digest(input: unknown, field: string): string {
  if (typeof input !== 'string' || !DIGEST_RE.test(input)) invalid(`${field} must be a lowercase SHA-256 digest`);
  return input;
}

function exactObject(input: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    invalid(`${field} must be a plain object`);
  }
  return input as Readonly<Record<string, unknown>>;
}

function assertExactKeys(
  input: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in input)) || Object.keys(input).some((key) => !allowed.has(key))) {
    invalid('Task harness candidate fields do not match the declared schema');
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const object = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) sorted[key] = canonicalize(object[key]);
  return sorted;
}

function invalid(message: string): never {
  throw new TypeError(message);
}
