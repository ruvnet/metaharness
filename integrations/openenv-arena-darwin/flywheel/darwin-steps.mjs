// Default `deps.darwin` for the flywheel: thin subprocess adapters over the UNMODIFIED Darwin lane
// (run-darwin.mjs, evaluator.mjs, gate.mjs, lib/cells.mjs). Tests replace this object with fakes.
//
//   ready()                       -> true, or throws when the evaluator could not run (checked BEFORE any rental)
//   expectedProvenance({seedBase, attempts, baseUrl}) -> (async) the raw.provenance evaluator.mjs will stamp
//   search({workRoot, incumbentGenome, baseUrl, seed}) -> reports/darwin-run.json (baseline = incumbent). run-darwin
//        owns the seed plan (--seed-base/--attempts are ITS flags, refused in the evaluator passthrough) and its own
//        confirmation is switched off (--confirm-attempts 0): the flywheel's preregistered confirmation replaces it.
//   evaluate({genome, variantId, seedBase, attempts, maxNewCells, baseUrl}) -> NumericScoreCard
//   gate({runPath, baselinePath, candidatePath, pairedPath, outPath, candidateBudget, requestSha256})
//        -> gate stdout + {exitCode, bindingSupported}. gate.mjs v2 needs --run (the search report: selection context);
//        --baseline/--candidate/--paired override it with the flywheel's confirmation cards and Darwin-derived pairs.
//   verify({receiptPath}) -> {verified, promote, publicKeyPinned, publicKey, payload}  (v2 refuses an unpinned verify)
//   digestOf(value), cells {FAMILIES, baselineGenome, genomeToCells}
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalDigest } from './canonical-json.mjs';
import { SECRET_ENV } from './child-proc.mjs';
import { writeCellsWrapper } from './incumbent.mjs';
import { redact } from './journal.mjs';

const DW = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = Object.freeze({ runDarwin: join(DW, 'run-darwin.mjs'), evaluator: join(DW, 'evaluator.mjs'),
  gate: join(DW, 'gate.mjs'), cells: join(DW, 'lib', 'cells.mjs'), provenance: join(DW, 'lib', 'provenance.mjs') });
// Children (run-darwin, evaluator, the env lane's calibrate.py, ruvector) never need a credential: every secret-shaped
// name is stripped by the same rule as render-and-check.mjs (child-proc.mjs SECRET_ENV).

/**
 * The environment of every Darwin-lane child. ARENA_MODEL_API_KEY is a fresh random value per run, NEVER an inherited
 * one: it is sent as a Bearer token to the rented, third-party GPU host (vLLM runs without --api-key, so any value
 * works and serverSha does not hash it). HF_HOME points at an empty dir and the hub is offline, so nothing a child runs
 * can find the HF token file through huggingface_hub.
 */
export function darwinChildEnv(env = process.env, { hfHome = mkdtempSync(join(tmpdir(), 'arena-flywheel-nohf-')) } = {}) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
  return { ...out, ARENA_MODEL_API_KEY: randomBytes(16).toString('hex'), HF_HOME: hfHome, HF_HUB_OFFLINE: '1' };
}

