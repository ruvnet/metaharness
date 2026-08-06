// SPDX-License-Identifier: MIT
// ADR-241 §2.1: RefineMutator — the evidence-backed CRUD proposer behind the same gate.
// Test Contract item 1: evidence → cited summary; no evidence → safe no-op; output always passes
// validateGeneratedCode; deterministic offline fallback; distinct edits per sibling nonce (ADR-104);
// endpoint failures (unreachable / forbidden output) mirror RuvllmMutator's no-op contract.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { RefineMutator, parseEvidenceIds } from '../src/refine-mutator.js';
import { validateGeneratedCode } from '../src/safety.js';

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function serve(handler: (body: any) => { status?: number; json?: any; raw?: string }): Promise<string> {
  return new Promise((resolveUrl) => {
    server = createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => {
        const out = handler(buf ? JSON.parse(buf) : {});
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(out.raw ?? JSON.stringify(out.json ?? {}));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolveUrl(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

const PARENT = 'export function plan(task: string): string[] {\n  return [task];\n}\n';
const EVIDENCE = ['trace-a1: planner emitted empty step list', 'task 7 exploded without a colon-safe head'];
const input = (over: Record<string, unknown> = {}) => ({
  parentCode: PARENT, surface: 'planner' as const, repoSummary: 'r', parentScore: 0.5,
  failedTraces: EVIDENCE, ...over,
});

describe('RefineMutator (ADR-241 §2.1)', () => {
  it('parses evidence IDs: leading token up to ":" when /^[\\w.-]+$/, else trace-<lineIndex>', () => {
    expect(parseEvidenceIds(EVIDENCE)).toEqual(['trace-a1', 'trace-1']);
    expect(parseEvidenceIds(['', '   ', '\t'])).toEqual([]);
    expect(parseEvidenceIds(['run.42-x: boom'])).toEqual(['run.42-x']);
  });

  it('EVIDENCE OR NO-OP: empty failedTraces → parent unchanged', async () => {
    const out = await new RefineMutator().generateMutation(input({ failedTraces: [] }));
    expect(out.code).toBe(PARENT);
    expect(out.summary).toBe('refine: no-op (no citable evidence)');
  });

  it('EVIDENCE OR NO-OP: all-blank failedTraces → parent unchanged', async () => {
    const out = await new RefineMutator().generateMutation(input({ failedTraces: ['', '   '] }));
    expect(out.code).toBe(PARENT);
    expect(out.summary).toBe('refine: no-op (no citable evidence)');
  });

  it('with evidence, the summary cites the evidence IDs (refine[<surface>]: … (evidence: …))', async () => {
    const out = await new RefineMutator().generateMutation(input());
    expect(out.code).not.toBe(PARENT);
    expect(out.summary).toMatch(/^refine\[planner\]: /);
    expect(out.summary).toContain('(evidence: trace-a1,trace-1)');
  });

  it('sibling diversity (ADR-104): nonce 0 vs nonce 1 → DIFFERENT code', async () => {
    const m = new RefineMutator();
    const a = await m.generateMutation(input({ nonce: 0 }));
    const b = await m.generateMutation(input({ nonce: 1 }));
    expect(a.code).not.toBe(PARENT);
    expect(b.code).not.toBe(PARENT);
    expect(a.code).not.toBe(b.code);
  });

  it('offline fallback is deterministic: same input twice → byte-identical output', async () => {
    const a = await new RefineMutator().generateMutation(input({ nonce: 2 }));
    const b = await new RefineMutator().generateMutation(input({ nonce: 2 }));
    expect(a.code).toBe(b.code);
    expect(a.summary).toBe(b.summary);
  });

  it('output ALWAYS passes validateGeneratedCode (offline path)', async () => {
    for (const nonce of [0, 1, 2, 3]) {
      const out = await new RefineMutator().generateMutation(input({ nonce }));
      expect(validateGeneratedCode(out.code)).toEqual([]);
    }
  });

  it('endpoint returning a forbidden pattern (process.env) → discarded-safety no-op', async () => {
    const url = await serve(() => ({
      json: { choices: [{ message: { content: 'export const key = process.env.SECRET;\n' } }] },
    }));
    const out = await new RefineMutator({ endpoint: url }).generateMutation(input());
    expect(out.code).toBe(PARENT);
    expect(out.summary).toBe('refine: discarded (safety)');
    expect(validateGeneratedCode(out.code)).toEqual([]); // parent stays admissible
  });

  it('endpoint success: uses the model content, cites evidence', async () => {
    const url = await serve(() => ({
      json: { choices: [{ message: { content: '```ts\nexport function plan(task: string): string[] {\n  return [task, task];\n}\n```' } }] },
    }));
    const out = await new RefineMutator({ endpoint: url }).generateMutation(input());
    expect(out.code).toContain('return [task, task];');
    expect(out.summary).toContain('(evidence: trace-a1,trace-1)');
  });

  it('unreachable endpoint → no-op with "unreachable" (never breaks the loop)', async () => {
    const out = await new RefineMutator({ endpoint: 'http://127.0.0.1:1', timeoutMs: 500 }).generateMutation(input());
    expect(out.code).toBe(PARENT);
    expect(out.summary).toContain('unreachable');
  });

  it('malformed endpoint response (no content) → no-op with "unreachable"', async () => {
    const url = await serve(() => ({ json: { choices: [] } }));
    const out = await new RefineMutator({ endpoint: url }).generateMutation(input());
    expect(out.code).toBe(PARENT);
    expect(out.summary).toContain('unreachable');
  });
});
