import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createAppWith } from '../src/server';
import { COMPLETION_SCOPES, InMemoryKeyStore } from '../src/auth/apiKey';
import {
  InMemoryLedgerStore,
  InMemoryUsagePublisher,
  type UsageRecord,
} from '../src/metering/ledger';
import { priceUsd } from '../src/metering/pricing';
import {
  familyOf,
  estimateTokens,
  estimateTokensForFamily,
  makeCounter,
} from '../src/metering/tokenizer';
import {
  RateLimiter,
  InMemoryRateLimitStore,
} from '../src/ratelimit/limiter';
import { InMemoryIdempotencyStore } from '../src/ratelimit/idempotency';
import { loadConfig } from '../src/config';
import { fold, aggregate, periodOf, InMemoryRollupStore } from '../functions/aggregateUsage/src/index';
import type { Tier, Usage } from '../src/types/openai';

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

// ───────────────────────── Pricing (§5.2) ─────────────────────────
describe('pricing — strictly linear pass on the RESOLVED tier (ADR-203 §5.2)', () => {
  const cfg = loadConfig();
  const usage: Usage = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 };

  it('charges Input×Rate_In + Output×Rate_Out at the resolved tier', () => {
    const low = cfg.tierPools.low;
    expect(priceUsd(cfg, 'low', usage)).toBeCloseTo(low.rateInPer1M + low.rateOutPer1M, 6);
  });

  it('rates are ASYMMETRIC (output > input) per tier', () => {
    const inOnly: Usage = { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 };
    const outOnly: Usage = { prompt_tokens: 0, completion_tokens: 1_000_000, total_tokens: 1_000_000 };
    expect(priceUsd(cfg, 'mid', outOnly)).toBeGreaterThan(priceUsd(cfg, 'mid', inOnly));
  });

  it('escalation bills at the HIGHER resolved tier, not the requested one', () => {
    expect(priceUsd(cfg, 'high', usage)).toBeGreaterThan(priceUsd(cfg, 'low', usage));
  });
});

// ───────────────────── Family-correct tokenizer (§5.1) ─────────────────────
describe('tokenizer — family-correct byte→token floor (ADR-203 §5.1)', () => {
  it('resolves the BPE family from the resolved model id', () => {
    expect(familyOf('deepseek-v4-pro')).toBe('deepseek');
    expect(familyOf('glm-5.2')).toBe('glm');
    expect(familyOf('gpt-5.5')).toBe('openai');
    expect(familyOf('gemini-3.1-pro')).toBe('gemini');
    expect(familyOf('claude-opus-4.8')).toBe('anthropic');
    expect(familyOf('some-unknown-model')).toBe('unknown');
  });

  it('does NOT count non-OpenAI output with the OpenAI ratio (the §5.1 mis-bill bug)', () => {
    const text = 'def f(x):\n    return x * 2  # a representative chunk of generated output';
    const openai = estimateTokensForFamily('openai', text);
    const deepseek = estimateTokensForFamily('deepseek', text);
    const glm = estimateTokensForFamily('glm', text);
    // Distinct per family — deepseek/glm pack more bytes/token, so fewer tokens than OpenAI.
    expect(deepseek).not.toBe(openai);
    expect(glm).not.toBe(openai);
    expect(estimateTokens('deepseek-v4-pro', text)).toBe(deepseek);
    expect(estimateTokens('gpt-5.5', text)).toBe(openai);
  });

  it('progressive counter sums deltas as the FLOOR (provider count preferred when it arrives)', () => {
    const c = makeCounter('deepseek-v4-pro', 'low');
    expect(c.family).toBe('deepseek');
    expect(c.completionTokens()).toBe(0); // empty stream → 0
    c.pushDelta('hello ');
    c.pushDelta('world, this is a streamed answer.');
    const whole = estimateTokens('deepseek-v4-pro', 'hello world, this is a streamed answer.');
    expect(c.completionTokens()).toBe(whole); // byte-accumulate then divide once
  });
});

