import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server';

describe('apicompletions skeleton — health + surface', () => {
  const app = createApp();

  it('GET /healthz returns ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('apicompletions');
  });

  it('GET /v1/models lists the four cognitum-* aliases (not raw vendor ids)', async () => {
    const res = await request(app).get('/v1/models');
    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['cognitum-auto', 'cognitum-low', 'cognitum-mid', 'cognitum-high']);
  });

  it('POST /v1/chat/completions without an API key is 401 (auth enforced, §6)', async () => {
    const res = await request(app)
      .post('/v1/chat/completions')
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_api_key');
    expect(res.body).toHaveProperty('requestId');
  });
});
