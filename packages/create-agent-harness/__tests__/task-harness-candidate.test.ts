// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  TASK_HARNESS_CANDIDATE_SCHEMA,
  digestTaskHarnessCandidate,
  validateTaskHarnessCandidate,
  type TaskHarnessCandidate,
} from '../src/task-harness-candidate.js';

const D = (char: string) => char.repeat(64);
const ceiling = ['memory.read', 'mcp.tools.call', 'repo.read', 'repo.write'];

function candidate(overrides: Partial<TaskHarnessCandidate> = {}): TaskHarnessCandidate {
  return {
    schema: TASK_HARNESS_CANDIDATE_SCHEMA,
    candidateId: 'candidate-001',
    taskDigest: D('a'),
    parentDigest: D('b'),
    generator: {
      id: 'jit-agent',
      version: '1.0.0',
      sourceDigest: D('c'),
    },
    modules: [
      { kind: 'memory', id: 'memory-v1', artifactDigest: D('1'), configDigest: D('5') },
      { kind: 'planning', id: 'planning-v1', artifactDigest: D('2'), configDigest: D('6') },
      { kind: 'action', id: 'action-v1', artifactDigest: D('3'), configDigest: D('7') },
      { kind: 'capability', id: 'capability-v1', artifactDigest: D('4'), configDigest: D('8') },
    ],
    requestedCapabilities: ['repo.read', 'memory.read'],
    generatedAt: '2026-09-15T14:00:00.000Z',
    authority: 'none',
    ...overrides,
  };
}

describe('validateTaskHarnessCandidate', () => {
  it('accepts a complete bounded candidate and canonicalizes ordering', () => {
    const input = candidate({
      modules: [...candidate().modules].reverse(),
      requestedCapabilities: ['repo.read', 'memory.read'],
    });
    const result = validateTaskHarnessCandidate(input, [...ceiling].reverse());
    expect(result.candidate.modules.map((module) => module.kind)).toEqual(['memory', 'planning', 'action', 'capability']);
    expect(result.candidate.requestedCapabilities).toEqual(['memory.read', 'repo.read']);
    expect(result.capabilityCeiling).toEqual(['mcp.tools.call', 'memory.read', 'repo.read', 'repo.write']);
    expect(result.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same digest when semantically unordered fields are permuted', () => {
    const first = validateTaskHarnessCandidate(candidate(), ceiling);
    const second = validateTaskHarnessCandidate(
      candidate({
        modules: [candidate().modules[2]!, candidate().modules[0]!, candidate().modules[3]!, candidate().modules[1]!],
        requestedCapabilities: ['memory.read', 'repo.read'],
      }),
      ceiling,
    );
    expect(second.candidateDigest).toBe(first.candidateDigest);
    expect(digestTaskHarnessCandidate(second.candidate)).toBe(first.candidateDigest);
  });

  it('rejects capability expansion beyond the operator ceiling', () => {
    expect(() => validateTaskHarnessCandidate(candidate({ requestedCapabilities: ['repo.read', 'shell.exec'] }), ceiling))
      .toThrow(/exceeds operator ceiling/);
  });

  it('rejects duplicate or missing module kinds', () => {
    const modules = candidate().modules.map((module) => ({ ...module }));
    modules[3] = { ...modules[3]!, kind: 'action' };
    expect(() => validateTaskHarnessCandidate(candidate({ modules }), ceiling)).toThrow(/module kinds must be unique/);
    expect(() => validateTaskHarnessCandidate(candidate({ modules: modules.slice(0, 3) }), ceiling)).toThrow(/exactly four modules/);
  });

  it('rejects unknown fields rather than letting generated content extend policy', () => {
    const input = { ...candidate(), evaluatorOverride: { accept: true } };
    expect(() => validateTaskHarnessCandidate(input, ceiling)).toThrow(/fields do not match/);
  });

  it('rejects malformed artifact provenance and noncanonical time', () => {
    const modules = candidate().modules.map((module) => ({ ...module }));
    modules[0] = { ...modules[0]!, artifactDigest: 'not-a-digest' };
    expect(() => validateTaskHarnessCandidate(candidate({ modules }), ceiling)).toThrow(/SHA-256/);
    expect(() => validateTaskHarnessCandidate(candidate({ generatedAt: '2026-09-15T14:00:00Z' }), ceiling)).toThrow(/canonical ISO/);
  });

  it('rejects authority-bearing candidates and duplicate requested capabilities', () => {
    expect(() => validateTaskHarnessCandidate({ ...candidate(), authority: 'grant' }, ceiling)).toThrow(/cannot carry authority/);
    expect(() => validateTaskHarnessCandidate(candidate({ requestedCapabilities: ['repo.read', 'repo.read'] }), ceiling))
      .toThrow(/duplicates/);
  });

  it('binds task, parent and generator lineage into the digest', () => {
    const base = validateTaskHarnessCandidate(candidate(), ceiling).candidateDigest;
    expect(validateTaskHarnessCandidate(candidate({ taskDigest: D('d') }), ceiling).candidateDigest).not.toBe(base);
    expect(validateTaskHarnessCandidate(candidate({ parentDigest: D('e') }), ceiling).candidateDigest).not.toBe(base);
    expect(validateTaskHarnessCandidate(candidate({ generator: { ...candidate().generator, sourceDigest: D('f') } }), ceiling).candidateDigest).not.toBe(base);
  });
});
