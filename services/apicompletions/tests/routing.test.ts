import { describe, it, expect } from 'vitest';
import type { ApiKeyDoc } from '../src/auth/apiKey';
import { COMPLETION_SCOPES } from '../src/auth/apiKey';
import { parseModelAlias, resolveTier, tierRank, nextTierUp } from '../src/tier/resolveTier';
import { computeDifficulty } from '../src/router/difficulty';
import { shouldEscalate, verify } from '../src/router/escalation';
import type { ChatCompletionRequest, Tier } from '../src/types/openai';

function key(...tiers: Tier[]): ApiKeyDoc {
  return {
    key: 'hash',
    prefix: 'cog_xxxxxxxx',
    permissions: tiers.map((t) => COMPLETION_SCOPES[t]),
    rateLimit: 100,
    active: true,
    expiresAt: null,
    accountId: 'acct',
  };
}

function chat(model: string, content: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model, messages: [{ role: 'user', content }], ...extra };
}

describe('parseModelAlias (ADR-203 §3.4) — model field is the dial', () => {
  it('maps the cognitum-* aliases', () => {
    expect(parseModelAlias('cognitum-auto')).toEqual({ mode: 'auto', agentic: false });
    expect(parseModelAlias('cognitum-low')).toEqual({ mode: 'explicit', tier: 'low', agentic: false });
    expect(parseModelAlias('cognitum-mid')).toEqual({ mode: 'explicit', tier: 'mid', agentic: false });
    expect(parseModelAlias('cognitum-high')).toEqual({ mode: 'explicit', tier: 'high', agentic: false });
    expect(parseModelAlias('cognitum-high-agent')).toEqual({ mode: 'explicit', tier: 'high', agentic: true });
    expect(parseModelAlias('cognitum-auto-agent')).toEqual({ mode: 'auto', agentic: true });
  });

  it('rejects raw vendor ids (→ 404 model_not_found)', () => {
    expect(parseModelAlias('gpt-5.5')).toBeNull();
    expect(parseModelAlias('claude-opus-4.8')).toBeNull();
    expect(parseModelAlias('deepseek-v4-pro')).toBeNull();
    expect(parseModelAlias('')).toBeNull();
  });
});

describe('computeDifficulty (ADR-203 §3.3, PLACEMENT §7) — intrinsic input signal', () => {
  it('routes everyday short prompts to low', () => {
    expect(computeDifficulty(chat('cognitum-auto', 'what time is it in Tokyo?')).tier).toBe('low');
  });
  it('lifts on code/diff presence', () => {
    const d = computeDifficulty(chat('cognitum-auto', '```py\nimport os\ndef f():\n  return 1\n```'));
    expect(tierRank(d.tier)).toBeGreaterThanOrEqual(tierRank('mid'));
  });
  it('escalates to high on long reasoning + code + tools', () => {
    const big = 'design '.repeat(800); // long + reasoning marker
    const d = computeDifficulty(chat('cognitum-auto', '```\n' + big + '\n```', { tools: [{}], max_tokens: 5000 }));
    expect(d.tier).toBe('high');
  });
});

describe('resolveTier (ADR-203 §3.3, §6 item 2)', () => {
  it('explicit mode pins the tier and requires the matching scope', () => {
    const ok = resolveTier(chat('cognitum-low', 'hi'), key('low'));
    expect(ok).toMatchObject({ kind: 'ok', tier: 'low', mode: 'explicit' });
    const denied = resolveTier(chat('cognitum-high', 'hi'), key('low'));
    expect(denied).toMatchObject({ kind: 'error', status: 403, code: 'tier_scope_insufficient' });
  });

  it('returns 404 for raw vendor model ids', () => {
    expect(resolveTier(chat('gpt-5.5', 'hi'), key('high'))).toMatchObject({ kind: 'error', status: 404, code: 'model_not_found' });
  });

  it('auto mode routes by difficulty within held scope', () => {
    const r = resolveTier(chat('cognitum-auto', 'what is 2+2?'), key('low', 'mid', 'high'));
    expect(r).toMatchObject({ kind: 'ok', tier: 'low', mode: 'auto' });
  });

  it('auto: min_tier is a quality floor, max_tier a cost cap', () => {
    const floored = resolveTier(chat('cognitum-auto', 'hi', { min_tier: 'mid' }), key('low', 'mid', 'high'));
    expect(floored).toMatchObject({ kind: 'ok', tier: 'mid' });
    const big = 'design '.repeat(800);
    const capped = resolveTier(chat('cognitum-auto', '```\n' + big + '\n```', { max_tokens: 5000, max_tier: 'mid' }), key('low', 'mid', 'high'));
    expect(capped).toMatchObject({ kind: 'ok', tier: 'mid' }); // high difficulty capped to mid
  });

  it('auto scope-mismatch: fail_fast → 403, best_effort → cap_degraded', () => {
    const big = 'design '.repeat(800);
    const hard = '```\n' + big + '\n```';
    const failFast = resolveTier(chat('cognitum-auto', hard, { max_tokens: 5000 }), key('low'));
    expect(failFast).toMatchObject({ kind: 'error', status: 403, code: 'tier_scope_insufficient' });

    const bestEffort = resolveTier(chat('cognitum-auto', hard, { max_tokens: 5000, fallback_policy: 'best_effort' }), key('low'));
    expect(bestEffort).toMatchObject({ kind: 'ok', tier: 'low', capDegraded: true });
  });

  it('auto with no completions scope → 403', () => {
    const k: ApiKeyDoc = { ...key(), permissions: ['payments:create'] };
    expect(resolveTier(chat('cognitum-auto', 'hi'), k)).toMatchObject({ kind: 'error', status: 403, code: 'no_completions_scope' });
  });
});

describe('escalation — internal adaptive τ (ADR-203 §6.5), non-stream only', () => {
  it('verify flags hedging as low confidence', () => {
    expect(verify("I'm not entirely sure about this").confidence).toBeLessThan(0.6);
    expect(verify('The capital of France is Paris.').confidence).toBeGreaterThanOrEqual(0.6);
    expect(verify('anything', 0.2).confidence).toBe(0.2); // provider signal pre-empts
  });

  it('escalates a low-confidence low answer to mid, bounded by ceiling', () => {
    const lowConf = { confidence: 0.4 };
    expect(shouldEscalate(lowConf, 'low', 'high')).toMatchObject({ escalate: true, nextTier: 'mid' });
    // ceiling caps it
    expect(shouldEscalate(lowConf, 'low', 'low')).toMatchObject({ escalate: false });
    // high confidence never escalates
    expect(shouldEscalate({ confidence: 0.95 }, 'low', 'high')).toMatchObject({ escalate: false });
    // already at the ceiling
    expect(shouldEscalate(lowConf, 'high', 'high')).toMatchObject({ escalate: false });
  });

  it('tier helpers', () => {
    expect(nextTierUp('low')).toBe('mid');
    expect(nextTierUp('mid')).toBe('high');
    expect(nextTierUp('high')).toBeNull();
  });
});
