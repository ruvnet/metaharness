// SPDX-License-Identifier: MIT
//
// Tests for openrouter.ts — the OPTIONAL real-LLM client. These use a MOCKED fetch
// so they are fully deterministic and spend nothing (no network, no key needed).
// They cover the request-cap budget guard, JSON parsing (incl. fenced/prose), usage
// accounting, and the availability probe — the real bench (handoff-llm.bench.mjs)
// is the only thing that makes real calls, and it is not part of this suite.

import { describe, it, expect, vi } from 'vitest';
import { OpenRouterClient, tryParseJson, openRouterAvailable } from '../src/openrouter.js';

/** A fake fetch returning a canned chat-completion payload. */
function fakeFetch(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('tryParseJson', () => {
  it('parses plain JSON, fenced JSON, and JSON embedded in prose', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(tryParseJson('Sure! Here it is: {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(tryParseJson('not json at all')).toBeNull();
  });
});

describe('OpenRouterClient (mocked fetch — deterministic, no spend)', () => {
  it('returns raw + parsed content and accumulates usage', async () => {
    const client = new OpenRouterClient({ apiKey: 'test', fetchImpl: fakeFetch('{"ok":true}') });
    const r = await client.chatJSON([{ role: 'user', content: 'hi' }]);
    expect(r.parsed).toEqual({ ok: true });
    expect(client.stats()).toEqual({ requests: 1, promptTokens: 10, completionTokens: 5 });
  });

  it('enforces the request cap (budget guard) by throwing', async () => {
    const client = new OpenRouterClient({ apiKey: 'test', maxRequests: 2, fetchImpl: fakeFetch('{}') });
    await client.chatJSON([{ role: 'user', content: '1' }]);
    await client.chatJSON([{ role: 'user', content: '2' }]);
    await expect(client.chatJSON([{ role: 'user', content: '3' }])).rejects.toThrow(/request cap/);
    expect(client.stats().requests).toBe(2); // the capped call never incremented past the cap
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const errFetch = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const client = new OpenRouterClient({ apiKey: 'test', fetchImpl: errFetch });
    await expect(client.chatJSON([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 429/);
  });

  it('refuses to call without a key', async () => {
    const client = new OpenRouterClient({ apiKey: '', fetchImpl: fakeFetch('{}') });
    await expect(client.chatJSON([{ role: 'user', content: 'x' }])).rejects.toThrow(/key absent/);
  });

  it('availability reflects the environment', () => {
    expect(typeof openRouterAvailable()).toBe('boolean');
  });
});
