// SPDX-License-Identifier: MIT
//
// Tests for harness-spec.ts (ADR-159 HarnessSpec): genome⇄spec round-trip
// identity, deterministic replay, validation, and the default spec.

import { describe, it, expect } from 'vitest';
import {
  genomeToSpec,
  specToGenome,
  validateSpec,
  defaultSpec,
  replaySpec,
  type HarnessGenomeLite,
  type HarnessSpec,
} from '../src/harness-spec.js';
import { defaultPolicy } from '../src/core.js';

const genomes: HarnessGenomeLite[] = [
  {
    planner: 'file-first',
    contextPolicy: 'hybrid',
    reviewerCount: 1,
    retryBudget: 2,
    tools: ['read', 'edit', 'test'],
    policy: defaultPolicy(),
  },
  {
    planner: 'sink-first',
    contextPolicy: 'minimal',
    reviewerCount: 0,
    retryBudget: 0,
    tools: ['grep'],
    policy: { ...defaultPolicy(), coderModel: 'frontier', retrievalTopK: 20 },
  },
  {
    planner: 'callgraph-first',
    contextPolicy: 'callgraph',
    reviewerCount: 3,
    retryBudget: 4,
    tools: ['read', 'callgraph', 'edit'],
    policy: { ...defaultPolicy(), securityReviewRequired: false, maxRetries: 5 },
  },
  {
    planner: 'risk-first',
    contextPolicy: 'semantic',
    reviewerCount: 2,
    retryBudget: 1,
    tools: ['read'],
    policy: { ...defaultPolicy(), reviewerModel: 'frontier', batchEval: false },
  },
  {
    planner: 'memory-first',
    contextPolicy: 'hybrid',
    reviewerCount: 5,
    retryBudget: 3,
    tools: ['mem', 'read', 'edit'],
    policy: { ...defaultPolicy(), plannerModel: 'frontier', frontierEscalationThreshold: 0.5 },
  },
];

describe('harness-spec round-trip', () => {
  it('specToGenome(genomeToSpec(g)) deep-equals g for several genomes', () => {
    for (const g of genomes) {
      const round = specToGenome(genomeToSpec(g));
      expect(round).toEqual(g);
    }
  });

  it('round-trip is stable under repeated application', () => {
    for (const g of genomes) {
      const once = specToGenome(genomeToSpec(g));
      const twice = specToGenome(genomeToSpec(once));
      expect(twice).toEqual(g);
    }
  });
});

describe('harness-spec deterministic replay', () => {
  it('two replays with same seed + outputs are identical', () => {
    const spec = genomeToSpec(genomes[2]);
    const a = replaySpec(spec, { seed: 42 });
    const b = replaySpec(spec, { seed: 42 });
    expect(a.hash).toBe(b.hash);
    expect(a.trace).toEqual(b.trace);
  });

  it('different seed generally yields a different hash', () => {
    const spec = genomeToSpec(genomes[2]);
    const a = replaySpec(spec, { seed: 1 });
    const b = replaySpec(spec, { seed: 999 });
    expect(a.hash).not.toBe(b.hash);
  });

  it('fixedOutputs are used verbatim and replay is still deterministic', () => {
    const spec = defaultSpec();
    const fixedOutputs = { plan: { pinned: true }, evaluate: 7 };
    const a = replaySpec(spec, { seed: 5, fixedOutputs });
    const b = replaySpec(spec, { seed: 5, fixedOutputs });
    expect(a.hash).toBe(b.hash);
    expect(a.trace.find((t) => t.stepId === 'plan')?.output).toEqual({ pinned: true });
    expect(a.trace.find((t) => t.stepId === 'evaluate')?.output).toBe(7);
  });

  it('policy mutation changes the hash even when outputs are pinned', () => {
    const spec = defaultSpec();
    const fixedOutputs = Object.fromEntries(spec.steps.map((s) => [s.id, 1]));
    const before = replaySpec(spec, { seed: 0, fixedOutputs });
    const mutated: HarnessSpec = { ...spec, policy: { ...spec.policy, coderModel: 'frontier' } };
    const after = replaySpec(mutated, { seed: 0, fixedOutputs });
    expect(after.hash).not.toBe(before.hash);
  });
});

describe('harness-spec validation', () => {
  it('defaultSpec validates ok', () => {
    expect(validateSpec(defaultSpec())).toEqual({ ok: true, errors: [] });
  });

  it('rejects a bad version', () => {
    const s = { ...defaultSpec(), version: 2 as unknown as 1 };
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('version must be 1');
  });

  it('rejects a dangling step.next', () => {
    const base = defaultSpec();
    const s: HarnessSpec = {
      ...base,
      steps: base.steps.map((st, i) => (i === 0 ? { ...st, next: ['nope'] } : st)),
    };
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('unknown next "nope"'))).toBe(true);
  });

  it('rejects non-positive budgets', () => {
    const s: HarnessSpec = { ...defaultSpec(), budgets: { costUnits: 0, timeUnits: -1 } };
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('budgets.costUnits must be > 0');
    expect(r.errors).toContain('budgets.timeUnits must be > 0');
  });

  it('rejects an out-of-range policy', () => {
    const s: HarnessSpec = { ...defaultSpec(), policy: { ...defaultSpec().policy, retrievalTopK: 999 } };
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('policy:'))).toBe(true);
  });

  it('rejects empty roles/steps', () => {
    const s: HarnessSpec = { ...defaultSpec(), roles: [], steps: [] };
    const r = validateSpec(s);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('roles must be non-empty');
    expect(r.errors).toContain('steps must be non-empty');
  });
});
