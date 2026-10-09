#!/usr/bin/env node
// ShellEvaluator-compatible fitness CLI (packages/darwin-mode/src/numeric-evaluator.ts protocol):
//   stdin  {"variantId": "...", "genome": {"<family>.difficulty": 2, "<family>.budget": 8192, ...}}
//   stdout one NumericScoreCard JSON object {variantId, primary, regressed, noopRate, costPerWin, raw}
//   stderr logs only.  Exit 0 whenever a card was printed (check regressed / raw.evaluatorError),
//   2 on bad flags or stdin (a fail-closed card is still printed).
// Each genome is split into one cell per family. Cached cells (content-addressed by cell + provenance, see
// lib/provenance.mjs) are reused; missing cells run calibrate.py (4 attempts per call, seeds seedBase+4k..+3) in
// parallel up to --concurrency, refused outright when more than --max-new-cells would be measured. Runner calls are
// process groups killed on timeout, on SIGTERM/SIGINT, and at --deadline-ms (set by run-darwin.mjs under its own
// ShellEvaluator timeout, which SIGKILLs this process and could not clean up). A driver SIGKILL still orphans runners.
//   node --experimental-strip-types evaluator.mjs --cache-dir DIR --dry-run < genome.json
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { cellKey, genomeToCells } from './lib/cells.mjs';
import { failClosed, scoreCell, scoreGenome } from './lib/fitness.mjs';
import { createCache } from './lib/cache.mjs';
import { RUNNER_CALL_WORST_CASE_S, provenanceFor } from './lib/provenance.mjs';
import { killRunnerGroups, liveRunnerGroups, measureCell, stopRunners } from './lib/runner.mjs';

export { provenanceFor } from './lib/provenance.mjs';
export { runnerArgv } from './lib/runner.mjs';

const log = (msg) => process.stderr.write(`[darwin-eval] ${msg}\n`);
const heldLocks = new Set();
const releaseAllLocks = () => { for (const release of heldLocks) release(); heldLocks.clear(); };

const FLAGS = {
  runner: 'string', 'env-dir': 'string', python: 'string', 'base-url': 'string', model: 'string',
  'model-revision': 'string', 'tokenizer-json': 'string', 'tokenizer-sha256': 'string', 'context-tokens': 'int',
  'cache-dir': 'string', 'runs-dir': 'string', 'seed-base': 'int', attempts: 'int', 'max-new-cells': 'int',
  concurrency: 'int', 'max-total-tokens': 'int', 'cell-timeout-s': 'int', 'deadline-ms': 'int', 'infra-retries': 'int',
  'dry-run': 'bool',
};

