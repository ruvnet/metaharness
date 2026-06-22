// SPDX-License-Identifier: MIT
// ADR-153 — offline unit tests for the agentic ReAct loop. No network, no Docker: a scripted model
// drives the real tool dispatcher over a real temp git repo, with a stubbed test-runner. Verifies
// the loop explores → edits → runs tests → submits, that the safety guards hold, and that action
// parsing tolerates messy model output.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAction, makeTools, agenticSolve, AGENTIC_SYSTEM } from '../bench/swebench/agentic-loop.mjs';

// A minimal exact-match applyEdit (the real one in solve-repair.mjs also does fuzzy indentation; the
// loop logic under test only needs a deterministic primitive).
const applyEdit = (content: string, search: string, replace: string): string | null =>
  search.length && content.includes(search) ? content.replace(search, replace) : null;

function makeIO(work: string, runTests: () => { resolved: boolean; logTail: string }) {
  const g = (c: string) => execSync(c, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return {
    work, path: { join },
    readFile: (p: string) => readFileSync(p, 'utf8'),
    listDir: (p: string) => readdirSync(p),
    writeFile: (p: string, c: string) => writeFileSync(p, c),
    exists: (p: string) => existsSync(p),
    gitDiff: () => g('git diff'),
    grepRepo: (pattern: string) => { try { return g(`git grep -n "${pattern}" || true`); } catch { return ''; } },
    applyEdit,
    isTestPath: (rel: string) => /(^|\/)(tests?|test_)/.test(rel) || /_test\.py$/.test(rel),
    runTests,
    MAX_OUT: 4000,
  };
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'agentic-test-'));
  mkdirSync(join(work, 'pkg'), { recursive: true });
  writeFileSync(join(work, 'pkg', 'calc.py'), 'def add(a, b):\n    return a - b\n');   // the bug
  writeFileSync(join(work, 'pkg', 'test_calc.py'), 'def test_add():\n    assert add(1, 2) == 3\n');
  const g = (c: string) => execSync(c, { cwd: work, stdio: 'ignore' });
  g('git init -q'); g('git config user.email t@t'); g('git config user.name t');
  g('git add -A'); g('git commit -qm base');
});
afterEach(() => { try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } });

describe('parseAction', () => {
  it('parses a bare JSON action', () => {
    expect(parseAction('{"tool":"read","path":"x.py"}')).toMatchObject({ tool: 'read', path: 'x.py' });
  });
  it('parses a fenced JSON action with surrounding prose', () => {
    const out = 'Let me read the file.\n```json\n{"tool":"read","path":"x.py","start":1,"end":5}\n```\n';
    expect(parseAction(out)).toMatchObject({ tool: 'read', start: 1, end: 5 });
  });
  it('extracts a JSON object embedded in prose', () => {
    expect(parseAction('Thinking… {"tool":"submit"} done')).toMatchObject({ tool: 'submit' });
  });
  it('returns a noop with an error for unparseable output', () => {
    expect(parseAction('I cannot help with that')).toMatchObject({ tool: 'noop' });
    expect(parseAction('')).toMatchObject({ tool: 'noop' });
  });
});

describe('tool dispatcher safety guards', () => {
  it('rejects edits to test files', () => {
    const tools = makeTools(makeIO(work, () => ({ resolved: false, logTail: '' })));
    const obs = tools.edit({ path: 'pkg/test_calc.py', search: 'assert', replace: 'pass' });
    expect(obs).toMatch(/rejected.*test file/);
  });
  it('blocks path traversal outside the repo', () => {
    const tools = makeTools(makeIO(work, () => ({ resolved: false, logTail: '' })));
    expect(tools.read({ path: '../../../etc/passwd' })).toMatch(/error/);
  });
  it('reports a non-matching SEARCH instead of corrupting the file', () => {
    const tools = makeTools(makeIO(work, () => ({ resolved: false, logTail: '' })));
    const obs = tools.edit({ path: 'pkg/calc.py', search: 'return a / b', replace: 'return a + b' });
    expect(obs).toMatch(/did not match/);
    expect(readFileSync(join(work, 'pkg', 'calc.py'), 'utf8')).toContain('return a - b'); // untouched
  });
  it('run_tests refuses before any edit', () => {
    const tools = makeTools(makeIO(work, () => ({ resolved: true, logTail: '' })));
    expect(tools.run_tests()).toMatch(/no edits applied yet/);
  });
});