// ───────────────────── Rate limiter (§5.3) ─────────────────────
describe('rate limiter — scatter-gather COUNT() + debounce (ADR-203 §5.3)', () => {
  const KEY = 'hash-key-1';
  const TIER: Tier = 'low';

  it('admits up to the per-tier limit then denies with a retry hint', async () => {
    // debounce 0 → every check re-counts the append-only window (no soft over-admit).
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), { debounceMs: 0 });
    expect((await limiter.checkAndRecord(KEY, TIER, 2)).allowed).toBe(true);
    expect((await limiter.checkAndRecord(KEY, TIER, 2)).allowed).toBe(true);
    const denied = await limiter.checkAndRecord(KEY, TIER, 2);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts per (key, tier) — a different tier has an independent window', async () => {
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), { debounceMs: 0 });
    await limiter.checkAndRecord(KEY, 'low', 1);
    expect((await limiter.checkAndRecord(KEY, 'low', 1)).allowed).toBe(false); // low exhausted
    expect((await limiter.checkAndRecord(KEY, 'mid', 1)).allowed).toBe(true); // mid independent
  });

  it('TTL window: ticks outside the window are not counted', async () => {
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), { debounceMs: 0, windowMs: 30 });
    expect((await limiter.checkAndRecord(KEY, TIER, 1)).allowed).toBe(true);
    expect((await limiter.checkAndRecord(KEY, TIER, 1)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 45)); // let the window + TTL roll
    expect((await limiter.checkAndRecord(KEY, TIER, 1)).allowed).toBe(true);
  });

  it('debounce makes the limiter intentionally SOFT — bounded over-admit within the cache TTL', async () => {
    // A long debounce caches a stale count; optimistic increments still apply, but the
    // documented §5.3 trade is that a burst inside the TTL can briefly over-admit.
    const limiter = new RateLimiter(new InMemoryRateLimitStore(), { debounceMs: 5_000 });
    const a = await limiter.checkAndRecord(KEY, TIER, 1); // count 0 → admit, optimistic → 1
    const b = await limiter.checkAndRecord(KEY, TIER, 1); // cached 1 ≥ 1 → denied
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
  });

  it('returns 429 over HTTP with a Retry-After header when the tier limit is hit', async () => {
    const cfg = loadConfig();
    cfg.tierPools = { ...cfg.tierPools, low: { ...cfg.tierPools.low, rateLimitPerMin: 2 } };
    const app = createAppWith({
      config: cfg,
      keyStore: seededStore(),
      rateLimiter: new RateLimiter(new InMemoryRateLimitStore(), { debounceMs: 0 }),
    });
    const fire = () =>
      request(app)
        .post('/v1/chat/completions')
        .set('X-API-Key', LOW)
        .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }] });
    expect((await fire()).status).toBe(200);
    expect((await fire()).status).toBe(200);
    const limited = await fire();
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limit_exceeded');
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});

// ───────────────────── Idempotency (§5.3) ─────────────────────
describe('idempotency — 24h replay cache, NOT re-billed (ADR-203 §5.3)', () => {
  it('a replay returns the cached body and writes only ONE ledger row', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), ledger, idempotency: new InMemoryIdempotencyStore() });
    const send = () =>
      request(app)
        .post('/v1/chat/completions')
        .set('X-API-Key', LOW)
        .set('Idempotency-Key', 'idem-123')
        .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello' }] });

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.id).toBe(first.body.id); // identical cached body

    expect(ledger.size).toBe(1); // billed once, not twice
  });

  it('does NOT replay across API keys — the cache is namespaced per principal (sec-review §5.3)', async () => {
    const ledger = new InMemoryLedgerStore();
    const idempotency = new InMemoryIdempotencyStore();
    const app = createAppWith({ keyStore: seededStore(), ledger, idempotency });
    const send = (apiKey: string) =>
      request(app)
        .post('/v1/chat/completions')
        .set('X-API-Key', apiKey)
        .set('Idempotency-Key', 'shared-idem-key')
        .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'secret for key A' }] });

    // Key A (LOW) stores a completion under Idempotency-Key 'shared-idem-key'.
    const a = await send(LOW);
    expect(a.status).toBe(200);
    expect(a.headers['idempotent-replay']).toBeUndefined();

    // Key B (ALL) sends the SAME attacker-chosen Idempotency-Key → MUST MISS (no replay), and
    // is processed/billed on its own — never served A's cached body (cross-tenant leak).
    const b = await send(ALL);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBeUndefined(); // not a replay of A
    expect(b.body.id).not.toBe(a.body.id); // distinct completion, not A's leaked row

    expect(ledger.size).toBe(2); // both keys billed — no cross-tenant billing bypass
  });
});

