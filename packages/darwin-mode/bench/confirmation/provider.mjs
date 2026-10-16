import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export const PROVIDER_TAG = 'google-vertex/eu';
export const MODEL = 'google/gemini-2.5-flash-lite';
export const LIMITS = Object.freeze({
  overallUsd: 1, maxProviderCalls: 318, concurrency: 4,
  taskUsd: .002, editorUsd: .02, taskOutputTokens: 96, editorOutputTokens: 1200,
  armDevelopmentUsd: .252, confirmationUsd: .24,
});
const nanos = value => Math.ceil(value * 1e9);
export async function createProvider() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY required; no automatic secret-file fallback');
  const metadata = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
  if (!metadata.ok) throw new Error('provider catalogue unavailable');
  const selected = (await metadata.json()).data.find(x => x.id === MODEL);
  if (!selected) throw new Error('pinned model unavailable');
  const rates = { prompt: Number(selected.pricing.prompt), completion: Number(selected.pricing.completion) };
  assert.equal(rates.prompt, .0000001, 'input pricing changed: do not spend without replanning');
  assert.equal(rates.completion, .0000004, 'output pricing changed: do not spend without replanning');
  const endpointResponse = await fetch('https://openrouter.ai/api/v1/models/' + MODEL + '/endpoints', { signal: AbortSignal.timeout(20000) });
  if (!endpointResponse.ok) throw new Error('provider endpoint catalogue unavailable');
  const endpoint = (await endpointResponse.json()).data.endpoints.find(x => x.tag === PROVIDER_TAG);
  if (!endpoint || endpoint.status !== 0 || endpoint.provider_name !== 'Google' || Number(endpoint.pricing.prompt) !== rates.prompt || Number(endpoint.pricing.completion) !== rates.completion) throw new Error('pinned endpoint unavailable or changed');
  const telemetry = [];
  let reservedNanos = 0, totalCostNanos = 0, active = 0, halted = false;
  const stageNanos = new Map(), waiters = [];
  const globalAbort = new AbortController();
  const runDeadline = AbortSignal.timeout(1200000);
  async function acquire() {
    if (active < LIMITS.concurrency) { active++; return; }
    await new Promise(resolve => waiters.push(resolve));
  }
  function release() {
    const waiter = waiters.shift();
    if (waiter) waiter(); else active--;
  }
  async function complete(request) {
    await acquire();
    try {
      if (halted) throw new Error('provider halted after an uncertain or invalid attempt');
      const task = request.role === 'task';
      const maxTokens = task ? LIMITS.taskOutputTokens : LIMITS.editorOutputTokens;
      const ceiling = nanos(request.ceilingUsd);
      const cap = nanos(task ? LIMITS.taskUsd : LIMITS.editorUsd);
      const stageCap = nanos(request.stage.startsWith('confirmation') ? LIMITS.confirmationUsd : LIMITS.armDevelopmentUsd);
      const stageKey = request.stage.startsWith('confirmation') ? 'confirmation' : request.stage;
      const estimatedNanos = nanos((Buffer.byteLength(request.system + request.prompt) + 4096) * rates.prompt + maxTokens * rates.completion);
      if (!Number.isSafeInteger(ceiling) || ceiling < estimatedNanos || ceiling > cap ||
          reservedNanos + ceiling > nanos(LIMITS.overallUsd) ||
          (stageNanos.get(stageKey) || 0) + ceiling > stageCap ||
          telemetry.length >= LIMITS.maxProviderCalls) throw new Error('provider reservation denied');
      reservedNanos += ceiling;
      stageNanos.set(stageKey, (stageNanos.get(stageKey) || 0) + ceiling);
      const entry = { sequence: telemetry.length + 1, stage: request.stage, role: request.role,
        taskId: request.taskId || null, reservedUsd: ceiling / 1e9, status: 'pending' };
      telemetry.push(entry);
      const start = performance.now();
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.any([request.signal, globalAbort.signal, runDeadline, AbortSignal.timeout(90000)]),
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: maxTokens,
            response_format: { type: 'json_object' }, provider: { order: [PROVIDER_TAG], only: [PROVIDER_TAG], allow_fallbacks: false, require_parameters: true, max_price: { prompt: .1, completion: .4 } },
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }] }),
        });
        if (!response.ok) throw new Error('provider HTTP ' + response.status);
        const body = await response.json(), usage = body.usage;
        if (body.model !== MODEL || body.provider !== 'Google') throw new Error('provider or model drift');
        if (body.error || typeof body.choices?.[0]?.message?.content !== 'string' ||
            !Number.isInteger(usage?.prompt_tokens) || !Number.isInteger(usage?.completion_tokens)) throw new Error('provider response or usage invalid');
        const cost = usage.cost == null ? usage.prompt_tokens * rates.prompt + usage.completion_tokens * rates.completion : Number(usage.cost);
        if (!Number.isFinite(cost) || cost < 0) throw new Error('provider cost invalid');
        const charged = nanos(cost);
        totalCostNanos += charged;
        Object.assign(entry, { status: 'complete', responseId: body.id, model: body.model, provider: body.provider, requestedEndpoint: PROVIDER_TAG,
          promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
          costUsd: charged / 1e9, costSource: usage.cost == null ? 'catalogue-estimate' : 'provider-usage',
          latencyMs: performance.now() - start });
        if (charged > ceiling) throw new Error('provider exceeded reserved ceiling');
        return { text: body.choices[0].message.content, costUsd: charged / 1e9 };
      } catch (error) {
        Object.assign(entry, { status: 'failed', latencyMs: performance.now() - start,
          error: error instanceof Error ? error.message : 'provider attempt failed' });
        halted = true;
        globalAbort.abort();
        throw error;
      }
    } finally { release(); }
  }
  return { complete, telemetry, rates, summary: () => ({
    reservedUsd: reservedNanos / 1e9, knownReportedCostUsd: totalCostNanos / 1e9,
    unresolvedAttempts: telemetry.filter(x => x.costUsd === undefined).length,
    reservationsByStage: Object.fromEntries([...stageNanos].map(([k, v]) => [k, v / 1e9])),
    providerCalls: telemetry.length, requestedEndpoint: PROVIDER_TAG, observedProviders: [...new Set(telemetry.filter(x => x.provider).map(x => x.provider))], halted,
  }) };
}