export function parseArgs(argv, env = process.env) {
  const o = {
    envDir: env.DARWIN_ARENA_ENV_DIR, python: env.DARWIN_ARENA_PYTHON, tokenizerJson: env.DARWIN_ARENA_TOKENIZER_JSON,
    cacheDir: env.DARWIN_ARENA_CACHE_DIR, baseUrl: 'http://localhost:8100/v1',
    tokenizerSha256: '0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3', contextTokens: 16384,
    seedBase: 700000, attempts: 4, maxNewCells: 8, concurrency: 2, maxTotalTokens: 2_000_000,
    cellTimeoutS: RUNNER_CALL_WORST_CASE_S, infraRetries: 1, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    const kind = name && Object.hasOwn(FLAGS, name) ? FLAGS[name] : null;
    if (!kind) throw new Error(`unknown argument ${argv[i]}`);
    const key = name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (kind === 'bool') { o[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (kind === 'int' && !/^\d{1,15}$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
    o[key] = kind === 'int' ? Number(value) : value;
  }
  const need = (ok, msg) => { if (!ok) throw new Error(msg); };
  need(o.cacheDir, '--cache-dir (or DARWIN_ARENA_CACHE_DIR) is required');
  need(o.concurrency >= 1 && o.concurrency <= 16, '--concurrency must be 1..16');
  need(o.attempts >= 4 && o.attempts <= 64 && o.attempts % 4 === 0, '--attempts must be a multiple of 4 in 4..64');
  need(o.contextTokens >= 1 && o.contextTokens <= 32768, '--context-tokens must be 1..32768');
  need(o.maxTotalTokens >= 1 && o.maxTotalTokens <= 100_000_000, '--max-total-tokens must be 1..100000000');
  need(o.cellTimeoutS >= 1, '--cell-timeout-s must be >= 1');
  need(o.infraRetries <= 2, '--infra-retries must be 0..2');
  need(o.deadlineMs === undefined || o.deadlineMs >= 1000, '--deadline-ms must be >= 1000');
  if (o.dryRun) {
    o.model ??= 'qwen38'; o.modelRevision ??= '1d4bf0f2';
  } else {
    need(o.envDir && o.python && o.tokenizerJson, '--env-dir, --python and --tokenizer-json are required without --dry-run');
    // No defaults in real mode: a proxy run that forgot --model would otherwise be labelled as the 27B.
    need(o.model && o.modelRevision, '--model and --model-revision are required without --dry-run');
    o.runner ??= join(o.envDir, 'scripts', 'calibrate.py');
    if (o.cellTimeoutS < RUNNER_CALL_WORST_CASE_S) log(`warning: --cell-timeout-s ${o.cellTimeoutS} < runner worst case ${RUNNER_CALL_WORST_CASE_S}`);
  }
  o.runsDir ??= join(o.cacheDir, 'runs');
  return o;
}

/** Cached rows, or measure under an exclusive lock (waits while another process measures the same key). */
async function obtainCell(o, cache, cell, key, prov) {
  const deadline = Date.now() + (o.attempts / 4) * (o.infraRetries + 1) * o.cellTimeoutS * 1000;
  for (;;) {
    const cached = cache.get(key);
    if (cached) return { rows: cached, cached: true, runnerCalls: 0 };
    const release = cache.lock(key);
    if (release) {
      heldLocks.add(release);
      try {
        const raced = cache.get(key);
        if (raced) return { rows: raced, cached: true, runnerCalls: 0 };
        const { rows, runnerCalls } = await measureCell(o, cell, key, prov);
        if (rows.filter((r) => r.type === 'episode').length !== o.attempts) throw new Error('episode count does not match --attempts');
        cache.put(key, rows); // only fully valid, infra-free, receipted blocks reach this line
        return { rows, cached: false, runnerCalls };
      } finally {
        heldLocks.delete(release);
        release();
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for another process to measure ${key}`);
    await sleep(o.dryRun ? 20 : 5000);
  }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Score one genome. Never throws: every failure becomes a fail-closed (regressed) card. */
export async function evaluateGenome(genome, variantId, o, { fetchImpl } = {}) {
  let keyed; let prov; let detail; let cache; let missing;
  try {
    const cells = genomeToCells(genome);
    ({ prov, detail } = await provenanceFor(o, process.env, { fetchImpl }));
    cache = createCache(o.cacheDir);
    keyed = cells.map((cell) => ({ cell, key: cellKey(cell, prov) }));
    missing = keyed.filter(({ key }) => cache.get(key) === null);
  } catch (error) {
    return { variantId, ...failClosed(`invalid_input: ${error.message}`, { attemptedNewCells: 0, runnerCalls: 0 }) };
  }
  const cellIds = keyed.map(({ cell, key }) => ({ ...cell, key }));
  if (missing.length > o.maxNewCells) {
    log(`refusing ${variantId}: ${missing.length} new cells > --max-new-cells ${o.maxNewCells}`);
    return { variantId, ...failClosed(`max_new_cells_exceeded: ${missing.length} > ${o.maxNewCells}`,
      { newCellsRequested: missing.length, maxNewCells: o.maxNewCells, cells: cellIds, dryRun: o.dryRun, attemptedNewCells: 0, runnerCalls: 0 }) };
  }
  const results = await pool(keyed, o.concurrency, async ({ cell, key }) => {
    try {
      return { cell, key, ...(await obtainCell(o, cache, cell, key, prov)) };
    } catch (error) {
      log(`cell ${cell.family} failed: ${error.message}`);
      return { cell, key, rows: [], cached: false, runnerCalls: error.runnerCalls ?? 0, error: error.message.slice(0, 800) };
    }
  });
  let scores;
  try {
    scores = results.map(({ cell, key, rows, cached, error }) => ({
      ...cell, key, cached, ...(error ? { error } : {}), ...scoreCell(rows),
    }));
  } catch (error) {
    return { variantId, ...failClosed(`invalid_rows: ${error.message}`, { cells: cellIds, attemptedNewCells: missing.length,
      runnerCalls: results.reduce((a, r) => a + r.runnerCalls, 0) }) };
  }
  const card = scoreGenome(scores);
  card.raw = { ...card.raw, variantId, dryRun: o.dryRun, provenance: prov, provenanceDetail: detail,
    newCells: results.filter((r) => !r.cached && !r.error).length,
    attemptedNewCells: results.filter((r) => !r.cached).length,
    runnerCalls: results.reduce((a, r) => a + r.runnerCalls, 0),
    failedCells: results.filter((r) => r.error).length, cachedCells: results.filter((r) => r.cached).length };
  log(`${variantId}: primary=${card.primary.toFixed(4)} noop=${card.noopRate.toFixed(3)} regressed=${card.regressed} ` +
    `new=${card.raw.newCells} cached=${card.raw.cachedCells} failed=${card.raw.failedCells} runnerCalls=${card.raw.runnerCalls}`);
  return { variantId, ...card };
}

async function readStdin(limit = 1_000_000) {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString('utf8');
    if (text.length > limit) throw new Error('stdin exceeds 1 MB');
  }
  return text;
}

async function main() {
  let done = false;
  const emit = (card, code) => {
    if (done) return; done = true;
    process.stdout.write(`${JSON.stringify(card)}\n`); process.exitCode = code;
  };
  let o; let input;
  // Abort path (deadline or signal): stop spawning, SIGTERM every runner group, release locks, print a fail-closed
  // card, then SIGKILL whatever is left after a grace period and exit.
  const abort = (reason) => {
    if (done) return;
    const pids = stopRunners('SIGTERM');
    releaseAllLocks();
    log(`${reason}: SIGTERM sent to ${pids.length} runner process group(s)`);
    emit({ variantId: input?.variantId ?? 'unknown', ...failClosed(reason, { killedRunnerGroups: pids.length }) }, 0);
    const until = Date.now() + 10_000;
    const poll = setInterval(() => {
      if (liveRunnerGroups().length === 0 || Date.now() > until) { clearInterval(poll); killRunnerGroups('SIGKILL'); process.exit(0); }
    }, 100);
  };
  process.on('exit', () => { killRunnerGroups('SIGKILL'); releaseAllLocks(); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => abort(`evaluator_interrupted: ${sig}`));
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.deadlineMs) setTimeout(() => abort(`evaluator_deadline_exceeded: ${o.deadlineMs}ms`), o.deadlineMs).unref();
    input = JSON.parse(await readStdin());
    if (!input || typeof input.variantId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.variantId)) throw new Error('stdin.variantId invalid');
    if (!input.genome || typeof input.genome !== 'object' || Array.isArray(input.genome)) throw new Error('stdin.genome must be an object');
  } catch (error) {
    log(error.message);
    return emit({ variantId: typeof input?.variantId === 'string' ? input.variantId : 'unknown', ...failClosed(`bad_invocation: ${error.message}`) }, 2);
  }
  try {
    emit(await evaluateGenome(input.genome, input.variantId, o), 0);
  } catch (error) {
    log(`internal error: ${error.stack ?? error.message}`);
    emit({ variantId: input.variantId, ...failClosed(`internal_error: ${error.message}`) }, 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
