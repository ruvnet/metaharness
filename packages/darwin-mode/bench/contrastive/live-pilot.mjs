// Explicit opt-in provider smoke. Real editors, synthetic deterministic executor.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runContrastive } from '../../dist/contrastive/index.js';
import { createContrastiveEditors } from '../../dist/contrastive/editors.js';
import { rememberContrastiveExperience, retrieveContrastiveExperiences } from '../../dist/contrastive/memory.js';
import { BASELINE, makeTasks, grade } from './fixtures.mjs';
import { createSyntheticOptions } from './synthetic-adapter.mjs';

if (!process.argv.includes('--live')) throw new Error('Pass --live to authorize provider calls. Expected cost is below $0.01; client reservation cap is $0.25.');
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('OPENROUTER_API_KEY is required; no key file fallback is used.');
const model = process.env.CONTRASTIVE_EDITOR_MODEL || 'google/gemini-2.5-flash-lite';
const metadata = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20000) });
if (!metadata.ok) throw new Error(`model metadata HTTP ${metadata.status}`);
const selected = (await metadata.json()).data.find(m => m.id === model);
if (!selected) throw new Error('configured model absent from current provider catalogue');
const rates = { prompt: Number(selected.pricing.prompt), completion: Number(selected.pricing.completion) };
if (Object.values(rates).some(n => !Number.isFinite(n) || n < 0)) throw new Error('missing finite model pricing');
const telemetry = [];
let reserved = 0;
const maxTokens = 1200;
const complete = async request => {
  // Conservative input token bound: UTF-8 bytes plus fixed protocol overhead.
  // Provider billing remains external; metered response cost is recorded separately.
  const estimateCeiling = (Buffer.byteLength(request.system + request.prompt) + 2048) * rates.prompt + maxTokens * rates.completion;
  if (estimateCeiling > request.ceilingUsd || reserved + request.ceilingUsd > 0.25) throw new Error('provider call not admitted');
  reserved += request.ceilingUsd;
  const started = performance.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: request.signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens,
      response_format: { type: 'json_object' }, provider: { allow_fallbacks: false },
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }] }),
  });
  if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || !body.choices?.[0]?.message?.content) throw new Error('provider returned no editor content');
  const usage = body.usage;
  if (!usage || !Number.isInteger(usage.prompt_tokens) || !Number.isInteger(usage.completion_tokens)) throw new Error('provider usage missing');
  const costUsd = usage.cost == null ? usage.prompt_tokens * rates.prompt + usage.completion_tokens * rates.completion : Number(usage.cost);
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('provider usage invalid');
  telemetry.push({ role: request.role, responseId: body.id, model: body.model,
    promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
    costUsd, costSource: usage.cost == null ? 'catalogue-estimate' : 'provider-usage',
    reservedUsd: request.ceilingUsd, latencyMs: performance.now() - started });
  return { text: body.choices[0].message.content, costUsd };
};
const development = makeTasks(261014224, 8, 'development');
const holdout = makeTasks(162610, 100, 'holdout');
assert.equal(new Set([...development, ...holdout].map(t => t.id)).size, 108);
const { options, count } = createSyntheticOptions(development);
Object.assign(options, createContrastiveEditors(complete));
options.task.description += ' Allowed configuration: split.content={quoted:boolean}; amount.content={decimalComma:boolean}. Preserve these shapes.';
options.envelope = { network: 'editor-only-openrouter', shell: false, promotion: false };
options.budget = { maxUsd: 0.15, maxCalls: 7, timeoutMs: 45000, probeUsd: 0, proposeUsd: 0.05, composeUsd: 0.05 };
const started = performance.now();
const result = await runContrastive(options);
const liveLatencyMs = performance.now() - started;
let retainedEntries = 0, retrievedEntries = 0;
if (result.outcome === 'candidate') {
  const context = { tenantId: options.tenantId, projectId: options.projectId, environmentKey: `invoice-v1/${model}` };
  const retained = rememberContrastiveExperience(options.library, { ...context,
    sourceTaskId: 'development-batch-261014224', cue: 'quoted invoices and decimal comma amounts',
    lesson: 'Apply the candidate only after fresh development probes; this is synthetic parser evidence.', result });
  retainedEntries = retained.entries.length;
  retrievedEntries = retrieveContrastiveExperiences(retained, { ...context, query: 'invoice decimal comma' }).entries.length;
}
const base = new URL('../../', import.meta.url);
const manifests = [];
for (const folder of ['src/contrastive/', 'dist/contrastive/', 'bench/contrastive/']) {
  for (const name of (await readdir(new URL(folder, base))).filter(n => /\.(ts|mjs|js)$/.test(n)).sort()) {
    const path = folder + name;
    manifests.push({ path, sha256: createHash('sha256').update(await readFile(new URL(path, base))).digest('hex') });
  }
}
const receipt = {
  schema: 'contrastive-live-editor-smoke.v1', timestamp: new Date().toISOString(),
  evidenceClass: 'live-provider-editors-with-synthetic-deterministic-executor',
  claimEligible: false, reason: 'This validates provider integration, not general LLM task performance or superiority.',
  model, pricingSnapshot: rates, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(base), encoding: 'utf8' }).trim(),
  sourceDigest: createHash('sha256').update(JSON.stringify(manifests)).digest('hex'), manifests,
  developmentTasks: development.length, heldoutTasks: holdout.length,
  baseline: grade(BASELINE, holdout), candidate: grade(result.candidate, holdout),
  result, parserCounts: count, retainedEntries, retrievedEntries, telemetry, liveLatencyMs,
  totalProviderCostUsd: telemetry.reduce((sum, t) => sum + t.costUsd, 0), reservedProviderUsd: reserved,
};
const output = process.argv.find(a => a.startsWith('--out='))?.slice(6);
if (output) await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ outcome: result.outcome, reason: result.reason, baseline: receipt.baseline.passed,
  candidate: receipt.candidate.passed, heldoutTasks: holdout.length, editorCalls: telemetry.length,
  costUsd: receipt.totalProviderCostUsd, retainedEntries, retrievedEntries, sourceDigest: receipt.sourceDigest, claimEligible: false }));
if (!telemetry.length || result.reason === 'failure' || result.reason === 'invalid' || result.reason === 'timeout') process.exitCode = 1;
