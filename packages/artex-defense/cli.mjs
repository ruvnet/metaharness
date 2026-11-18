#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { constants, realpathSync } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importEvidence, MAX_INPUT_BYTES, parseEvidenceJSON } from './ingest.mjs';
import { evaluatePolicies } from './replay.mjs';
import { simulateResponse } from './simulation.mjs';
import { createReplayReceipt, verifyReplayReport } from './metaharness.mjs';

const help = [
  'MetaHarness defensive evidence replay',
  '  replay MANIFEST INPUT NEW_REPORT [monitor|simulate]',
  '  verify MANIFEST INPUT REPORT TRUSTED_TAIL_SHA256',
  '  benchmark',
  '  help',
].join('\n');

async function readBounded(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('File type or size rejected');
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const {bytesRead} = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== info.size) throw new Error('File size changed while reading');
    return bytes.subarray(0, used);
  } finally {
    await file.close();
  }
}

function parseJSON(bytes) {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

async function loadBundle(manifestPath, inputPath) {
  const manifest = parseEvidenceJSON(new TextDecoder('utf-8', {fatal: true}).decode(await readBounded(manifestPath, 4096)));
  if (!manifest || !isDeepStrictEqual(Object.keys(manifest).sort(),
      ['caseId','expectedSha256','format','tenant','version']) || manifest.version !== 1 ||
      !['json', 'csv'].includes(manifest.format) || typeof manifest.expectedSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(manifest.expectedSha256)) throw new Error('Invalid import manifest');
  return importEvidence(await readBounded(inputPath, MAX_INPUT_BYTES), manifest);
}

// Publish only complete files. Concurrent callers cannot replace an existing report.
async function writeNewReport(path, report) {
  const tmp = join(dirname(path), '.replay-' + randomUUID() + '.tmp');
  const file = await open(tmp, 'wx', 0o600);
  try {
    const json = JSON.stringify(report) + '\n';
    if (Buffer.byteLength(json) > 16 * 1024 * 1024) throw new Error('Report size limit exceeded');
    await file.writeFile(json);
    await file.sync();
    await file.close();
    await link(tmp, path);
  } finally { await file.close(); await unlink(tmp); }
}

function replayResult(bundle, mode) {
  const {baseline, candidate} = evaluatePolicies(bundle, mode);
  const simulation = simulateResponse(candidate);
  return {baseline, candidate, simulation, findings: bundle.findings ?? []};
}

async function run(action, args) {
  if (action === 'help' || action === '--help' || !action) return {code: 0, lines: [help], errors: []};
  if (action === 'benchmark' && args.length === 0) {
    const {runBenchmark} = await import('./bench.mjs');
    const metrics = await runBenchmark();
    return {code: metrics.accepted ? 0 : 1, lines: [JSON.stringify(metrics)], errors: []};
  }
  const [manifest, input, output, value] = args;
  if (action === 'replay' && [3, 4].includes(args.length)) {
    const bundle = await loadBundle(manifest, input);
    const result = replayResult(bundle, value ?? 'monitor');
    const report = {version: 1, result, receipt: createReplayReceipt(bundle, result)};
    await writeNewReport(output, report);
    return {code: 0, errors: [], lines: [JSON.stringify({tailSha256: report.receipt.tailSha256,
      mode: report.result.candidate.mode, baseline: report.result.baseline.summary,
      candidate: report.result.candidate.summary})]};
  }
  if (action === 'verify' && args.length === 4) {
    const bundle = await loadBundle(manifest, input);
    const raw = await readBounded(output, 16 * 1024 * 1024);
    const submitted = parseJSON(raw);
    const result = replayResult(bundle, submitted?.result?.candidate?.mode);
    const verified = verifyReplayReport(raw, bundle, result, value);
    return {code: verified ? 0 : 1, lines: [JSON.stringify({verified})], errors: []};
  }
  throw new Error('Invalid command arguments');
}

/**
 * Run one subcommand and collect its output. Returns {code, lines, errors}:
 * lines belong on stdout, errors on stderr. Never calls process.exit, so a host
 * CLI such as `redblue defense` can forward to it.
 */
export async function dispatch(action, args = []) {
  try {
    return await run(action, args);
  } catch (error) {
    // Imported data or caller paths may contain credentials. Never echo parser exceptions.
    const message = error?.code === 'EEXIST' ? 'Output already exists. Choose a new report path.' :
      error?.code === 'ENOENT' ? 'A required file or directory is missing.' :
      'Replay failed. Check input schema, digest, arguments, size limits and file access.';
    return {code: 1, lines: [], errors: [message]};
  }
}

// npm installs bins as symlinks, so compare real paths rather than raw URLs.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const result = await dispatch(process.argv[2], process.argv.slice(3));
  for (const line of result.lines) console.log(line);
  for (const line of result.errors) console.error(line);
  process.exitCode = result.code;
}
