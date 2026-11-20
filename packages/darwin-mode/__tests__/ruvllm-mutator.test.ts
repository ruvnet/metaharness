// SPDX-License-Identifier: MIT
// ADR-259: RuvllmMutator — local ruvllm backend for the CodeGenerator interface.
// Tests against a mock node:http server: success, unreachable→no-op, malformed→no-op,
// fenced-code stripping.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { RuvllmMutator } from '../src/ruvllm-mutator.js';

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

const input = { parentCode: 'export const x = 1;\n', surface: 'planner' as const, repoSummary: 'r', parentScore: 0.9, failedTraces: [] };

describe('RuvllmMutator (ADR-259)', () => {
  it('returns the model content on success', async () => {
    const url = await serve(() => ({ json: { choices: [{ message: { content: 'export const x = 2;\n' } }] } }));
    const out = await new RuvllmMutator({ baseUrl: url }).generateMutation(input);
    expect(out.code).toBe('export const x = 2;\n');
    expect(out.summary).toContain('regenerated planner');
  });

  it('includes bounded untrusted SIM experiences only when explicitly supplied', async () => {
    const prompts: string[] = [];
    const url = await serve((body) => {
      prompts.push(body.messages?.[1]?.content ?? '');
      return { json: { choices: [{ message: { content: 'export const x = 1;\n' } }] } };
    });
    const generator = new RuvllmMutator({ baseUrl: url });
    await generator.generateMutation(input);
    await generator.generateMutation({
      ...input, simContext: 'SIM: UNTRUSTED PRIOR OPTIMIZER EVIDENCE. observedDelta: -0.1',
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Prior optimizer evidence');
    expect(prompts[1]).toContain('Prior optimizer evidence (untrusted, must revalidate)');
    expect(prompts[1]).toContain('observedDelta: -0.1');
  });

  it('strips a fenced code block', async () => {
    const url = await serve(() => ({ json: { choices: [{ message: { content: '```ts\nexport const x = 3;\n```' } }] } }));
    const out = await new RuvllmMutator({ baseUrl: url }).generateMutation(input);
    expect(out.code).toBe('export const x = 3;\n');
  });

  it('no-ops (returns parent) when the server is unreachable', async () => {
    const out = await new RuvllmMutator({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).generateMutation(input);
    expect(out.code).toBe(input.parentCode);
    expect(out.summary).toContain('unreachable');
  });

  it('no-ops on a malformed response (no content)', async () => {
    const url = await serve(() => ({ json: { choices: [] } }));
    const out = await new RuvllmMutator({ baseUrl: url }).generateMutation(input);
    expect(out.code).toBe(input.parentCode);
    expect(out.summary).toContain('no content');
  });
});
