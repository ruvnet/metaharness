import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp, createAppWith } from '../src/server';
import { COMPLETION_SCOPES, InMemoryKeyStore } from '../src/auth/apiKey';
import type { ModelProvider, ProviderDelta, ProviderResult } from '../src/providers/types';
import { ProviderError } from '../src/providers/types';
import type { ChatCompletionRequest } from '../src/types/openai';

const LOW = 'cog_' + '1'.repeat(64); // completions:low only
const ALL = 'cog_' + '2'.repeat(64); // low+mid+high

function seededStore(): InMemoryKeyStore {
  const s = new InMemoryKeyStore();
  s.add(LOW, { permissions: [COMPLETION_SCOPES.low], rateLimit: 120, active: true, expiresAt: null, accountId: 'a1' });
  s.add(ALL, {
    permissions: [COMPLETION_SCOPES.low, COMPLETION_SCOPES.mid, COMPLETION_SCOPES.high],
    rateLimit: 120,
    active: true,
    expiresAt: null,
    accountId: 'a2',
  });
  return s;
}

const app = createAppWith({ keyStore: seededStore() });
const HARD = '```\n' + 'design '.repeat(800) + '\n```'; // long + code + reasoning → high

describe('endpoints — /v1/chat/completions (ADR-203 §3.1, §3.4)', () => {
  it('rejects raw vendor model ids with 404', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      .send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('model_not_found');
  });

  it('explicit cognitum-low returns an OpenAI-shaped completion with x_cognitum', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.choices[0].message.role).toBe('assistant');
    expect(res.body.choices[0].finish_reason).toBe('stop');
    expect(res.body.usage).toHaveProperty('total_tokens');
    expect(res.body.x_cognitum.resolved_tier).toBe('low');
    expect(['deepseek-v4-pro', 'glm-5.2']).toContain(res.body.x_cognitum.resolved_model);
    expect(typeof res.body.x_cognitum.price_usd).toBe('number');
    expect(res.headers['x-cognitum-resolved-tier']).toBe('low');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('explicit high without the scope is 403', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-high', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('tier_scope_insufficient');
  });

  it('cognitum-auto routes an easy prompt to low', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'what is 2+2?' }] });
    expect(res.status).toBe(200);
    expect(res.body.x_cognitum.resolved_tier).toBe('low');
    expect(res.body.x_cognitum.escalated).toBe(false);
  });

  it('cognitum-auto routes a hard prompt to high up front', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: HARD }], max_tokens: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.x_cognitum.resolved_tier).toBe('high');
  });

  it('best_effort scope mismatch degrades (cap_degraded) instead of 403', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .set('X-Cognitum-Fallback-Policy', 'best_effort')
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: HARD }], max_tokens: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.x_cognitum.resolved_tier).toBe('low');
    expect(res.body.x_cognitum.cap_degraded).toBe(true);
    expect(res.headers['x-cognitum-cap-degraded']).toBe('true');
  });

  it('post-gen τ escalation: a hedged low answer escalates low→mid (§6.5)', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      // "tricky" looks easy (→ low) but the low-pool mock hedges → τ fires → escalate to mid
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'this is tricky' }] });
    expect(res.status).toBe(200);
    expect(res.body.x_cognitum.escalated).toBe(true);
    expect(res.body.x_cognitum.resolved_tier).toBe('mid');
  });

  it('enforces n=1 in v1', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }], n: 2 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('stream:true emits an OpenAI-compatible SSE (stream_oneshot, no escalation)', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello' }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['x-cognitum-resolved-tier']).toBe('low');
    expect(res.text).toContain('data:');
    expect(res.text).toContain('chat.completion.chunk');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('endpoints — provider fallback chain (ADR-203 §3.2)', () => {
  // A provider that fails the first low-pool model and succeeds on the second.
  const flaky: ModelProvider = {
    name: 'flaky',
    async complete(model: string, _req: ChatCompletionRequest): Promise<ProviderResult> {
      if (model === 'deepseek-v4-pro') throw new ProviderError('simulated 503', [model]);
      return { text: `served by ${model}`, usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } };
    },
    async *stream(): AsyncIterable<ProviderDelta> {
      yield { content: '', finishReason: 'stop' };
    },
  };

  it('fails over WITHIN the tier without changing the billed tier', async () => {
    const fbApp = createAppWith({ keyStore: seededStore(), provider: flaky });
    const res = await request(fbApp)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.body.x_cognitum.resolved_tier).toBe('low'); // tier unchanged
    expect(res.body.x_cognitum.resolved_model).toBe('glm-5.2'); // failed over to #2
  });

  it('returns 502 when the whole tier chain fails', async () => {
    const dead: ModelProvider = {
      name: 'dead',
      async complete(model: string): Promise<ProviderResult> {
        throw new ProviderError('down', [model]);
      },
      async *stream(): AsyncIterable<ProviderDelta> {
        yield { content: '', finishReason: 'stop' };
      },
    };
    const deadApp = createAppWith({ keyStore: seededStore(), provider: dead });
    const res = await request(deadApp)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('upstream_error');
    // The wire body must NOT leak the concrete vendor model roster / provider name (§3.4).
    expect(res.body.error).toBe('Upstream provider error.');
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('deepseek');
    expect(serialized).not.toContain('glm-');
    expect(serialized).not.toContain('tier chain');
  });
});

describe('endpoints — /v1/completions (legacy) + /v1/models', () => {
  it('legacy completions adapts prompt → messages and returns text_completion', async () => {
    const res = await request(app)
      .post('/v1/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', prompt: 'translate hello to French' });
    expect(res.status).toBe(200);
    expect(res.body.object).toBe('text_completion');
    expect(typeof res.body.choices[0].text).toBe('string');
    expect(res.body.x_cognitum.resolved_tier).toBe('low');
  });

  it('GET /v1/models still lists only the cognitum-* aliases', async () => {
    const res = await request(createApp()).get('/v1/models');
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['cognitum-auto', 'cognitum-low', 'cognitum-mid', 'cognitum-high']);
  });
});