// ───────────────────── Ledger + publish on the request path (§5.1) ─────────────────────
describe('metering — usage_ledger truth + Pub/Sub rollup feed (ADR-203 §5.1)', () => {
  it('writes one ledger row + publishes one usage event per completion', async () => {
    const ledger = new InMemoryLedgerStore();
    const publisher = new InMemoryUsagePublisher();
    const app = createAppWith({ keyStore: seededStore(), ledger, usagePublisher: publisher });

    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello world' }] });
    expect(res.status).toBe(200);

    await vi_flush();
    const rows = ledger.all();
    expect(rows).toHaveLength(1);
    const row: UsageRecord = rows[0];
    expect(row.tier).toBe('low');
    expect(row.accountId).toBe('a1');
    expect(row.keyPrefix).toBe('cog_11111111'); // only the 12-char prefix, never the key
    expect(row.priceUsd).toBeCloseTo(res.body.x_cognitum.price_usd, 9);
    expect(row.totalTokens).toBe(res.body.usage.total_tokens);
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].requestId).toBe(row.requestId);
  });

  it('escalation records the RESOLVED (higher) tier + escalated flag in the ledger (§5.2)', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), ledger });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'this is tricky' }] });
    expect(res.status).toBe(200);
    await vi_flush();
    const row = ledger.all()[0];
    expect(row.escalated).toBe(true);
    expect(row.tier).toBe('mid'); // billed at the tier that ran
  });

  it('streaming writes a family-correct local-floor ledger row on completion (§5.1)', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), ledger });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello' }], stream: true });
    expect(res.status).toBe(200);
    await vi_flush();
    const row = ledger.all()[0];
    expect(row).toBeTruthy();
    expect(row.tokensFromLocalFloor).toBe(true);
    expect(row.completionTokens).toBeGreaterThan(0);
  });

  it('legacy /v1/completions also meters (§5.1)', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), ledger });
    const res = await request(app)
      .post('/v1/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', prompt: 'translate hello' });
    expect(res.status).toBe(200);
    await vi_flush();
    expect(ledger.size).toBe(1);
  });
});

// ───────────────────── aggregateUsage fold (§5.1) ─────────────────────
describe('aggregateUsage — Pub/Sub → usage_rollups fold (ADR-203 §5.1)', () => {
  const evt = (over: Partial<Parameters<typeof fold>[1]> = {}) => ({
    accountId: 'acct-1',
    tier: 'low',
    resolvedModel: 'deepseek-v4-pro',
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    priceUsd: 0.001,
    ts: Date.UTC(2026, 5, 27),
    ...over,
  });

  it('periodOf derives the UTC YYYY-MM billing period', () => {
    expect(periodOf(Date.UTC(2026, 0, 5))).toBe('2026-01');
    expect(periodOf(Date.UTC(2026, 11, 31))).toBe('2026-12');
  });

  it('folds events into per-tier / per-model buckets + running totals', () => {
    let doc = fold(null, evt());
    doc = fold(doc, evt({ tier: 'high', resolvedModel: 'claude-opus-4.8', priceUsd: 0.05, totalTokens: 100 }));
    expect(doc.totals.requests).toBe(2);
    expect(doc.totals.totalTokens).toBe(130);
    expect(doc.byTier.low.requests).toBe(1);
    expect(doc.byTier.high.priceUsd).toBeCloseTo(0.05, 9);
    expect(doc.byModel['deepseek-v4-pro'].requests).toBe(1);
  });

  it('aggregate read-fold-writes into usage_rollups/{accountId}/{period}', async () => {
    const store = new InMemoryRollupStore();
    await aggregate(store, evt());
    await aggregate(store, evt());
    const doc = await store.get('acct-1', '2026-06');
    expect(doc?.totals.requests).toBe(2);
    expect(doc?.totals.priceUsd).toBeCloseTo(0.002, 9);
  });
});

/** Let detached fire-and-forget publishes + close-handler microtasks settle before asserting. */
async function vi_flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}
