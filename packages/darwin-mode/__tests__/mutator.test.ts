// SPDX-License-Identifier: MIT
//
// Tests for the mutation engine (ADR-071). These pin the load-bearing safety
// invariants: a child variant always still passes `inspectVariant`, exactly one
// surface is mutated, surface selection is deterministic, and a generation that
// violates `validateGeneratedCode` is discarded (surface unchanged).

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectVariant, FILE_BY_SURFACE, SURFACES } from '../src/safety.js';
import {
  createChildVariant,
  createCrossoverVariant,
  pickSurface,
  DeterministicMutator,
  summarizeFailedTraces,
  type CodeGenerator,
} from '../src/mutator.js';
import type { HarnessVariant, RunTrace } from '../src/types.js';

/** Build a RunTrace with sane defaults; override only what a test cares about. */
function trace(over: Partial<RunTrace> = {}): RunTrace {
  return {
    variantId: 'v',
    taskId: 'task-1',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:00:01Z',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1000,
    timedOut: false,
    blockedActions: [],
    ...over,
  };
}

/** Safe stub bodies for the seven approved files: mutable, no blocked content. */
const STUB_FILES: Record<string, string> = {
  'planner.ts':
    `// SPDX-License-Identifier: MIT\nexport function plan(task: string): string[] {\n  const guidance = 'First decompose the task into steps.';\n  return [guidance, task];\n}\n`,
  'context_builder.ts':
    `// SPDX-License-Identifier: MIT\nexport function build(files: string[]): string[] {\n  return files.map((f) => f.slice(0, 30));\n}\n`,
  'reviewer.ts':
    `// SPDX-License-Identifier: MIT\nexport function review(patch: string): string {\n  const note = 'Consider edge cases before approving.';\n  return note + patch.slice(0, 50);\n}\n`,
  'retry_policy.ts':
    `// SPDX-License-Identifier: MIT\nexport function shouldRetry(attempt: number): boolean {\n  const maxRetries = 3;\n  return attempt < maxRetries;\n}\n`,
  'tool_policy.ts':
    `// SPDX-License-Identifier: MIT\nexport function allowed(tool: string): boolean {\n  const order = ['read', 'plan', 'write'];\n  return order.includes(tool);\n}\n`,
  'memory_policy.ts':
    `// SPDX-License-Identifier: MIT\nexport function keep(score: number): boolean {\n  const threshold = 0.5;\n  return score >= threshold;\n}\n`,
  'score_policy.ts':
    `// SPDX-License-Identifier: MIT\nexport function weightOf(term: string): number {\n  const weight = 0.4;\n  return term.length > 0 ? weight : 0;\n}\n`,
};

/** Write the seven approved files into `dir` and return a baseline variant. */
async function makeParent(dir: string): Promise<HarnessVariant> {
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(STUB_FILES)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
  return {
    id: 'baseline',
    parentId: null,
    generation: 0,
    dir,
    mutationSurface: 'planner',
    mutationSummary: 'baseline',
    createdAt: new Date().toISOString(),
  };
}

let workRoot: string;

beforeEach(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'darwin-mutator-'));
});

afterEach(async () => {
  await rm(workRoot, { recursive: true, force: true });
});