function runNode(script, args, { input = '', env, timeoutMs, cwd = DW }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args],
      { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; if (stdout.length > 64e6) child.kill('SIGKILL'); });
    child.stderr.on('data', c => { stderr = (stderr + c).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', e => { clearTimeout(timer); done({ code: -1, stdout, stderr: `spawn failed: ${e.message}` }); });
    child.on('close', (code, signal) => { clearTimeout(timer); done({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nkilled by ${signal}` : stderr }); });
    child.stdin.end(input);
  });
}
const lastJsonLine = text => JSON.parse(text.trim().split('\n').filter(Boolean).at(-1) ?? 'null');
const tail = r => redact(r.stderr.trim().slice(-600));

/** Evaluator flags; identical flags => identical provenance on both confirmation cards. `seedPlan: false` omits
 *  --seed-base/--attempts (run-darwin passes those itself and refuses them in the passthrough). */
export function evaluatorFlags(ev, { baseUrl, seedBase, attempts, seedPlan = true }) {
  const opt = (flag, v) => (v === null || v === undefined ? [] : [flag, String(v)]);
  if (!ev.dryRun) for (const k of ['envDir', 'python', 'tokenizerJson']) {
    if (typeof ev[k] !== 'string' || !ev[k]) throw new Error(`evaluator.${k} is not configured (required for real rollouts)`);
  }
  return ['--cache-dir', ev.cacheDir, ...(seedPlan ? ['--seed-base', String(seedBase), '--attempts', String(attempts)] : []),
    '--concurrency', String(ev.concurrency), '--context-tokens', String(ev.contextTokens),
    '--model', ev.model, '--model-revision', ev.modelRevision, ...opt('--tokenizer-sha256', ev.tokenizerSha256),
    ...(ev.dryRun ? ['--dry-run'] : ['--env-dir', ev.envDir, '--python', ev.python, '--tokenizer-json', ev.tokenizerJson,
      '--base-url', baseUrl ?? 'http://localhost:8100/v1', ...opt('--runner', ev.runner)])];
}

export async function makeDarwinSteps(config, { env = process.env } = {}) {
  const ev = config.evaluator, d = config.darwin, q = config.confirmation, g = config.gate;
  const childEnv = darwinChildEnv(env);
  const cells = await import(pathToFileURL(PATHS.cells).href);
  const evaluatorMod = await import(pathToFileURL(PATHS.evaluator).href);
  // The evaluator's provenance lives in lib/provenance.mjs once the Darwin lane split it out; fall back to evaluator.mjs.
  const provMod = existsSync(PATHS.provenance) ? await import(pathToFileURL(PATHS.provenance).href) : evaluatorMod;
  const gateMod = await import(pathToFileURL(PATHS.gate).href);
  const gateSource = () => readFileSync(PATHS.gate, 'utf8');

  // Exactly what evaluator.mjs will stamp (sync or async provenanceFor; it may probe the live server, so this
  // runs only once the GPU endpoint is up and must be given the same baseUrl the evaluator will use).
  const expectedProvenance = async ({ seedBase, attempts, baseUrl }) => {
    const o = evaluatorMod.parseArgs(evaluatorFlags(ev, { baseUrl, seedBase, attempts }), childEnv);
    return (await provMod.provenanceFor(o, childEnv)).prov;
  };

  return {
    cells: { FAMILIES: cells.FAMILIES, baselineGenome: cells.baselineGenome, genomeToCells: cells.genomeToCells },
    digestOf: v => gateMod.digestOf(v),
    expectedProvenance,
    /** Offline pre-rental check: flags parse and every local input the evaluator reads exists. Never touches a server. */
    ready() {
      const o = evaluatorMod.parseArgs(evaluatorFlags(ev, { seedBase: d.searchSeedBase, attempts: d.searchAttempts }), childEnv);
      if (!o.dryRun) {
        for (const p of [join(o.envDir, 'arena_env', 'tasks.py'), join(o.envDir, 'arena_env', 'environment.py'), o.runner, o.tokenizerJson, o.python]) {
          if (!existsSync(p)) throw new Error(`evaluator input missing: ${p}`);
        }
      }
      for (const p of [PATHS.runDarwin, PATHS.evaluator, PATHS.gate]) if (!existsSync(p)) throw new Error(`darwin lane file missing: ${p}`);
      return true;
    },

    async search({ workRoot, incumbentGenome, baseUrl, seed, timeoutMs = d.searchTimeoutMs }) {
      mkdirSync(dirname(workRoot), { recursive: true });
      const wrapper = writeCellsWrapper(join(dirname(workRoot), `${workRoot.split('/').at(-1)}-cells.mjs`),
        incumbentGenome, pathToFileURL(PATHS.cells).href);
      const args = ['--work-root', workRoot, '--max-total-new-cells', String(d.maxTotalNewCells),
        '--generations', String(d.generations), '--children', String(d.children), '--concurrency', String(d.concurrency),
        '--seed', String(seed), '--cells-module', wrapper, '--evaluator-timeout-ms', String(Math.min(d.evaluatorTimeoutMs, timeoutMs)),
        '--seed-base', String(d.searchSeedBase), '--attempts', String(d.searchAttempts), '--confirm-attempts', '0',
        '--', ...evaluatorFlags(ev, { baseUrl, seedPlan: false })];
      const r = await runNode(PATHS.runDarwin, args, { env: childEnv, timeoutMs });
      if (r.code !== 0) throw new Error(`darwin_search_failed: exit ${r.code}: ${tail(r)}`);
      const reportPath = join(workRoot, 'reports', 'darwin-run.json');
      if (!existsSync(reportPath)) throw new Error('darwin_search_failed: no reports/darwin-run.json');
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      if (canonicalDigest(report.baseline?.genome ?? null) !== canonicalDigest(incumbentGenome)) throw new Error('darwin_baseline_is_not_the_incumbent');
      return report;
    },

    async evaluate({ genome, variantId, seedBase, attempts, maxNewCells, baseUrl, timeoutMs = q.evaluateTimeoutMs }) {
      const args = [...evaluatorFlags(ev, { baseUrl, seedBase, attempts }), '--max-new-cells', String(maxNewCells)];
      const r = await runNode(PATHS.evaluator, args, { input: JSON.stringify({ variantId, genome }), env: childEnv, timeoutMs });
      if (r.code !== 0) throw new Error(`evaluator_failed:${variantId}: exit ${r.code}: ${tail(r)}`);
      return lastJsonLine(r.stdout);
    },

    // alpha/lambda/candidateBudget are the PREREGISTERED plan's (the caller passes them), never this config's.
    async gate({ runPath, baselinePath, candidatePath, pairedPath, outPath, candidateBudget, alpha, lambda, requestSha256 }) {
      const bindingSupported = gateSource().includes("'request-sha256'");
      if (!Number.isSafeInteger(candidateBudget) || candidateBudget < 1) throw new Error('gate: preregistered candidateBudget missing');
      for (const [k, v] of [['alpha', alpha], ['lambda', lambda]]) {
        if (!(typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1)) throw new Error(`gate: preregistered ${k} missing`);
      }
      const args = ['--run', runPath, '--baseline', baselinePath, '--candidate', candidatePath, ...(pairedPath ? ['--paired', pairedPath] : []),
        '--alpha', String(alpha), '--lambda', String(lambda), '--candidate-budget', String(candidateBudget),
        '--key-dir', g.keyDir, '--out', outPath, ...(bindingSupported && requestSha256 ? ['--request-sha256', requestSha256] : [])];
      const r = await runNode(PATHS.gate, args, { env: childEnv, timeoutMs: 120_000 });
      let out;
      try { out = lastJsonLine(r.stdout) ?? {}; } catch { out = { error: 'unparseable_gate_output' }; }
      if (r.code === 2 || r.code < 0) out = { ...out, promote: false, verified: false, error: out.error ?? tail(r) };
      return { ...out, receiptPath: out.receiptPath ?? outPath, exitCode: r.code, bindingSupported };
    },

    async verify({ receiptPath }) {
      const pin = g.expectPublicKey; // operator pin; without it gate.mjs verifies against --key-dir, but nothing is "pinned"
      const r = await runNode(PATHS.gate, ['--verify', receiptPath, ...(pin ? ['--expect-public-key', pin] : ['--key-dir', g.keyDir])],
        { env: childEnv, timeoutMs: 60_000 });
      let out = {};
      try { out = lastJsonLine(r.stdout) ?? {}; } catch { out = {}; }
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      const verified = out.verified === true && r.code !== 2 && gateMod.verifyGateReceipt(receipt, { expectedPublicKey: pin ?? undefined });
      return { verified, promote: out.promote === true && receipt.payload?.promote === true, exitCode: r.code,
        publicKeyPinned: Boolean(pin) && receipt.publicKey === pin, publicKey: receipt.publicKey, payload: receipt.payload };
    },
  };
}
