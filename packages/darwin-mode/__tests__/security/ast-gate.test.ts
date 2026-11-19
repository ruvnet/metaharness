// SPDX-License-Identifier: MIT
//
// The AST allowlist layer of the ADR-071 gate (safety-ast.ts): every known
// bypass is rejected by both entry points, the AST layer rejects the reported
// payloads on its own (it is independent of the regex layer), and legitimate
// policy code — including every generated baseline surface — still passes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeSurfaceSource } from '../../src/safety-ast.js';
import { FILE_BY_SURFACE, inspectVariant, validateGeneratedCode } from '../../src/safety.js';
import { profileRepo } from '../../src/repo_profiler.js';
import { generateBaselineHarness } from '../../src/generator.js';
import { ALL_BYPASS_FIXTURES, REPORTED_BYPASSES } from './fixtures/gate-bypass-fixtures.js';

const CLEAN = `// SPDX-License-Identifier: MIT
export function createPlan(task: string): Array<{ kind: string }> {
  return [{ kind: 'verify' }];
}
`;

describe('AST gate — every known bypass is rejected', () => {
  for (const fx of ALL_BYPASS_FIXTURES) {
    it(`validateGeneratedCode rejects ${fx.id}`, () => {
      expect(validateGeneratedCode(fx.code).length).toBeGreaterThan(0);
    });
  }

  for (const fx of REPORTED_BYPASSES) {
    it(`the AST layer alone rejects ${fx.id}`, () => {
      expect(analyzeSurfaceSource(fx.code).length).toBeGreaterThan(0);
    });
  }

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'darwin-ast-gate-'));
    for (const f of Object.values(FILE_BY_SURFACE)) await writeFile(join(dir, f), CLEAN);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('inspectVariant passes the clean control directory', async () => {
    expect(await inspectVariant(dir)).toEqual([]);
  });

  for (const fx of ALL_BYPASS_FIXTURES) {
    it(`inspectVariant rejects ${fx.id} in an approved surface file`, async () => {
      await writeFile(join(dir, 'planner.ts'), fx.code);
      const findings = await inspectVariant(dir);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.join('\n')).toContain('planner.ts');
    });
  }
});

describe('AST gate — legitimate policy code still passes', () => {
  it('every generated baseline surface passes the AST layer and both gates', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'darwin-ast-repo-'));
    const wr = await mkdtemp(join(tmpdir(), 'darwin-ast-wr-'));
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'package.json'), '{"name":"astok","version":"1.0.0","private":true}');
      await writeFile(join(repo, 'src', 'i.ts'), 'export const x = 1;\n');
      const base = await generateBaselineHarness(await profileRepo(repo), wr);
      for (const f of Object.values(FILE_BY_SURFACE)) {
        const code = await readFile(join(base.dir, f), 'utf8');
        expect(analyzeSurfaceSource(code), f).toEqual([]);
        expect(validateGeneratedCode(code), f).toEqual([]);
      }
      expect(await inspectVariant(base.dir)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(wr, { recursive: true, force: true });
    }
  });

  it('accepts typical policy constructs', () => {
    const code = `// SPDX-License-Identifier: MIT
import type { PlanStep } from './planner.ts';
export interface Weights { [k: string]: number }
export enum Mode { A = 'a', B = 'b' }
const ORDER: Record<string, number> = { lint: 0, build: 1, test: 2 };
export class Ranker {
  private n = 0;
  constructor(private readonly w: Weights) {}
  bump(): number { return ++this.n; }
}
export function orderKinds(kinds: string[]): string[] {
  const xs = [...kinds];
  for (let i = 0; i < xs.length; i++) xs[i] = xs[i].trim();
  const last = xs[xs.length - 1];
  void last;
  return xs.sort((a, b) => (ORDER[a] ?? 99) - (ORDER[b] ?? 99));
}
export const describe = (s: PlanStep | undefined): string => \`step \${s?.order ?? -1}\`;
export const maxAttempts = 3;
`;
    expect(analyzeSurfaceSource(code)).toEqual([]);
    expect(validateGeneratedCode(code)).toEqual([]);
  });

  it('type-only references to restricted names are not flagged', () => {
    const code = `export function f(cb: Function, p: typeof Math): number { return 1; }\n`;
    expect(analyzeSurfaceSource(code)).toEqual([]);
  });
});
