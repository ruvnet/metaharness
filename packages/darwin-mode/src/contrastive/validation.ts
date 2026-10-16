import { createHash } from 'node:crypto';
import type { Budget, Component, Edit, HarnessDocument, JsonValue, Observation, Scope } from './types.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Expected plain object');
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown field');
}
export function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`);
}
/** Integer nanodollars avoid false budget denials from decimal addition. */
export function moneyUnits(value: number): number {
  finite(value, 'budget');
  const units = Math.round(value * 1e9);
  if (!Number.isSafeInteger(units) || units / 1e9 !== value) throw new Error('Budget requires exact nanodollar precision');
  return units;
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('Invalid identifier');
}

/** Snapshot untrusted JSON without invoking getters or accepting executable values. */
export function snapshot<T>(value: T, maxBytes = 262144): T {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const visit = (input: unknown, depth: number): JsonValue => {
    if (++nodes > 10000 || depth > 20) throw new Error('Input complexity limit');
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Nonfinite JSON number');
      return input;
    }
    if (typeof input === 'string') {
      bytes += Buffer.byteLength(input);
      if (bytes > maxBytes) throw new Error('Input byte limit');
      return input;
    }
    if (typeof input !== 'object') throw new Error('Expected JSON data');
    if (seen.has(input)) throw new Error('Cyclic input');
    seen.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some(key => typeof key !== 'string')) throw new Error('Symbol keys forbidden');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (forbidden.has(key) || descriptor.get || descriptor.set) throw new Error('Unsafe property');
      bytes += Buffer.byteLength(key);
    }
    let output: JsonValue;
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 4096 ||
          Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))
        throw new Error('Invalid array');
      output = Array.from({ length: input.length }, (_, i) => visit(descriptors[String(i)]?.value, depth + 1));
    } else {
      record(input);
      output = {};
      for (const key of Object.keys(descriptors).sort()) {
        if (!descriptors[key].enumerable) throw new Error('Hidden properties forbidden');
        output[key] = visit(descriptors[key].value, depth + 1);
      }
    }
    seen.delete(input);
    if (bytes > maxBytes) throw new Error('Input byte limit');
    return Object.freeze(output) as JsonValue;
  };
  const output = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new Error('Input byte limit');
  return output as T;
}
export function digestDocument(document: HarnessDocument): string {
  return createHash('sha256').update(JSON.stringify(snapshot(document))).digest('hex');
}
export function validateDocument(document: HarnessDocument): void {
  document = snapshot(document);
  record(document); keys(document, ['components']);
  if (!Array.isArray(document.components) || !document.components.length || document.components.length > 128)
    throw new Error('Expected 1 to 128 components');
  const byId = new Map<string, HarnessDocument['components'][number]>();
  for (const component of document.components) {
    record(component); keys(component, ['id', 'scope', 'content', 'requires', 'trigger']);
    id(component.id);
    if (byId.has(component.id)) throw new Error('Duplicate component');
    if (component.scope !== 'invariant' && component.scope !== 'domain') throw new Error('Invalid scope');
    if (!Object.hasOwn(component, 'content')) throw new Error('Missing content');
    if (component.trigger !== undefined && component.trigger !== 'always' && component.trigger !== 'dependency')
      throw new Error('Invalid trigger');
    if (component.requires !== undefined && (!Array.isArray(component.requires) || component.requires.length > 128))
      throw new Error('Invalid dependencies');
    component.requires?.forEach(id);
    byId.set(component.id, component as unknown as Component);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const walk = (key: string): void => {
    if (visiting.has(key)) throw new Error('Cyclic dependency');
    if (visited.has(key)) return;
    const component = byId.get(key);
    if (!component) throw new Error('Missing component dependency');
    visiting.add(key);
    component.requires?.forEach(walk);
    visiting.delete(key); visited.add(key);
  };
  for (const component of document.components) if (component.trigger !== 'dependency') walk(component.id);
  if (visited.size !== byId.size) throw new Error('Unreachable component');
}
export function validateBudget(budget: Budget): void {
  record(budget); keys(budget, ['maxUsd', 'maxCalls', 'timeoutMs', 'probeUsd', 'proposeUsd', 'composeUsd']);
  for (const field of ['maxUsd', 'probeUsd', 'proposeUsd', 'composeUsd'] as const) moneyUnits(budget[field]);
  if (!Number.isInteger(budget.maxCalls) || budget.maxCalls < 1 || budget.maxCalls > 7) throw new Error('Invalid call limit');
  if (!Number.isInteger(budget.timeoutMs) || budget.timeoutMs < 1 || budget.timeoutMs > 300000) throw new Error('Invalid timeout');
}
export function validateObservations(value: readonly Observation[], document: HarnessDocument): void {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Invalid observations');
  const seen = new Set<string>();
  for (const observation of value) {
    record(observation); keys(observation, ['id', 'componentId', 'message']); id(observation.id);
    if (seen.has(observation.id)) throw new Error('Duplicate observation');
    if (!document.components.some(component => component.id === observation.componentId)) throw new Error('Unknown evidence component');
    if (typeof observation.message !== 'string' || !observation.message.length || observation.message.length > 4000)
      throw new Error('Invalid observation message');
    seen.add(observation.id);
  }
}
export function applyEdits(document: HarnessDocument, edits: readonly Edit[], observations: readonly Observation[], scope?: Scope): HarnessDocument {
  if (!Array.isArray(edits) || edits.length > 128) throw new Error('Invalid edits');
  const changed = new Set<string>();
  for (const edit of edits) {
    record(edit); keys(edit, ['componentId', 'content', 'citations']); id(edit.componentId);
    const component = document.components.find(item => item.id === edit.componentId);
    if (!component || (scope && component.scope !== scope) || changed.has(edit.componentId)) throw new Error('Edit outside scope');
    if (!Object.hasOwn(edit, 'content')) throw new Error('Missing edit content');
    if (!Array.isArray(edit.citations) || !edit.citations.length || edit.citations.length > 256 ||
        edit.citations.some(citation => !observations.some(obs => obs.id === citation && obs.componentId === edit.componentId)))
      throw new Error('Unsupported evidence citation');
    changed.add(edit.componentId);
  }
  return snapshot({ components: document.components.map(component => {
    const edit = edits.find(item => item.componentId === component.id);
    return edit ? { ...component, content: edit.content } : component;
  }) });
}
