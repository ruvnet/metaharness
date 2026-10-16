import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { runContrastive, digestDocument } from '../../dist/contrastive/index.js';
import { BASELINE, clone, digest, grade, makeTasks, random } from './fixtures.mjs';
import { createSyntheticOptions } from './synthetic-adapter.mjs';
import { provenance, stats } from './provenance.mjs';

function score(candidate, tasks) {
  const { passed, total } = grade(candidate, tasks);
  return { passed, total, successRate: passed / total };
}
/** Three independent draws from the same four configurations; dev-only selection. */
function repeatedSampling(development, seed) {
  const next = random(seed);
  let candidate = clone(BASELINE), best = grade(candidate, development).score;
  const sampled = [digestDocument(candidate)];
  for (let i = 0; i < 3; i++) {
    const proposed = clone(BASELINE);
    const mask = Math.floor(next() * 4);
    proposed.components[0].content.quoted = !!(mask & 1);
    proposed.components[1].content.decimalComma = !!(mask & 2);
    sampled.push(digestDocument(proposed));
    const quality = grade(proposed, development).score;
    if (quality > best) { best = quality; candidate = proposed; }
  }
  return { seed, candidate, sampled, calls: 7, editors: 3, probes: 4,
    executedRows: 4 * development.length, selectedDevelopmentScore: best };
}

function assertAccounting(result, count) {
  assert.equal(result.calls, count.probe + count.propose + count.compose);
  assert.equal(result.reportedUsd, 0);
  assert.equal(result.reservedUsd, 0);
  assert.equal(result.candidateDigest, digestDocument(result.candidate));
}

export async function runBenchmark({ seed = 261014224, iterations = 100 } = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 1000);
  const development = makeTasks(seed, 8, 'development');
  // Holdout rows never enter the options or callback closures.
  const holdout = makeTasks((seed ^ 0x9e3779b9) >>> 0, 100, 'heldout');
  assert.equal(new Set([...development, ...holdout].map(x => x.input)).size, 108);
  let executedInputReads = 0;
  const observedDevelopment = development.map(task => ({ ...task,
    get input() { executedInputReads++; return task.input; } }));
  const adapter = createSyntheticOptions(observedDevelopment);
  executedInputReads = 0; // Exclude copying input strings into the task description.
  const result = await runContrastive(adapter.options);
  assert.equal(executedInputReads, 32);
  assertAccounting(result, adapter.count);
  assert.deepEqual(adapter.count, { probe: 4, propose: 2, compose: 1, executedRows: 32 });
  assert.equal(result.calls, 7);
  assert.equal(result.selectedScore, grade(result.candidate, development).score);

  const seedStream = random((seed ^ 0xa5a5a5a5) >>> 0);
  const controlSeeds = Array.from({ length: 32 }, () => Math.floor(seedStream() * 0x100000000));
  const beforeControl = executedInputReads;
  const control = repeatedSampling(observedDevelopment, controlSeeds[0]);
  assert.equal(executedInputReads - beforeControl, 32);
  const controls = controlSeeds.map(s => {
    const run = repeatedSampling(development, s);
    return { seed: s, ...score(run.candidate, holdout) };
  });
  const noOp = createSyntheticOptions(development, { noop: true });
  const reused = await runContrastive(noOp.options);
  assertAccounting(reused, noOp.count);
  assert.equal(noOp.count.probe, 1);
  assert.equal(reused.deduplicated, 2);
  const bounded = createSyntheticOptions(development, { maxCalls: 6 });
  const stopped = await runContrastive(bounded.options);
  assertAccounting(stopped, bounded.count);
  assert.equal(stopped.calls, 6);
  assert.equal(bounded.count.probe, 3);

  // Warmup does not contribute to latency summaries.
  for (let i = 0; i < 5; i++) await runContrastive(createSyntheticOptions(development).options);
  const loopTimes = [], baselineTimes = [], controlTimes = [];
  for (let i = 0; i < iterations; i++) {
    let start = performance.now();
    grade(BASELINE, development);
    baselineTimes.push(performance.now() - start);
    start = performance.now();
    repeatedSampling(development, controlSeeds[0]);
    controlTimes.push(performance.now() - start);
    start = performance.now();
    const measured = await runContrastive(createSyntheticOptions(development).options);
    loopTimes.push(performance.now() - start);
    assert.equal(measured.candidateDigest, result.candidateDigest);
  }
  return {
    schemaVersion: 1, evidenceKind: 'synthetic-mechanism-benchmark',
    claim: 'Offline parser mechanics only; not real LLM quality, current Darwin performance, or transfer evidence.',
    realModelSpendUsd: 0, seed, provenance: provenance(),
    dataset: { development: development.length, heldout: holdout.length,
      developmentSha256: digest(development), heldoutSha256: digest(holdout),
      noInputOverlap: true, policy: 'Development selects candidates; heldout is scored only after selection.',
      holdoutFeatures: {
        quoted: holdout.filter(x => x.features.quoted).length,
        decimalComma: holdout.filter(x => x.features.comma).length,
      } },
    results: {
      frozenHarness: { ...score(BASELINE, holdout), probes: 1, editors: 0,
        executedDevelopmentRows: development.length, candidateDigest: digestDocument(BASELINE) },
      equalBudgetSampling: { ...score(control.candidate, holdout),
        candidateDigest: digestDocument(control.candidate), ...control, candidate: undefined },
      contrastive: { ...score(result.candidate, holdout), candidateDigest: result.candidateDigest,
        calls: result.calls, ...adapter.count, outcome: result.outcome,
        selectedDevelopmentScore: result.selectedScore },
      samplingSeedSensitivity: controls,
    },
    budgetChecks: {
      limit7: { admitted: result.calls, probes: adapter.count.probe, editors: 3,
        verifiedParserInputReads: beforeControl },
      limit6: { admitted: stopped.calls, probes: bounded.count.probe,
        outcome: stopped.outcome, reason: stopped.reason },
      unchangedEdits: { admitted: reused.calls, probes: noOp.count.probe,
        callsAvoided: reused.deduplicated, reason: reused.reason },
    },
    latency: { unit: 'milliseconds', includes: 'Adapter execution, validation, hashing, receipts and scheduling; excludes build.',
      frozenHarness: stats(baselineTimes), equalBudgetSampling: stats(controlTimes),
      contrastive: stats(loopTimes) },
    receipts: result.receipts,
    limitations: [
      'Handwritten proposers know two parser operations. They do not learn general-purpose skills.',
      'Equal budget means 7 logical operations: 4 eight-row evaluations plus 3 candidate generations; all synthetic operations cost zero dollars, not equal real tokens or spend.',
      'The repeated-sampling control may tie or beat the loop; no improvement threshold is asserted.',
      'Same-process answer separation is a benchmark discipline, not isolation from malicious adapters.',
      'Holdout generation uses the same two-feature distribution as development; external transfer is unmeasured.',
      'No production promotion, network, shell command, provider call or secret access is performed by adapters.',
    ],
  };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const seed = process.argv[2] === undefined ? 261014224 : Number(process.argv[2]);
  const iterations = process.argv[3] === undefined ? 100 : Number(process.argv[3]);
  console.log(JSON.stringify(await runBenchmark({ seed, iterations }), null, 2));
}
