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
