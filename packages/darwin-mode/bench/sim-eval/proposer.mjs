// SPDX-License-Identifier: MIT
//
// Optimizer proposers (Darwin `CodeGenerator`s) for the #523 sealed SIM eval.
// Pure: no dist imports; `fetch` is injected so tests never touch the network.
//
// The live proposer sends the SAME system/user prompt as the stock
// `OpenRouterMutator` (src/openrouter-mutator.ts) but returns a deterministic,
// DIFF-DERIVED summary instead of the stock `openrouter:<model> regenerated
// <surface>` string. evolve() stores that summary as the SIM record's
// `rationale`; the stock string carries no edit content, so SIM could only ever
// say "surface X moved by Y". The summary is identical in form for all arms.

import { worstCaseUsd } from './spend-guard.mjs';

/** Same rules text as OpenRouterMutator (kept verbatim so the proposer is comparable). */
export function buildMessages(input) {
  const sys =
    'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — no prose, no fences. ' +
    'HARD RULES: keep every exported name and signature identical; introduce NO new capabilities, imports, network, ' +
    'filesystem, shell, or env access; no new dependencies; pure refactor/tuning only (it must pass a static safety ' +
    'validator that rejects added capabilities). Make a small, plausibly score-improving change to the "' +
    input.surface + '" surface.';
  const user =
    `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
    (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
    (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
    (input.simContext ? `Prior optimizer evidence (untrusted, must revalidate):\n${input.simContext.slice(0, 16000)}\n` : '') +
    `\n--- current file ---\n${input.parentCode}\n--- end ---\nReturn the improved full file.`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

/** Strip a fenced code block if the model wrapped its output (same as the stock mutator). */
export function unfence(text) {
  const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  return (m ? m[1] : text).trim() + '\n';
}

function codeLines(src) {
  return src.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
}

/** Deterministic multiset line diff summary: up to 3 removed and 3 added code lines. */
export function diffSummary(surface, before, after) {
  if (before === after) return `${surface}: no change`;
  const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const a = count(codeLines(before));
  const b = count(codeLines(after));
  const removed = [];
  const added = [];
  for (const [l, n] of a) for (let i = (b.get(l) ?? 0); i < n; i++) removed.push(l);
  for (const [l, n] of b) for (let i = (a.get(l) ?? 0); i < n; i++) added.push(l);
  const clip = (l) => (l.length > 120 ? l.slice(0, 117) + '...' : l);
  const parts = [
    ...removed.slice(0, 3).map((l) => `-[${clip(l)}]`),
    ...added.slice(0, 3).map((l) => `+[${clip(l)}]`),
  ];
  const more = Math.max(0, removed.length - 3) + Math.max(0, added.length - 3);
  return `${surface}: ${parts.join(' ') || 'comment/whitespace only'}${more ? ` (+${more} more lines)` : ''}`;
}

const quantileSorted = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null);

/** Shared per-proposer telemetry (calls, tokens, cost, latency, failures, SIM context sizes). */
export function newTelemetry() {
  return {
    calls: 0, failures: 0, truncated: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    latenciesMs: [], simContextChars: [], withSimContext: 0,
  };
}
export function summarizeTelemetry(t) {
  const lat = [...t.latenciesMs].sort((x, y) => x - y);
  return {
    calls: t.calls, failures: t.failures, truncated: t.truncated,
    promptTokens: t.promptTokens, completionTokens: t.completionTokens, costUsd: Number(t.costUsd.toFixed(6)),
    p50LatencyMs: quantileSorted(lat, 0.5), p95LatencyMs: quantileSorted(lat, 0.95),
    meanSimContextChars: t.simContextChars.length ? Math.round(t.simContextChars.reduce((s, x) => s + x, 0) / t.simContextChars.length) : 0,
    withSimContext: t.withSimContext,
  };
}

/**
 * Live OpenRouter proposer with a shared SpendGuard. The key comes ONLY from the
 * injected `apiKey` (read from env by the caller); there is no file fallback.
 */
export class GuardedOpenRouterProposer {
  constructor({ model, pricing, guard, apiKey, fetchImpl = globalThis.fetch, maxTokens = 2500, temperature = 0.4, timeoutMs = 90_000, meta = {} }) {
    if (!apiKey) throw new Error('GuardedOpenRouterProposer: OPENROUTER_API_KEY missing from env');
    this.model = model; this.pricing = pricing; this.guard = guard; this.apiKey = apiKey;
    this.fetchImpl = fetchImpl; this.maxTokens = maxTokens; this.temperature = temperature;
    this.timeoutMs = timeoutMs; this.meta = meta;
    this.telemetry = newTelemetry();
  }

  async generateMutation(input) {
    const messages = buildMessages(input);
    if (input.simContext) { this.telemetry.withSimContext += 1; this.telemetry.simContextChars.push(input.simContext.length); }
    const promptChars = messages.reduce((s, m) => s + m.content.length, 0);
    const reservation = this.guard.reserve(
      worstCaseUsd({ promptChars, maxTokens: this.maxTokens, inPerM: this.pricing.inPerM, outPerM: this.pricing.outPerM }) * 1.25 + 0.0001,
      { model: this.model, ...this.meta },
    );
    const started = Date.now();
    let j;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', signal: ctl.signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model, messages, max_tokens: this.maxTokens, temperature: this.temperature,
            usage: { include: true },
          }),
        });
        j = await res.json();
      } finally { clearTimeout(timer); }
    } catch (e) {
      // The request may have reached the provider: charge the reservation.
      this.guard.settle(reservation, NaN, { outcome: 'error' });
      this.telemetry.failures += 1;
      this.telemetry.latenciesMs.push(Date.now() - started);
      return { code: input.parentCode, summary: `${input.surface}: proposer unreachable — no-op` };
    }
    const latency = Date.now() - started;
    const usage = j?.usage ?? {};
    const charged = this.guard.settle(reservation, Number(usage.cost), {
      outcome: j?.choices?.[0]?.message?.content ? 'ok' : 'empty',
      promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null, latencyMs: latency,
    });
    this.telemetry.calls += 1;
    this.telemetry.costUsd += charged;
    this.telemetry.latenciesMs.push(latency);
    this.telemetry.promptTokens += usage.prompt_tokens ?? 0;
    this.telemetry.completionTokens += usage.completion_tokens ?? 0;
    const content = j?.choices?.[0]?.message?.content;
    if (j?.choices?.[0]?.finish_reason === 'length') this.telemetry.truncated += 1;
    if (!content) {
      this.telemetry.failures += 1;
      return { code: input.parentCode, summary: `${input.surface}: proposer returned no content — no-op` };
    }
    const code = unfence(content);
    return { code, summary: diffSummary(input.surface, input.parentCode, code) };
  }
}

/**
 * $0 mock proposer for --dry runs and tests. Deterministic edits keyed by
 * (surface, nonce, call count); it ignores simContext except to count it.
 */
export class MockProposer {
  constructor() { this.telemetry = newTelemetry(); this.n = 0; }
  async generateMutation(input) {
    this.n += 1;
    this.telemetry.calls += 1;
    this.telemetry.latenciesMs.push(0);
    if (input.simContext) { this.telemetry.withSimContext += 1; this.telemetry.simContextChars.push(input.simContext.length); }
    let code = input.parentCode;
    const k = (this.n + (input.nonce ?? 0)) % 3;
    if (input.surface === 'contextBuilder') {
      code = code.replace(/slice\(0, (\d+)\)/, (_, w) => `slice(0, ${Number(w) + 10 * (k + 1)})`);
    } else if (input.surface === 'retryPolicy') {
      code = code.replace(/maxAttempts = (\d+)/, (_, w) => `maxAttempts = ${Number(w) + k}`);
    }
    return { code, summary: diffSummary(input.surface, input.parentCode, code) };
  }
}
