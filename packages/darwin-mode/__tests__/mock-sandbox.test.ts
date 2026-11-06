// SPDX-License-Identifier: MIT
//
// Tests for the deterministic surface-driven runner (ADR-102): the trace is a
// function of surface parameters, so different surfaces ⇒ different behaviour.
// This is the keystone that makes the behavioural manifold live (ADR-101).

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractSurfaceParams,
  simulateAgentLoop,
  runVariantTasksMock,
  runBenchmarkTaskMock,
  DEFAULT_MOCK_TASKS,
  type SurfaceParams,
} from '../src/mock-sandbox.js';
import { behavioralNiche } from '../src/phenotype.js';
import type { HarnessVariant } from '../src/types.js';
import type { BenchmarkTask } from '../src/bench/types.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'darwin-mock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a variant dir with the given retry budget + context window. */
async function writeVariant(vdir: string, maxAttempts: number, window: number): Promise<HarnessVariant> {
  await mkdir(vdir, { recursive: true });
  await writeFile(join(vdir, 'retry_policy.ts'), `export function shouldRetry(a:number){const maxAttempts = ${maxAttempts};return a<maxAttempts;}\n`);
  await writeFile(join(vdir, 'context_builder.ts'), `export function build(f:string[]){return f.map(x=>x.slice(0, ${window}));}\n`);
  await writeFile(join(vdir, 'memory_policy.ts'), `export function keep(s:number){const threshold = 0.5;return s>=threshold;}\n`);
  await writeFile(join(vdir, 'planner.ts'), `export function plan(t:string){return ['First decompose the task into steps.', t];}\n`);
  return {
    id: `v_${maxAttempts}_${window}`, parentId: null, generation: 0, dir: vdir,
    mutationSurface: 'retryPolicy', mutationSummary: 'm', createdAt: '2026-06-18T00:00:00.000Z',
  };
}

describe('extractSurfaceParams', () => {
  it('reads the retry budget and context window the mutator writes', async () => {
    await writeVariant(dir, 5, 80);
    const p = await extractSurfaceParams(dir);
    expect(p.maxAttempts).toBe(5);
    expect(p.contextWindow).toBe(80);
  });

  it('falls back to defaults for missing files', async () => {
    const p = await extractSurfaceParams(dir); // empty dir
    expect(p.maxAttempts).toBe(3);
    expect(p.contextWindow).toBe(30);
  });
});

