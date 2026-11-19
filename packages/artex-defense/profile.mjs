// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    samples: { type: 'string', default: '8' },
    large: { type: 'string', default: '2000' },
    cli: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' }
  }
});
if (values.help || positionals.length !== 2) {
  console.log('Usage: node profile.mjs [--samples 8] [--large 2000] [--cli] <baseline-package-dir> <candidate-package-dir>');
  process.exit(values.help ? 0 : 2);
}
const samples = Number(values.samples);
const large = Number(values.large);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 100 && samples % 2 === 0,
  '--samples must be an even integer from 2 through 100 for balanced ordering');
assert(Number.isInteger(large) && large > 100 && large <= 10000,
  '--large must be an integer from 101 through the 10000 event import limit');

async function loadPackage(dir) {
  let path = resolve(dir);
  if (!existsSync(resolve(path, 'ingest.mjs'))) path = resolve(path, 'packages/artex-defense');
  const modules = ['ingest.mjs', 'replay.mjs', 'simulation.mjs', 'metaharness.mjs'];
  const [ingest, replay, simulation, harness] = await Promise.all(
    modules.map(name => import(pathToFileURL(resolve(path, name)).href))
  );
  const evaluate = replay.evaluatePolicies ?? (bundle => ({
    baseline: replay.evaluateCase(bundle, 'simulate', 'baseline'),
    candidate: replay.evaluateCase(bundle, 'simulate', 'candidate')
  }));
  return {
    path,
    sourceSha256: Object.fromEntries([...modules, 'cli.mjs'].map(name => [
      name, createHash('sha256').update(readFileSync(resolve(path, name))).digest('hex')
    ])),
    pairApi: replay.evaluatePolicies ? 'evaluatePolicies' : 'evaluateCase twice',
    importEvidence: ingest.importEvidence,
    pair: bundle => evaluate(bundle, 'simulate'),
    simulate: simulation.simulateResponse,
    receipt: harness.createReplayReceipt,
    verify: harness.verifyReplayReceipt
  };
}

function makeFixture(format, rows) {
  const tenant = 'lab';
  const caseId = 'profile-' + format + '-' + rows;
  let text;
  if (format === 'json') {
    const timeline = [
      ['credential_change', 'identity'], ['marker', 'endpoint'], ['anomalous_use', 'edge'],
      ['benign', 'edge'], ['decoy_hit', 'canary'], ['finding', 'artex'], ['benign', 'endpoint']
    ];
    const events = Array.from({ length: rows }, (_, i) => {
      const [kind, source] = timeline[i % timeline.length];
      return { id: 'event-' + i, session: 'user-' + Math.floor(i / timeline.length) % 64,
        kind, source, at: 1760000000000 + i * 131 };
    });
    // Reversed arrival order exercises stable time normalization before policy replay.
    text = JSON.stringify({ version: 1, tenant, caseId, events: events.reverse() });
  } else {
    const lines = ['ID,Name,Class,Severity,Status,Report Stage,Task,Found At,Summary,Traffic Evidence Count,Traffic Evidence IDs'];
    const severities = ['high', 'medium', 'low', 'info'];
    for (let i = 1; i <= rows; i++) {
      const at = new Date(1760000000000 + i * 1000).toISOString().slice(0, 19).replace('T', ' ');
      lines.push(i + ',"Report, ' + i + '",observation,' + severities[i % 4] +
        ',reviewed,triage,' + (i % 30 + 1) + ',' + at + ',"Reviewed ""evidence""",2,"7,9"');
    }
    text = lines.join('\r\n') + '\r\n';
  }
  const bytes = Buffer.from(text);
  const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, scope: { tenant, caseId, format, expectedSha256 } };
}

function run(api, fixture) {
  const bundle = api.importEvidence(fixture.bytes, fixture.scope);
  const { baseline, candidate } = api.pair(bundle);
  const result = { baseline, candidate, simulation: api.simulate(candidate), findings: bundle.findings ?? [] };
  const receipt = api.receipt(bundle, result);
  return { bundle, result, receipt };
}