describe('createChildVariant', () => {
  it('produces a child directory that passes inspectVariant', async () => {
    const parent = await makeParent(join(workRoot, 'parent'));
    const child = await createChildVariant(parent, workRoot, 1, 0);
    expect(await inspectVariant(child.dir)).toEqual([]);
  });

  it('mutates exactly one surface; the other six files are byte-identical', async () => {
    const parentDir = join(workRoot, 'parent');
    const parent = await makeParent(parentDir);
    const child = await createChildVariant(parent, workRoot, 2, 1, new DeterministicMutator(7), 7);

    const mutatedFile = FILE_BY_SURFACE[child.mutationSurface];
    let changedCount = 0;
    for (const name of Object.keys(STUB_FILES)) {
      const before = await readFile(join(parentDir, name), 'utf8');
      const after = await readFile(join(child.dir, name), 'utf8');
      if (before !== after) {
        changedCount++;
        expect(name).toBe(mutatedFile);
      }
    }
    expect(changedCount).toBe(1);
    // No extra or missing files in the child directory.
    const names = (await readdir(child.dir)).sort();
    expect(names).toEqual(Object.keys(STUB_FILES).sort());
  });

  it('selects the surface deterministically for the same (generation,index,seed)', async () => {
    expect(pickSurface(3, 2, 5)).toBe(pickSurface(3, 2, 5));
    // And the selection is one of the seven approved surfaces.
    expect(SURFACES).toContain(pickSurface(3, 2, 5));

    const a = await createChildVariant(
      await makeParent(join(workRoot, 'pa')),
      join(workRoot, 'wa'),
      4,
      2,
      new DeterministicMutator(9),
      9,
    );
    const b = await createChildVariant(
      await makeParent(join(workRoot, 'pb')),
      join(workRoot, 'wb'),
      4,
      2,
      new DeterministicMutator(9),
      9,
    );
    expect(a.mutationSurface).toBe(b.mutationSurface);
  });

  it('discards a generation that contains a blocked pattern (surface unchanged)', async () => {
    const parentDir = join(workRoot, 'parent');
    const parent = await makeParent(parentDir);

    const evilGen: CodeGenerator = {
      async generateMutation({ parentCode }) {
        return {
          code: `${parentCode}\nconst x = process.env.FOO;\n`,
          summary: 'malicious env-reading mutation',
        };
      },
    };

    const child = await createChildVariant(parent, workRoot, 1, 0, evilGen, 0);

    // The chosen surface file must be byte-identical to the parent's.
    const mutatedFile = FILE_BY_SURFACE[child.mutationSurface];
    const before = await readFile(join(parentDir, mutatedFile), 'utf8');
    const after = await readFile(join(child.dir, mutatedFile), 'utf8');
    expect(after).toBe(before);
    expect(child.mutationSummary).toContain('rejected by validator');

    // And the child still passes the hard gate.
    expect(await inspectVariant(child.dir)).toEqual([]);
  });

  it('forwards the reflection context (repoSummary, parentScore, failedTraces) to the generator', async () => {
    const parent = await makeParent(join(workRoot, 'parent'));
    let seen: Parameters<CodeGenerator['generateMutation']>[0] | null = null;
    const capturing: CodeGenerator = {
      async generateMutation(input) {
        seen = input;
        return { code: input.parentCode, summary: 'no-op capture' };
      },
    };

    await createChildVariant(parent, workRoot, 1, 0, capturing, 0, {
      repoSummary: 'demo repo: a tiny TS lib',
      parentScore: 0.71,
      failedTraces: ['task t1: exit 1 — boom'],
    });

    expect(seen).not.toBeNull();
    expect(seen!.repoSummary).toBe('demo repo: a tiny TS lib');
    expect(seen!.parentScore).toBe(0.71);
    expect(seen!.failedTraces).toEqual(['task t1: exit 1 — boom']);
  });

  it('defaults the reflection context to empty when none is passed (back-compat)', async () => {
    const parent = await makeParent(join(workRoot, 'parent'));
    let seen: Parameters<CodeGenerator['generateMutation']>[0] | null = null;
    const capturing: CodeGenerator = {
      async generateMutation(input) {
        seen = input;
        return { code: input.parentCode, summary: 'no-op' };
      },
    };
    await createChildVariant(parent, workRoot, 1, 0, capturing, 0);
    expect(seen!.repoSummary).toBe('');
    expect(seen!.parentScore).toBe(0);
    expect(seen!.failedTraces).toEqual([]);
  });
});

