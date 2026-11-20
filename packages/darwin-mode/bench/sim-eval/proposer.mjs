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

/**
 * Amendment 1: a FIXED description of what the evaluation loop checks, given to
 * every arm (off included). It states the mechanism, not a remedy: no tie-break
 * hint, no held-out ranges. Its sha256 is pre-registered in AMENDMENT-1.md.
 */
export const EVAL_BRIEF =
  'How variants are scored: a deterministic agent loop imports planner.ts, context_builder.ts, retry_policy.ts and ' +
  'tool_policy.ts and runs each task. A task is solved only if (1) createPlan(task) returns a plan containing a ' +
  '"verify" step, (2) buildContext(task, files) returns the task\'s buggy file among its items, and (3) the loop ' +
  'is still running on the attempt where the task stops failing: some tasks fail a fixed number of attempts first, ' +
  'each failure carries a classification (transient, repairable or unknown), and the loop continues only while ' +
  'decideRetry(attempt, classification).retry is true and attempt + 1 < maxAttempts. Score is mostly the fraction of ' +
  'tasks solved. Edits that preserve behaviour cannot change the score; behaviour changes inside this one file are ' +
  'allowed if they keep the exported names and signatures.';

/**
 * System prompts. 'stock' is verbatim OpenRouterMutator. 'behaviour' (study v2)
 * changes only the two clauses that forbid behaviour change; the safety rules
 * (no capabilities, imports, network, fs, shell, env, deps) are identical.
 */
export const SYSTEM_LINES = Object.freeze({
  stock: (surface) =>
    'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — no prose, no fences. ' +
    'HARD RULES: keep every exported name and signature identical; introduce NO new capabilities, imports, network, ' +
    'filesystem, shell, or env access; no new dependencies; pure refactor/tuning only (it must pass a static safety ' +
    'validator that rejects added capabilities). Make a small, plausibly score-improving change to the "' +
    surface + '" surface.',
  behaviour: (surface) =>
    'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — no prose, no fences. ' +
    'HARD RULES: keep every exported name and signature identical; introduce NO new capabilities, imports, network, ' +
    'filesystem, shell, or env access; no new dependencies; behaviour changes inside this file are allowed (it must ' +
    'pass a static safety validator that rejects added capabilities). Make the change to the "' +
    surface + '" surface that is most likely to raise the score.',
});

/**
 * Amendment 2: describe the FAILED TRAIN tasks named in Darwin's failure lines,
 * from the optimizer-visible train partition only. Ids not in `trainTasks`
 * (anything else) are ignored, so held-out tasks can never be described.
 */
export function failedTaskDetails(failedTraces, trainTasks) {
  if (!trainTasks?.length) return [];
  const byId = new Map(trainTasks.map((t) => [t.id, t]));
  const out = [];
  for (const line of failedTraces.slice(0, 5)) {
    const t = byId.get(/^task (\S+):/.exec(line)?.[1]);
    if (!t) continue;
    out.push(`${t.id}: task ${t.prompt}, ${t.files.length} candidate files, buggy file ${t.buggyFile} at input position ` +
      `${t.files.indexOf(t.buggyFile)}, fails ${t.failAttempts} attempt(s) before it can pass, classification ${t.classification}`);
  }
  return out;
}

/** Same rules text as OpenRouterMutator, plus the fixed EVAL_BRIEF (amendment 1) and failed-train-task details (amendment 2). */
export function buildMessages(input, { brief = EVAL_BRIEF, trainTasks = null, system = 'stock' } = {}) {
  const details = failedTaskDetails(input.failedTraces, trainTasks);
  const sys = SYSTEM_LINES[system](input.surface);
  const user =
    (brief ? `${brief}\n\n` : '') +
    `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
    (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
    (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
    (details.length ? `Failed train task details:\n${details.join('\n')}\n` : '') +
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

/** Count SIM context use, and whether it holds a record for the surface being edited (amendment 1). */
function noteSim(t, input) {
  if (!input.simContext) return;
  t.withSimContext += 1;
  t.simContextChars.push(input.simContext.length);
  if (input.simContext.includes(`"edit":"${input.surface}"`)) t.simSurfaceMatch += 1;
}

const quantileSorted = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null);

/** Shared per-proposer telemetry (calls, tokens, cost, latency, failures, SIM context sizes). */
export function newTelemetry() {
  return {
    calls: 0, failures: 0, truncated: 0, promptTokens: 0, completionTokens: 0, costUsd: 0,
    latenciesMs: [], simContextChars: [], withSimContext: 0, simSurfaceMatch: 0,
  };
}
export function summarizeTelemetry(t) {
  const lat = [...t.latenciesMs].sort((x, y) => x - y);
  return {
    calls: t.calls, failures: t.failures, truncated: t.truncated,
    promptTokens: t.promptTokens, completionTokens: t.completionTokens, costUsd: Number(t.costUsd.toFixed(6)),
    p50LatencyMs: quantileSorted(lat, 0.5), p95LatencyMs: quantileSorted(lat, 0.95),
    meanSimContextChars: t.simContextChars.length ? Math.round(t.simContextChars.reduce((s, x) => s + x, 0) / t.simContextChars.length) : 0,
    withSimContext: t.withSimContext, simSurfaceMatch: t.simSurfaceMatch,
  };
}

/**
 * Live OpenRouter proposer with a shared SpendGuard. The key comes ONLY from the
 * injected `apiKey` (read from env by the caller); there is no file fallback.
 */
export class GuardedOpenRouterProposer {
  constructor({ model, pricing, guard, apiKey, trainTasks = null, system = 'stock', fetchImpl = globalThis.fetch, maxTokens = 2500, temperature = 0.4, timeoutMs = 90_000, meta = {} }) {
    if (!apiKey) throw new Error('GuardedOpenRouterProposer: OPENROUTER_API_KEY missing from env');
    this.system = system; this.trainTasks = trainTasks; this.model = model; this.pricing = pricing; this.guard = guard; this.apiKey = apiKey;
    this.fetchImpl = fetchImpl; this.maxTokens = maxTokens; this.temperature = temperature;
    this.timeoutMs = timeoutMs; this.meta = meta;
    this.telemetry = newTelemetry();
  }

  async generateMutation(input) {
    const messages = buildMessages(input, { trainTasks: this.trainTasks, system: this.system });
    noteSim(this.telemetry, input);
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
      outcome: j?.choices?.[0]?.message?.content ? 'ok' : 'empty', error: j?.error ? String(j.error.message ?? j.error.code ?? 'error').slice(0, 160) : undefined,
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
    noteSim(this.telemetry, input);
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