describe('agenticSolve end-to-end (scripted model)', () => {
  it('explores, edits the bug, runs tests, and submits — producing the fix patch', async () => {
    // run_tests passes only once the bug is fixed (file no longer contains the buggy line).
    const runTests = () => {
      const src = readFileSync(join(work, 'pkg', 'calc.py'), 'utf8');
      return src.includes('return a + b')
        ? { resolved: true, logTail: '' }
        : { resolved: false, logTail: 'E   assert 1 - 2 == 3' };
    };
    const script = [
      '{"tool":"ls","dir":"pkg"}',
      '{"tool":"read","path":"pkg/calc.py"}',
      '{"tool":"edit","path":"pkg/calc.py","search":"return a - b","replace":"return a + b"}',
      '{"tool":"run_tests"}',
      '{"tool":"submit"}',
    ];
    let i = 0;
    const llm = async () => ({ raw: script[i++] ?? '{"tool":"submit"}', cost: 0 });
    const res = await agenticSolve({ problem: 'add() subtracts instead of adds', io: makeIO(work, runTests), llm, maxSteps: 20 });

    expect(res.submitted).toBe(true);
    expect(res.resolvedInLoop).toBe(true);
    expect(res.steps).toBe(5);
    expect(res.patch).toContain('return a + b');
    expect(res.patch).toContain('pkg/calc.py');
  });

  it('stops at the step budget and returns the partial diff if never submitted', async () => {
    const llm = async () => ({ raw: '{"tool":"read","path":"pkg/calc.py"}', cost: 0 }); // never submits
    const res = await agenticSolve({ problem: 'x', io: makeIO(work, () => ({ resolved: false, logTail: '' })), llm, maxSteps: 4 });
    expect(res.submitted).toBe(false);
    expect(res.steps).toBe(4);
    expect(res.patch).toBe(''); // only reads, no edits → empty diff
  });

  it('ADR-169 E4: warns + counts thrash when the model repeats the same read', async () => {
    const seen: string[] = [];
    // model reads the SAME file twice (identical action+observation) then submits
    const script = [
      '{"tool":"read","path":"pkg/calc.py"}',
      '{"tool":"read","path":"pkg/calc.py"}',
      '{"tool":"submit"}',
    ];
    let i = 0;
    const llm = async () => ({ raw: script[i++], cost: 0 });
    const res = await agenticSolve({ problem: 'x', io: makeIO(work, () => ({ resolved: false, logTail: '' })), llm, maxSteps: 6, onStep: (_n, _a, obs) => seen.push(obs) });
    expect(res.thrash).toBeGreaterThan(0);
    expect(seen[1]).toMatch(/already ran this exact action/i); // 2nd read got the warning
    expect(seen[0]).not.toMatch(/already ran/i);                // 1st did not
  });

  it('feeds an error observation back when the model emits an unknown tool', async () => {
    const seen: string[] = [];
    const script = ['{"tool":"teleport"}', '{"tool":"submit"}'];
    let i = 0;
    const llm = async () => ({ raw: script[i++], cost: 0 });
    await agenticSolve({ problem: 'x', io: makeIO(work, () => ({ resolved: false, logTail: '' })), llm, maxSteps: 5, onStep: (_n, _a, obs) => seen.push(obs) });
    expect(seen[0]).toMatch(/unknown tool/);
  });
});

describe('AGENTIC_SYSTEM contract', () => {
  it('documents every dispatched tool', () => {
    for (const t of ['ls', 'read', 'grep', 'edit', 'run_tests', 'submit']) expect(AGENTIC_SYSTEM).toContain(t);
  });
});
