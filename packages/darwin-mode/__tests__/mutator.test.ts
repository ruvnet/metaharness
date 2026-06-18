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
  pickSurface,
  DeterministicMutator,
  type CodeGenerator,
} from '../src/mutator.js';
import type { HarnessVariant } from '../src/types.js';

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
});