describe('createCrossoverVariant', () => {
  /** Make a parent whose every surface file carries a unique marker per owner. */
  async function makeMarkedParent(dir: string, owner: string): Promise<HarnessVariant> {
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(STUB_FILES)) {
      await writeFile(join(dir, name), `${body}// owner:${owner}\n`, 'utf8');
    }
    return {
      id: owner, parentId: null, generation: 0, dir,
      mutationSurface: 'planner', mutationSummary: owner, createdAt: '2026-06-17T00:00:00.000Z',
    };
  }

  it('inherits a proper, non-empty mix of surfaces from BOTH parents', async () => {
    const a = await makeMarkedParent(join(workRoot, 'A'), 'A');
    const b = await makeMarkedParent(join(workRoot, 'B'), 'B');
    const child = await createCrossoverVariant(a, b, workRoot, 1, 0, 5);

    let fromA = 0, fromB = 0;
    for (const name of Object.keys(STUB_FILES)) {
      const txt = await readFile(join(child.dir, name), 'utf8');
      if (txt.includes('// owner:A')) fromA++;
      else if (txt.includes('// owner:B')) fromB++;
    }
    // A proper recombination: at least one surface from each parent, all 7 present.
    expect(fromA).toBeGreaterThan(0);
    expect(fromB).toBeGreaterThan(0);
    expect(fromA + fromB).toBe(Object.keys(STUB_FILES).length);
  });

  it('records parentA as the tree parent and names parentB in the summary', async () => {
    const a = await makeMarkedParent(join(workRoot, 'A'), 'A');
    const b = await makeMarkedParent(join(workRoot, 'B'), 'B');
    const child = await createCrossoverVariant(a, b, workRoot, 2, 1, 9);
    expect(child.parentId).toBe('A'); // single-parent tree invariant preserved
    expect(child.mutationSummary).toContain('crossover');
    expect(child.mutationSummary).toContain('B');
  });

  it('is deterministic for the same (generation,index,seed) and passes the gate', async () => {
    const a1 = await makeMarkedParent(join(workRoot, 'A1'), 'A');
    const b1 = await makeMarkedParent(join(workRoot, 'B1'), 'B');
    const c1 = await createCrossoverVariant(a1, b1, join(workRoot, 'w1'), 3, 2, 4);
    const a2 = await makeMarkedParent(join(workRoot, 'A2'), 'A');
    const b2 = await makeMarkedParent(join(workRoot, 'B2'), 'B');
    const c2 = await createCrossoverVariant(a2, b2, join(workRoot, 'w2'), 3, 2, 4);
    expect(c1.mutationSurface).toBe(c2.mutationSurface);
    expect(await inspectVariant(c1.dir)).toEqual([]); // still passes the hard gate
  });
});

describe('summarizeFailedTraces', () => {
  it('returns nothing when every trace passed cleanly', () => {
    expect(summarizeFailedTraces([trace(), trace({ taskId: 'task-2' })])).toEqual([]);
  });

  it('summarizes a non-zero exit with the last stderr line', () => {
    const out = summarizeFailedTraces([
      trace({ taskId: 'build', exitCode: 1, stderr: 'line A\nTypeError: boom' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('task build');
    expect(out[0]).toContain('exit 1');
    expect(out[0]).toContain('TypeError: boom');
  });

  it('flags timeouts and safety blocks distinctly', () => {
    const out = summarizeFailedTraces([
      trace({ taskId: 'slow', timedOut: true }),
      trace({ taskId: 'risky', blockedActions: ['reads process.env'] }),
    ]);
    expect(out[0]).toContain('timed out');
    expect(out[1]).toContain('blocked: reads process.env');
  });

  it('caps the failure tail so prompts stay bounded', () => {
    const huge = 'x'.repeat(5000);
    const out = summarizeFailedTraces([trace({ exitCode: 2, stderr: huge })]);
    // "task task-1: exit 2 — " prefix + ≤160 chars of tail.
    expect(out[0].length).toBeLessThanOrEqual(200);
  });
});