function median(data) {
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measurePair(operations, repetitions, check) {
  const paired = [];
  for (let round = -2; round < samples; round++) {
    const elapsed = [];
    for (const side of (round % 2 === 0 ? [0, 1] : [1, 0])) {
      let output;
      const operation = operations[side];
      const start = performance.now();
      for (let i = 0; i < repetitions; i++) output = operation();
      elapsed[side] = (performance.now() - start) / repetitions;
      check(output); // Check the last operation of each batch outside the timer.
    }
    if (round >= 0) paired.push(elapsed);
  }
  return {
    baselineMedianMs: median(paired.map(([baseline]) => baseline)),
    candidateMedianMs: median(paired.map(([, candidate]) => candidate)),
    medianPairedSpeedup: median(paired.map(([baseline, candidate]) => baseline / candidate)),
    samplesMsPerCase: paired
  };
}

// A new process for every replay and verification includes Node startup, file I/O and report fsync.
function profileCli(apis, fixture, pin) {
  const dir = mkdtempSync(resolve(tmpdir(), 'artex-profile-'));
  const manifest = resolve(dir, 'manifest.json');
  const input = resolve(dir, 'evidence');
  const reference = resolve(dir, 'reference.json');
  const invoke = (api, action, report, argument) => execFileSync(process.execPath,
    [...process.execArgv, resolve(api.path, 'cli.mjs'), action, manifest, input, report, argument],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    writeFileSync(manifest, JSON.stringify({ version: 1, ...fixture.scope }));
    writeFileSync(input, fixture.bytes);
    // Both verifiers read this baseline-produced artifact with the separately retained in-memory pin.
    assert.equal(JSON.parse(invoke(apis[0], 'replay', reference, 'simulate')).tailSha256, pin);
    const referenceBytes = readFileSync(reference);
    let sequence = 0;
    const replay = measurePair(apis.map(api => () => {
      const report = resolve(dir, 'report-' + sequence++ + '.json');
      return { report, stdout: invoke(api, 'replay', report, 'simulate') };
    }), 1, ({ report, stdout }) => {
      assert.equal(JSON.parse(stdout).tailSha256, pin);
      if (sequence <= 2) assert.deepStrictEqual(readFileSync(report), referenceBytes);
      unlinkSync(report);
    });
    const verify = measurePair(apis.map(api => () => invoke(api, 'verify', reference, pin)),
      1, stdout => assert.equal(JSON.parse(stdout).verified, true));
    return { format: fixture.scope.format, rows: large, reportBytes: referenceBytes.length,
      trustedTailSha256: pin, replay, verify };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const apis = await Promise.all(positionals.map(loadPackage));
const cases = [];
const cliCases = [];
const started = performance.now();
for (const format of ['json', 'csv']) {
  for (const rows of [1, 100, large]) {
    const fixture = makeFixture(format, rows);
    const inputs = apis.map(api => run(api, fixture));
    assert.deepStrictEqual(inputs[1], inputs[0], 'Output divergence for ' + format + '/' + rows);
    const { bundle, result, receipt } = inputs[0];
    assert.equal(bundle.events.length, rows);
    assert.equal(bundle.sourceSha256, fixture.scope.expectedSha256);
    assert.equal(result.simulation.restored, true);
    const pin = receipt.tailSha256;
    for (const [i, api] of apis.entries()) {
      assert.equal(api.verify(receipt, inputs[i].bundle, inputs[i].result, pin), true);
      const wrongPin = (pin[0] === '0' ? '1' : '0') + pin.slice(1);
      assert.equal(api.verify(receipt, inputs[i].bundle, inputs[i].result, wrongPin), false);
    }
    const repetitions = rows === 1 ? 64 : rows === 100 ? 8 : 1;
    const pairOps = apis.map((api, i) => () => api.pair(inputs[i].bundle));
    const verifyOps = apis.map((api, i) => () => api.verify(receipt, inputs[i].bundle, inputs[i].result, pin));
    cases.push({
      format, rows, inputBytes: fixture.bytes.length, repetitionsPerBatch: repetitions,
      sourceSha256: bundle.sourceSha256, baselinePolicySha256: result.baseline.receiptSha256,
      candidatePolicySha256: result.candidate.receiptSha256, metaHarnessTailSha256: pin,
      import: measurePair(apis.map(api => () => api.importEvidence(fixture.bytes, fixture.scope)), repetitions,
        actual => assert.deepStrictEqual(actual, bundle)),
      policyPair: measurePair(pairOps, repetitions, actual => {
        assert.equal(actual.baseline.receiptSha256, result.baseline.receiptSha256);
        assert.equal(actual.candidate.receiptSha256, result.candidate.receiptSha256);
      }),
      endToEnd: measurePair(apis.map(api => () => run(api, fixture)), repetitions,
        actual => assert.equal(actual.receipt.tailSha256, pin)),
      verifyReceipt: measurePair(verifyOps, repetitions, actual => assert.equal(actual, true))
    });
    if (values.cli && rows === large) cliCases.push(profileCli(apis, fixture, pin));
  }
}
console.log(JSON.stringify({
  schema: 'artex-defense.paired-profile.v1',
  scope: 'Single-process, synchronous synthetic replay on in-memory bytes in simulate mode. End to end includes import, both policies, simulation and MetaHarness receipt creation. Receipt verification times re-creation and chain verification on precomputed results. Excludes startup, transport and file I/O.',
  ...(values.cli && { cli: { scope: 'Fresh Node processes, local warm-cache files. Replay reads the manifest and evidence and publishes a new fsynced report. Verify reads the baseline report and independently replays the source against a retained pin. Includes process startup and file I/O.', cases: cliCases } }),
  methodology: 'Two warmup pairs per stage, alternating old-first/new-first order, then balanced measured pairs. Each sample is mean ms per case over a batch. Paired speedup is median of old/new per measured pair. Raw samples are [old, new] in measurement order.',
  runtime: { node: process.version, nodeFlags: process.execArgv, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  packages: apis.map(({ path, pairApi, sourceSha256 }) => ({ path, pairApi, sourceSha256 })),
  samplesPerStage: samples, elapsedMs: performance.now() - started, cases
}, null, 2));
