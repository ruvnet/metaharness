// SPDX-License-Identifier: MIT
//
// #183 — OpenRouterClient must surface failures loudly instead of returning
// an empty-string "success". A dead endpoint (404 No endpoints found) used to
// be indistinguishable from "the model said nothing".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenRouterClient } from '../src/models/openrouter.js';

const REQ = { model: 'test/model', system: 's', user: 'u' };

function stubFetch(impl: () => Promise<Response> | Promise<never>) {
  vi.stubGlobal('fetch', vi.fn(impl));
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('OpenRouterClient error surfacing (#183)', () => {
  it('throws with status + body on a non-2xx response (dead endpoint)', async () => {
    stubFetch(async () =>
      new Response('{"error":{"message":"No endpoints found for test/model.","code":404}}', { status: 404 }),
    );
    await expect(new OpenRouterClient().complete(REQ)).rejects.toThrow(/HTTP 404.*No endpoints found/s);
  });

  it('throws with context on a network error', async () => {
    stubFetch(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(new OpenRouterClient().complete(REQ)).rejects.toThrow(/network error.*ECONNRESET/s);
  });

  it('throws on a 2xx body carrying an error field', async () => {
    stubFetch(async () => new Response('{"error":{"message":"moderation block"}}', { status: 200 }));
    await expect(new OpenRouterClient().complete(REQ)).rejects.toThrow(/API error.*moderation block/s);
  });

  it('still returns text + usage on a genuine success', async () => {
    stubFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello' } }],
          usage: { cost: 0.001, prompt_tokens: 3, completion_tokens: 2 },
        }),
        { status: 200 },
      ),
    );
    const res = await new OpenRouterClient().complete(REQ);
    expect(res.text).toBe('hello');
    expect(res.costUsd).toBe(0.001);
  });
});
