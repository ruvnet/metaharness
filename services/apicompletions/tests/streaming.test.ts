// Streaming paths + disconnect billing + inflight Option C′ (ADR-203 §3.3, §3.5, §5.1).
// All $0: MockProvider + in-memory ledger; no paid model calls, no emulator network.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import type { Response } from 'express';
import { createAppWith } from '../src/server';
import { COMPLETION_SCOPES, InMemoryKeyStore } from '../src/auth/apiKey';
import type { ApiKeyDoc } from '../src/auth/apiKey';
import { InMemoryLedgerStore } from '../src/metering/ledger';
import { MockProvider } from '../src/providers/mockProvider';
import { defaultDeps } from '../src/deps';
import type { ModelProvider, ProviderDelta, ProviderResult } from '../src/providers/types';
import type { ChatCompletionRequest } from '../src/types/openai';
import type { TierResolution } from '../src/tier/resolveTier';
import {
  buildTruncationChunk,
  loadInflightScanner,
  streamInflight,
  type EscalationSignal,
  type InflightScanner,
} from '../src/midstream/inflight';

const LOW = 'cog_' + '1'.repeat(64);
const ALL = 'cog_' + '2'.repeat(64);

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

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Parse an SSE body into the decoded chunk objects (drops the [DONE] sentinel). */
function parseChunks(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .map((s) => s.replace(/^data: /, '').trim())
    .filter((s) => s.length > 0 && s !== '[DONE]')
    .map((s) => JSON.parse(s) as Record<string, unknown>);
}

interface Chunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { completion_tokens: number };
  x_cognitum?: {
    escalated: boolean;
    resolved_tier: string;
    next_context?: string;
    discarded_prefix_tokens?: number;
  };
}
const as = (c: Record<string, unknown>): Chunk => c as Chunk;

/** A provider that streams several deltas with a delay between each (for disconnect tests). */
function slowProvider(deltas = ['alpha ', 'bravo ', 'charlie ', 'delta ', 'echo '], delayMs = 15): ModelProvider {
  return {
    name: 'slow',
    async complete(model: string): Promise<ProviderResult> {
      return { text: deltas.join(''), usage: { prompt_tokens: 1, completion_tokens: deltas.length, total_tokens: deltas.length + 1 } };
    },
    async *stream(): AsyncIterable<ProviderDelta> {
      for (const d of deltas) {
        await tick(delayMs);
        yield { content: d, finishReason: null };
      }
      yield { content: '', finishReason: 'stop' };
    },
  };
}

/** A provider that streams one good delta, then throws (provider 5xx mid-stream). */
function throwAfterFirst(): ModelProvider {
  return {
    name: 'throw-after-first',
    async complete(): Promise<ProviderResult> {
      return { text: 'partial answer ', usage: undefined };
    },
    async *stream(): AsyncIterable<ProviderDelta> {
      yield { content: 'partial answer ', finishReason: null };
      // Carries vendor detail that must NEVER reach the client (§3.4).
      throw new Error('openrouter deepseek-v4-pro → HTTP 503');
    },
  };
}

