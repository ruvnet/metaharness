// Anthropic Messages API (/v1/messages) — emulator-first ($0, mock provider) tests.
// Covers: the model→tier map, the non-streaming Anthropic response shape, the streaming event
// sequence, the honesty guard (real resolved model surfaced, never misrepresented as Claude),
// auth via x-api-key, and the pure translation/SSE adapters.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createAppWith } from '../src/server';
import { COMPLETION_SCOPES, InMemoryKeyStore } from '../src/auth/apiKey';
import {
  mapModelToDial,
  anthropicToCanonical,
  buildAnthropicResponse,
  mapStopReason,
  extractText,
} from '../src/anthropic/translate';
import {
  messageStartEvent,
  contentBlockStartEvent,
  pingEvent,
  contentBlockDeltaEvent,
  contentBlockStopEvent,
  messageDeltaEvent,
  messageStopEvent,
} from '../src/anthropic/sse';
import type { XCognitum } from '../src/types/openai';

const KEY = 'cog_' + '5'.repeat(64); // low+mid+high

function keyStore(): InMemoryKeyStore {
  const s = new InMemoryKeyStore();
  s.add(KEY, {
    permissions: [COMPLETION_SCOPES.low, COMPLETION_SCOPES.mid, COMPLETION_SCOPES.high],
    rateLimit: 1000,
    active: true,
    expiresAt: null,
    accountId: 'acct-anthropic',
  });
  return s;
}