describe('simulateAgentLoop', () => {
  const base: SurfaceParams = { maxAttempts: 3, contextWindow: 40, memoryThreshold: 0.5, planSteps: 2 };

  const hard = { id: 'h', failAttempts: 5, requiredContext: 60, backoffMs: 30, difficulty: 5 } as const;

  it('solves a task only with enough retries AND enough context', () => {
    expect(simulateAgentLoop(base, hard).solved).toBe(false); // 3 attempts, 40 window — too little
    const strong = simulateAgentLoop({ ...base, maxAttempts: 7, contextWindow: 60 }, hard);
    expect(strong.solved).toBe(true);
  });

  it('duration grows with retries (deterministic, surface-derived)', () => {
    const few = simulateAgentLoop({ ...base, maxAttempts: 1 }, hard);
    const many = simulateAgentLoop({ ...base, maxAttempts: 6 }, hard);
    expect(many.durationMs).toBeGreaterThan(few.durationMs);
  });

  it('is deterministic', () => {
    const a = simulateAgentLoop(base, hard);
    const b = simulateAgentLoop(base, hard);
    expect(a).toEqual(b);
  });

  // Dream Cycle 2026-10-12 (darwin-evolution): memoryThreshold was extracted
  // by extractSurfaceParams but never consumed here, so every memoryPolicy
  // mutation scored byte-identically to its parent — one of this Tier-1
  // runner's 5 fitness-blind surfaces (toolPolicy/reviewer/scorePolicy are
  // still disclosed-not-fixed). These assertions fail pre-fix: a strict vs.
  // lenient memoryThreshold produced IDENTICAL `solved`/`attemptsUsed`.
  describe('memoryThreshold (ADR-102 Tier-1 param)', () => {
    const borderline = { id: 'b', failAttempts: 2, requiredContext: 10, backoffMs: 10, difficulty: 3 } as const;

    it('baseline threshold (0.5) is byte-identical to the pre-fix no-op behaviour', () => {
      // attempt index 2 (3rd attempt) is exactly borderline.failAttempts — the
      // unmodified pre-fix formula's own boundary. Pins backward compatibility.
      const r = simulateAgentLoop({ ...base, memoryThreshold: 0.5 }, borderline);
      expect(r.solved).toBe(true);
      expect(r.attemptsUsed).toBe(3);
    });

    it('a strict memory policy (threshold > 0.5) costs one extra required attempt', () => {
      const strict = simulateAgentLoop({ ...base, memoryThreshold: 0.9, maxAttempts: 3 }, borderline);
      // 3 attempts (indices 0,1,2) is no longer enough once the required
      // attempt index rises from 2 to 3 — would solve at threshold 0.5.
      expect(strict.solved).toBe(false);
      const strictWithBudget = simulateAgentLoop({ ...base, memoryThreshold: 0.9, maxAttempts: 4 }, borderline);
      expect(strictWithBudget.solved).toBe(true);
      expect(strictWithBudget.attemptsUsed).toBe(4);
    });

    it('a lenient memory policy (threshold < 0.5) saves one required attempt', () => {
      const lenient = simulateAgentLoop({ ...base, memoryThreshold: 0.1 }, borderline);
      expect(lenient.solved).toBe(true);
      expect(lenient.attemptsUsed).toBe(2); // one fewer than the 0.5 baseline's 3
    });

    it('a lenient policy on an already-trivial task (failAttempts=0) still solves on the first attempt', () => {
      // failAttempts=0 + penalty=-1 makes requiredAttempts go negative; since
      // `attempt` never goes below 0, this must saturate to "solve at attempt
      // 0" — the same outcome as requiredAttempts=0 — rather than erroring or
      // somehow requiring MORE attempts.
      const trivial = { id: 't', failAttempts: 0, requiredContext: 10, backoffMs: 10, difficulty: 1 } as const;
      const lenient = simulateAgentLoop({ ...base, memoryThreshold: 0.1, maxAttempts: 3 }, trivial);
      expect(lenient.solved).toBe(true);
      expect(lenient.attemptsUsed).toBe(1);
    });
  });
});

describe('runVariantTasksMock → live manifold', () => {
  it('different surfaces land in DIFFERENT behavioural niches (manifold is live)', async () => {
    const weak = await writeVariant(join(dir, 'weak'), 1, 10);   // few retries, tiny window
    const strong = await writeVariant(join(dir, 'strong'), 8, 80); // many retries, big window
    const weakNiche = behavioralNiche(await runVariantTasksMock(weak));
    const strongNiche = behavioralNiche(await runVariantTasksMock(strong));
    expect(weakNiche).not.toBe(strongNiche); // the whole point of ADR-101/102
  });

  it('produces one trace per mock task, exit code reflecting solve', async () => {
    const v = await writeVariant(join(dir, 'v'), 4, 60);
    const traces = await runVariantTasksMock(v);
    expect(traces).toHaveLength(DEFAULT_MOCK_TASKS.length);
    expect(traces[0].exitCode).toBe(0); // easy task solved
  });
});

describe('runBenchmarkTaskMock', () => {
  it('scores a hash-pinned bench task without executing its shell commands', async () => {
    const variant = await writeVariant(join(dir, 'bench'), 4, 60);
    const impossible = 'node -e "throw new Error(\'MUST NOT EXECUTE\')"';
    const task: BenchmarkTask = {
      id: 'mock-bench-1', repo: 'fixture', commit: 'a'.repeat(40), title: 'mock task', prompt: 'simulate',
      publicTestCommand: impossible, hiddenTestCommand: impossible, regressionTestCommand: impossible,
      timeoutMs: 30_000, maxCostUsd: 1, allowedMutationFiles: [], blockedFiles: [],
      successCriteria: ['mock solve'], difficulty: 3, tags: ['mock'],
    };
    const result = await runBenchmarkTaskMock(variant, task);
    expect(result.taskId).toBe(task.id);
    expect(result.repoCommit).toBe(task.commit);
    expect(result.solved).toBe(true);
    expect(result.publicTestPassed).toBe(true);
    expect(result.costUsd).toBe(0);
  });
});
