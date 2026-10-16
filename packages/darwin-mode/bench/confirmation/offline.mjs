import assert from 'node:assert/strict';
import { BASELINE, SOURCE, hash, loadFrozen, makeFrozen, normalizeUtterance } from './dataset.mjs';
import { readFile } from 'node:fs/promises';
import { createProvider, MODEL, PROVIDER_TAG, LIMITS } from './provider.mjs';
import { parseIntent, validatePromptDocument } from './adapters.mjs';
import { runExperiment, frozenPlan } from './run.mjs';

globalThis.fetch = async () => { throw new Error('network forbidden in offline validation'); };
const frozen = await loadFrozen();
assert.equal(frozen.development.length, 24);
assert.equal(frozen.confirmation.length, 40);
assert.equal(normalizeUtterance(' A  B '), 'a b');
assert.equal(parseIntent('{"intent":"balance"}'), 'balance');
for (const invalid of ['{}', '{"intent":"unknown"}', '{"intent":"balance","why":"x"}', 'not-json', 'null']) assert.equal(parseIntent(invalid), null);
validatePromptDocument(BASELINE);
assert.throws(() => validatePromptDocument({ components: [{ id: 'procedure', scope: 'domain', content: 'x' }] }));
assert.throws(() => validatePromptDocument({ components: [...BASELINE.components, { id: 'extra', scope: 'domain', content: 'x' }] }));
try {
  const raw = await readFile('/tmp/clinc150-pinned.json');
  assert.equal(hash(raw), SOURCE.sha256);
  assert.deepEqual(makeFrozen(raw), frozen);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const telemetry = [];
const fake = {
  telemetry, summary: () => ({ providerCalls: telemetry.length, reservedUsd: 0, knownReportedCostUsd: 0, offline: true }),
  async complete(request) {
    assert.equal(/"(gold|expected)"\s*:/.test(request.prompt), false);
    if (request.stage.startsWith('development')) for (const row of frozen.confirmation) assert.equal(request.prompt.includes(row.id), false);
    telemetry.push({ stage: request.stage, role: request.role, costUsd: 0, latencyMs: 0, offline: true });
    const text = request.role === 'task' ? '{"intent":"balance"}' :
      request.role === 'control-editor' ? JSON.stringify({ procedure: BASELINE.components[0].content, domain: BASELINE.components[1].content }) :
      '{"edits":[]}';
    return { text, costUsd: 0 };
  },
};
const result = await runExperiment(fake, frozen, '/tmp/metaharness-confirmation-offline-' + Date.now());
assert.equal(result.mode, 'offline');
assert.equal(result.completed, true);
assert.equal(result.accounting.providerCalls, 165);
assert.equal(result.confirmations.contrastiveVsBaseline.verdict, 'rejected');
assert.equal(result.confirmations.contrastiveVsControl.verdict, 'rejected');
assert.equal(result.superiorityConfirmed, false);
assert.equal(result.accuracy.baseline.passed, 5);
assert.equal(result.accuracy.contrastive.passed, 5);
assert.equal(result.accuracy.control.passed, 5);
assert.equal(result.classifications.filter(x => x.stage.startsWith('confirmation')).length, 40);
assert.equal(frozenPlan(frozen).maximumReservedUsdFromPlan <= LIMITS.overallUsd, true);

// Exercise the real client against an in-memory fetch mock, including the
// concurrency semaphore and conservative budget denial. No network or real key.
const oldKey = process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_API_KEY = 'offline-test-not-a-credential';
let active = 0, maximumActive = 0, posted = 0;
globalThis.fetch = async (url, options) => {
  if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: MODEL, pricing: { prompt: '.0000001', completion: '.0000004' } }] }));
  if (url.endsWith('/endpoints')) return new Response(JSON.stringify({ data: { endpoints: [{ tag: PROVIDER_TAG, provider_name: 'Google', status: 0, pricing: { prompt: '.0000001', completion: '.0000004' } }] } }));
  assert.ok(url.endsWith('/chat/completions'));
  active++; posted++; maximumActive = Math.max(maximumActive, active);
  const body = JSON.parse(options.body);
  assert.equal(body.model, MODEL);
  assert.equal(body.max_tokens, 96);
  assert.equal(body.provider.allow_fallbacks, false);
  assert.deepEqual(body.provider.only, [PROVIDER_TAG]);
  assert.deepEqual(body.provider.order, [PROVIDER_TAG]);
  await new Promise(resolve => setTimeout(resolve, 2));
  active--;
  return new Response(JSON.stringify({ id: 'offline-' + posted, model: MODEL, provider: 'Google',
    choices: [{ message: { content: '{"intent":"balance"}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: .000003 } }));
};
try {
  const client = await createProvider();
  const request = { role: 'task', stage: 'development:control', system: 'Classify.', prompt: '{"utterance":"x"}',
    ceilingUsd: .002, signal: new AbortController().signal };
  await Promise.all(Array.from({ length: 16 }, () => client.complete(request)));
  assert.equal(posted, 16);
  assert.equal(maximumActive, 4);
  assert.equal(client.summary().providerCalls, 16);
  assert.equal(client.summary().reservedUsd, .032);
  assert.equal(client.summary().knownReportedCostUsd, .000048);
  await assert.rejects(client.complete({ ...request, ceilingUsd: .000000001 }), /reservation denied/);
  assert.equal(posted, 16);
} finally {
  if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
  globalThis.fetch = async () => { throw new Error('network forbidden in offline validation'); };
}
console.log(JSON.stringify({ status: 'passed', evidenceKind: 'offline-contract-validation',
  frozenSha256: frozen.frozenSha256, development: 24, confirmation: 40, disjointNormalizedUtterances: true,
  fakeExperimentCalls: telemetry.length, providerMockCalls: posted, maxConcurrentMockCalls: maximumActive,
  realProviderCalls: 0, realSpendUsd: 0 }, null, 2));
