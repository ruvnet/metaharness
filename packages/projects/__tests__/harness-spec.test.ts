// SPDX-License-Identifier: MIT
//
// Tests for harness-spec.ts (ADR-159 HarnessSpec): genome⇄spec round-trip
// identity, deterministic replay, validation, and the default spec.

import { readFileSync } from 'node:fs';
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

// ─────────────────────────────────────────────────────────────────────────────
// ADR-241 §2.2 autonomous block: round-trip, validation (lockstep fixture
// shared with the Rust validator), and deterministic replay halts.
// ─────────────────────────────────────────────────────────────────────────────

import type { AutonomousSpec } from '../src/harness-spec.js';

const autonomousFull: AutonomousSpec = {
  goal: { text: 'keep the suite green', tokenBudget: 1000 },
  heartbeat: { cadence: '5m', instruction: 're-check the goal and continue' },
  gateCommand: 'npm run check',
  maxTurns: 10,
};

describe('harness-spec autonomous round-trip (ADR-241 §2.2)', () => {
  it('genome with autonomous block round-trips losslessly and is stable under double application', () => {
    for (const base of genomes) {
      const g: HarnessGenomeLite = { ...base, autonomous: autonomousFull };
      const once = specToGenome(genomeToSpec(g));
      expect(once).toEqual(g);
      const twice = specToGenome(genomeToSpec(once));
      expect(twice).toEqual(g);
    }
  });

  it('copies the block (mutating the spec does not mutate the genome)', () => {
    const g: HarnessGenomeLite = { ...genomes[0], autonomous: autonomousFull };
    const spec = genomeToSpec(g);
    spec.autonomous!.goal!.text = 'mutated';
    expect(g.autonomous!.goal!.text).toBe('keep the suite green');
  });

  it('omits the autonomous key entirely when absent', () => {
    const spec = genomeToSpec(genomes[0]);
    expect('autonomous' in spec).toBe(false);
    expect('autonomous' in specToGenome(spec)).toBe(false);
  });
});

describe('harness-spec autonomous validation (lockstep fixture)', () => {
  const cases = JSON.parse(
    readFileSync(new URL('./fixtures/autonomous-cases.json', import.meta.url), 'utf8'),
  ) as { name: string; spec: AutonomousSpec; errors: string[] }[];

  it.each(cases)('$name', ({ spec, errors }) => {
    const s: HarnessSpec = { ...defaultSpec(), autonomous: spec };
    const r = validateSpec(s);
    expect(r.errors).toEqual(errors);
    expect(r.ok).toBe(errors.length === 0);
  });

  it('defaultSpec (no autonomous) still validates strictly clean', () => {
    expect(validateSpec(defaultSpec())).toEqual({ ok: true, errors: [] });
  });
});

describe('harness-spec autonomous replay halts (ADR-241 §2.2)', () => {
  it('maxTurns=2 on a multi-step (>2) spec halts deterministically with reason maxTurns', () => {
    const spec = genomeToSpec({ ...genomes[2], autonomous: { maxTurns: 2 } });
    expect(spec.steps.length).toBeGreaterThan(2); // plan + code + review-1..3 + evaluate = 6
    const a = replaySpec(spec, { seed: 42 });
    const b = replaySpec(spec, { seed: 42 });
    expect(a.halt).toEqual({ reason: 'maxTurns' });
    expect(a.trace.length).toBe(2);
    expect(a.hash).toBe(b.hash);
    expect(a.trace).toEqual(b.trace);
    expect(b.halt).toEqual({ reason: 'maxTurns' });
  });

  it('tokenBudget below step count halts with reason tokenBudget', () => {
    const spec = genomeToSpec({
      ...genomes[2],
      autonomous: { goal: { text: 'go', tokenBudget: 3 } },
    });
    const r = replaySpec(spec, { seed: 7 });
    expect(r.halt).toEqual({ reason: 'tokenBudget' });
    expect(r.trace.length).toBe(3);
  });

  it('generous limits produce no halt and a full trace', () => {
    const spec = genomeToSpec({
      ...genomes[2],
      autonomous: { goal: { text: 'go', tokenBudget: 100 }, maxTurns: 100 },
    });
    const r = replaySpec(spec, { seed: 42 });
    expect('halt' in r).toBe(false);
    expect(r.trace.length).toBe(spec.steps.length);
  });

  it('spec without autonomous block emits no halt key and is unchanged', () => {
    const spec = genomeToSpec(genomes[2]);
    const r = replaySpec(spec, { seed: 42 });
    expect('halt' in r).toBe(false);
    expect(r.trace.length).toBe(spec.steps.length);
  });
});