// ───────────────────── integration — the route streaming paths ─────────────────────
describe('streaming — /v1/chat/completions SSE paths (ADR-203 §3.3)', () => {
  it('stream_oneshot (default for stream:true): OpenAI-shaped SSE + final usage/x_cognitum chunk', async () => {
    const app = createAppWith({ keyStore: seededStore(), provider: new MockProvider() });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello world' }], stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const chunks = parseChunks(res.text).map(as);
    // Content deltas exist, the trailing chunk carries usage + x_cognitum, no escalation.
    expect(chunks.some((c) => c.choices?.[0]?.delta?.content)).toBe(true);
    const last = chunks[chunks.length - 1];
    expect(last.usage?.completion_tokens).toBeGreaterThan(0);
    expect(last.x_cognitum?.escalated).toBe(false);
    expect(last.x_cognitum?.resolved_tier).toBe('low');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('escalation:"buffered" buffers → verifies → pseudo-streams the escalated answer (§3.3)', async () => {
    const app = createAppWith({ keyStore: seededStore(), provider: new MockProvider() });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', ALL)
      // "tricky" routes low, the low-pool mock hedges → τ fires → buffered escalates low→mid
      .send({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'this is tricky' }], stream: true, escalation: 'buffered' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const chunks = parseChunks(res.text).map(as);
    const stop = chunks.find((c) => c.choices?.[0]?.finish_reason === 'stop');
    expect(stop?.x_cognitum?.escalated).toBe(true);
    expect(stop?.x_cognitum?.resolved_tier).toBe('mid');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('escalation:"inflight" degrades to Option B today (midstream 404) — oneshot, no truncation chunk', async () => {
    const app = createAppWith({ keyStore: seededStore(), provider: new MockProvider() });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hello' }], stream: true, escalation: 'inflight' });
    expect(res.status).toBe(200);
    const chunks = parseChunks(res.text).map(as);
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason === 'content_filter')).toBe(false);
    const last = chunks[chunks.length - 1];
    expect(last.x_cognitum?.escalated).toBe(false);
    expect(last.x_cognitum?.resolved_tier).toBe('low');
  });

  it('client disconnect mid-stream bills the partial answer with truncated:true (§5.1)', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), provider: slowProvider(), ledger });
    const pending = request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'stream please' }], stream: true });
    setTimeout(() => pending.abort(), 30); // drop the socket after the first chunk(s)
    await pending.then(() => undefined, () => undefined); // aborted request rejects — swallow
    await tick(120); // let res 'close' + the truncation meter settle
    const rows = ledger.all();
    expect(rows).toHaveLength(1); // exactly one row — NOT overwritten by a normal-completion meter
    expect(rows[0].truncated).toBe(true);
    expect(rows[0].tier).toBe('low');
    expect(rows[0].tokensFromLocalFloor).toBe(true);
  });

  it('provider error AFTER the first chunk → terminal SSE error (no headers-already-sent crash), bills once, no vendor leak (sec-review §3.3/§3.4)', async () => {
    const ledger = new InMemoryLedgerStore();
    const app = createAppWith({ keyStore: seededStore(), provider: throwAfterFirst(), ledger });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set('X-API-Key', LOW)
      .send({ model: 'cognitum-low', messages: [{ role: 'user', content: 'hi' }], stream: true });
    // Headers were already flushed by the first chunk → status is 200 SSE, NOT a 502 JSON.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('partial answer'); // the delta delivered before the error
    // A terminal error chunk is emitted with a GENERIC message — no vendor id / provider name.
    const errChunk = parseChunks(res.text).find((c) => (c as { error?: unknown }).error) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    expect(errChunk?.error?.code).toBe('upstream_error');
    expect(errChunk?.error?.message).toBe('Upstream provider error.');
    expect(res.text).not.toContain('deepseek');
    expect(res.text).not.toContain('openrouter');
    expect(res.text).not.toContain('HTTP 503');
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await tick(60); // let res 'close' + the truncation meter settle
    const rows = ledger.all();
    expect(rows).toHaveLength(1); // billed exactly once (partial, truncated) — not double-billed
    expect(rows[0].truncated).toBe(true);
  });
});

// ───────────────────── unit — midstream firewall + inflight protocol (§3.5) ─────────────────────
const lowResolution = (): TierResolution => ({
  kind: 'ok',
  tier: 'low',
  mode: 'auto',
  agentic: false,
  capDegraded: false,
  routingReason: 'difficulty: low',
  floor: 'low',
  ceiling: 'high',
});

const allKey = (): ApiKeyDoc => ({
  key: 'hash',
  prefix: 'cog_22222222',
  permissions: [COMPLETION_SCOPES.low, COMPLETION_SCOPES.mid, COMPLETION_SCOPES.high],
  rateLimit: 120,
  active: true,
  expiresAt: null,
  accountId: 'a2',
});

/** A scanner that fires the given signal on the Nth content delta (else null). */
function scannerAfter(n: number, signal: EscalationSignal): InflightScanner {
  let i = 0;
  return {
    push(): EscalationSignal | null {
      i += 1;
      return i >= n ? signal : null;
    },
  };
}

/** Minimal Response capturing SSE writes + a fireable 'close' (client-disconnect) event. */
class FakeRes {
  readonly chunks: string[] = [];
  ended = false;
  private closeCbs: Array<() => void> = [];
  setHeader(): void {}
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  on(event: string, cb: () => void): this {
    if (event === 'close') this.closeCbs.push(cb);
    return this;
  }
  fireClose(): void {
    for (const cb of this.closeCbs) cb();
  }
  get text(): string {
    return this.chunks.join('');
  }
}