// ───────────────────── Translation adapter (pure) ─────────────────────
describe('anthropic translate — model→tier map + canonical translation (§3.6)', () => {
  it('maps Claude family names to tiers (opus→high, sonnet→mid, haiku→low)', () => {
    expect(mapModelToDial('claude-opus-4-8')).toBe('cognitum-high');
    expect(mapModelToDial('claude-3-5-sonnet-20241022')).toBe('cognitum-mid');
    expect(mapModelToDial('claude-haiku-4')).toBe('cognitum-low');
  });
  it('passes cognitum-* dials through verbatim', () => {
    expect(mapModelToDial('cognitum-auto')).toBe('cognitum-auto');
    expect(mapModelToDial('cognitum-high')).toBe('cognitum-high');
  });
  it('falls back to cognitum-auto for an unrecognized model', () => {
    expect(mapModelToDial('some-other-model')).toBe('cognitum-auto');
  });
  it('extracts text from both string and block-array content', () => {
    expect(extractText('hi')).toBe('hi');
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab');
    expect(extractText([{ type: 'image', source: {} } as never, { type: 'text', text: 'c' }])).toBe('c');
  });
  it('lifts the top-level system field into a leading system message', () => {
    const canon = anthropicToCanonical({
      model: 'claude-haiku-4',
      max_tokens: 100,
      system: 'be terse',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(canon.model).toBe('cognitum-low');
    expect(canon.messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(canon.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(canon.max_tokens).toBe(100);
  });
  it('maps OpenAI finish_reason → Anthropic stop_reason (length→max_tokens, else end_turn)', () => {
    expect(mapStopReason('length')).toBe('max_tokens');
    expect(mapStopReason('stop')).toBe('end_turn');
    expect(mapStopReason(undefined)).toBe('end_turn');
  });
  it('buildAnthropicResponse surfaces the REAL resolved model (honesty guard)', () => {
    const xc: XCognitum = { request_id: 'r', resolved_tier: 'low', resolved_model: 'deepseek-v4-pro', escalated: false, cap_degraded: false, price_usd: 0 };
    const resp = buildAnthropicResponse({
      requestId: 'r', resolvedModel: 'deepseek-v4-pro', text: 'hi',
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, stopReason: 'end_turn', xCognitum: xc,
    });
    expect(resp.type).toBe('message');
    expect(resp.model).toBe('deepseek-v4-pro'); // NOT claude-*
    expect(resp.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(resp.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });
});

// ───────────────────── SSE adapter (pure) ─────────────────────
describe('anthropic SSE — event frame builders (§3.6 streaming)', () => {
  it('frames carry the Anthropic event:/data: shape', () => {
    const f = contentBlockDeltaEvent('hello');
    expect(f).toContain('event: content_block_delta');
    expect(f).toContain('"type":"text_delta"');
    expect(f).toContain('"text":"hello"');
    expect(f.endsWith('\n\n')).toBe(true);
  });
  it('message_start carries the real model + zeroed output_tokens', () => {
    const f = messageStartEvent({ id: 'msg_1', model: 'glm-5.2', inputTokens: 7 });
    expect(f).toContain('event: message_start');
    expect(f).toContain('"model":"glm-5.2"');
    expect(f).toContain('"input_tokens":7');
    expect(f).toContain('"output_tokens":0');
  });
});

// ───────────────────── Auth ─────────────────────
describe('/v1/messages — auth via x-api-key (§6)', () => {
  it('401 without an API key', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app).post('/v1/messages').send({ model: 'claude-haiku-4', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(401);
  });
  it('authenticates via x-api-key (case-insensitive header) and ignores anthropic-version', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .set('anthropic-version', '2023-06-01')
      .send({ model: 'claude-haiku-4', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
  });
});

// ───────────────────── Non-streaming response shape + honesty guard ─────────────────────
describe('/v1/messages — non-streaming Anthropic response (§3.6)', () => {
  it('returns the Anthropic message shape', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .send({ model: 'cognitum-high', max_tokens: 64, system: 'be brief', messages: [{ role: 'user', content: 'what is 2+2?' }] });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('message');
    expect(r.body.role).toBe('assistant');
    expect(Array.isArray(r.body.content)).toBe(true);
    expect(r.body.content[0].type).toBe('text');
    expect(typeof r.body.content[0].text).toBe('string');
    expect(r.body.id).toMatch(/^msg_/);
    expect(r.body.stop_reason).toBe('end_turn');
    expect(r.body.usage).toHaveProperty('input_tokens');
    expect(r.body.usage).toHaveProperty('output_tokens');
  });

  it('honesty guard: haiku (→low) resolves to a NON-Anthropic model surfaced in model + x_cognitum', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .send({ model: 'claude-haiku-4', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    // The low pool serves deepseek/glm — the response must NOT misrepresent it as Claude.
    expect(r.body.x_cognitum.resolved_tier).toBe('low');
    expect(['deepseek-v4-pro', 'glm-5.2']).toContain(r.body.x_cognitum.resolved_model);
    expect(r.body.model).toBe(r.body.x_cognitum.resolved_model);
    expect(r.body.model).not.toMatch(/claude/i);
    expect(r.headers['x-cognitum-resolved-model']).toBe(r.body.model);
  });

  it('tier map: opus→high resolves at the high tier', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .send({ model: 'claude-opus-4-8', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(r.body.x_cognitum.resolved_tier).toBe('high');
  });

  it('400 when max_tokens is missing (Anthropic requires it)', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .send({ model: 'claude-haiku-4', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
  });
});

// ───────────────────── Streaming event sequence ─────────────────────
describe('/v1/messages — streaming event sequence (§3.6)', () => {
  it('synthesizes the Anthropic event sequence from the (non-Anthropic) mock provider', async () => {
    const app = createAppWith({ keyStore: keyStore() });
    const r = await request(app)
      .post('/v1/messages')
      .set('X-API-Key', KEY)
      .send({ model: 'claude-haiku-4', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'stream please' }] });
    expect(r.status).toBe(200);
    const text = r.text;
    // The required events appear in order.
    const order = ['message_start', 'content_block_start', 'ping', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
    let cursor = -1;
    for (const ev of order) {
      const idx = text.indexOf(`event: ${ev}`, cursor + 1);
      expect(idx, `event ${ev} present and ordered`).toBeGreaterThan(cursor);
      cursor = idx;
    }
    // The streamed terminal frame carries the honest resolution + the text_delta payload.
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toMatch(/"resolved_tier":"low"/);
  });
});