describe('midstream inflight — firewall + SDK-safe truncation (ADR-203 §3.5)', () => {
  it('loadInflightScanner returns null today (@midstream/wasm 404 → Option B)', async () => {
    const scanner = await loadInflightScanner({ model: 'cognitum-auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(scanner).toBeNull();
  });

  it('buildTruncationChunk emits an SDK-safe terminal chunk (finish_reason + escalation block)', () => {
    const c = as(
      buildTruncationChunk({
        id: 'x',
        created: 1,
        model: 'cognitum-auto',
        signal: { reason: 'explicit_refusal', finishReason: 'content_filter' },
        resolvedTier: 'high',
        nextContext: 'x:high',
      }),
    );
    expect(c.choices?.[0]?.finish_reason).toBe('content_filter');
    expect(c.x_cognitum?.escalated).toBe(true);
    expect(c.x_cognitum?.resolved_tier).toBe('high');
    expect(c.x_cognitum?.next_context).toBe('x:high');
  });

  it('streamInflight: a present scanner fires → SDK-safe truncation + higher-tier bridge + honest billing', async () => {
    const ledger = new InMemoryLedgerStore();
    const deps = defaultDeps({ ledger, provider: new MockProvider() });
    const res = new FakeRes();
    const signal: EscalationSignal = { reason: 'loop_detected', finishReason: 'content_filter' };
    await streamInflight({
      deps,
      res: res as unknown as Response,
      requestId: 'req-esc',
      body: { model: 'cognitum-auto', messages: [{ role: 'user', content: 'hello world this is a test prompt' }], stream: true, escalation: 'inflight' },
      resolution: lowResolution(),
      key: allKey(),
      keyPrefix: 'cog_22222222',
      startedAt: Date.now(),
      scanner: scannerAfter(2, signal),
    });
    const chunks = parseChunks(res.text).map(as);
    const trunc = chunks.find((c) => c.choices?.[0]?.finish_reason === 'content_filter');
    expect(trunc).toBeTruthy();
    expect(trunc?.x_cognitum?.escalated).toBe(true);
    expect(trunc?.x_cognitum?.resolved_tier).toBe('mid'); // low → next tier up
    expect(trunc?.x_cognitum?.next_context).toBe('req-esc:mid');
    expect(res.ended).toBe(true);
    expect(res.text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await tick(10);
    const row = ledger.get('req-esc');
    expect(row?.tier).toBe('mid'); // delivered answer billed at the escalated tier (§3.5)
    expect(row?.escalated).toBe(true);
    expect(row?.discardedPrefixTokens).toBeGreaterThan(0); // wasted low prefix recorded honestly
  });

  it('streamInflight: no early signal → finishes at the starting tier (Option B-equivalent)', async () => {
    const ledger = new InMemoryLedgerStore();
    const deps = defaultDeps({ ledger, provider: new MockProvider() });
    const res = new FakeRes();
    await streamInflight({
      deps,
      res: res as unknown as Response,
      requestId: 'req-clean',
      body: { model: 'cognitum-auto', messages: [{ role: 'user', content: 'hello world' }], stream: true, escalation: 'inflight' },
      resolution: lowResolution(),
      key: allKey(),
      keyPrefix: 'cog_22222222',
      startedAt: Date.now(),
      scanner: { push: () => null },
    });
    const chunks = parseChunks(res.text).map(as);
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason === 'content_filter')).toBe(false);
    expect(chunks[chunks.length - 1].x_cognitum?.escalated).toBe(false);
    await tick(10);
    const row = ledger.get('req-clean');
    expect(row?.tier).toBe('low');
    expect(row?.escalated).toBe(false);
    expect(row?.discardedPrefixTokens).toBeUndefined();
  });

  it('streamInflight: client disconnect mid-stream bills truncated:true (§5.1)', async () => {
    const ledger = new InMemoryLedgerStore();
    const deps = defaultDeps({ ledger, provider: slowProvider() });
    const res = new FakeRes();
    const p = streamInflight({
      deps,
      res: res as unknown as Response,
      requestId: 'req-drop',
      body: { model: 'cognitum-auto', messages: [{ role: 'user', content: 'stream please' }], stream: true, escalation: 'inflight' },
      resolution: lowResolution(),
      key: allKey(),
      keyPrefix: 'cog_22222222',
      startedAt: Date.now(),
      scanner: { push: () => null },
    });
    await tick(20); // let a delta or two flow
    res.fireClose(); // client drops the connection
    await p;
    await tick(10);
    const row = ledger.get('req-drop');
    expect(row?.truncated).toBe(true);
    expect(row?.tier).toBe('low');
    expect(row?.escalated).toBe(false);
  });
});
