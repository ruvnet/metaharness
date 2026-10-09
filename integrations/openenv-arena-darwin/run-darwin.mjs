#!/usr/bin/env node
// Darwin driver for evolving the OpenEnv Arena ENVIRONMENT knobs (per-family difficulty + per-episode completion
// budget) against the arena fitness (groups whose mixed rewards come from real reasoning, not truncation).
//
//   node run-darwin.mjs --work-root DIR --max-total-new-cells N [driver flags] -- [evaluator.mjs flags]
//   node run-darwin.mjs --work-root DIR --mock          (in-process toy landscape, no subprocess)
//
// It runs the UNMODIFIED upstream evolveNumeric (packages/darwin-mode, ADR-272) with one change: evolveNumeric's
// `mutateGenome` import is redirected (module resolve hook) to lib/one-param-mutator.mjs, so every child changes
// exactly ONE parameter (re-checked over the archive afterwards). Crossover is forced off.
// The driver OWNS the seed plan (--seed-base, --attempts) and passes it, the per-evaluation --max-new-cells and a
// --deadline-ms to every `node evaluator.mjs` call (ShellEvaluator), behind a run-wide budget in runner calls.
// Search scorecards are selection data. When the search winner beats the baseline, the baseline and the winner are
// re-measured on FRESH seeds (--confirm-seed-base, --confirm-attempts), and only those confirmation scorecards plus
// their paired block outcomes are what gate.mjs accepts (it refuses the search seed base).
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ShellEvaluator } from '../../packages/darwin-mode/dist/numeric-evaluator.js';
import { oneParamViolations } from './lib/one-param-mutator.mjs';
import { failCard, isFiniteCard, makeBudgetedEvaluator } from './lib/run-budget.mjs';
import { makeMockEvaluator } from './lib/mock-evaluator.mjs';
import { confirmWinner } from './lib/confirm.mjs';
import { childRows, confirmationSection, lineage, rankRecords, scoreOf, summarize } from './lib/report.mjs';

export { summarize } from './lib/report.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const EVOLVE_URL = new URL('../../packages/darwin-mode/dist/numeric-evolve.js', import.meta.url).href;
const SHIM_URL = new URL('./lib/one-param-mutator.mjs', import.meta.url).href;
const MAX_PARALLEL_RUNNER_CALLS = 16; // driver --concurrency x evaluator --concurrency
const DRIVER_OWNED = ['--max-new-cells', '--seed-base', '--attempts', '--deadline-ms'];
const DEFAULTS = Object.freeze({ generations: 3, children: 4, concurrency: 2, seed: 0, sigma: 0.2,
  seedBase: 700000, attempts: 8, confirmAttempts: 16,
  // Per-candidate wall clock. evaluator.mjs gets --deadline-ms a margin below it, so it kills its runner process
  // groups and prints a fail-closed card itself before ShellEvaluator's SIGKILL (which could not clean up).
  evaluatorTimeoutMs: 24 * 60 * 60 * 1000, evaluator: join(HERE, 'evaluator.mjs'), cellsModule: join(HERE, 'lib', 'cells.mjs') });

let redirects = 0;
let evolveLoad = null;
/** evolveNumeric with its `./numeric-mutator.js` import resolved to the one-param shim. */
export function loadOneParamEvolve() {
  if (!evolveLoad) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === './numeric-mutator.js' && context.parentURL?.endsWith('/darwin-mode/dist/numeric-evolve.js')) {
          redirects += 1;
          return { url: SHIM_URL, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      },
    });
    evolveLoad = import(EVOLVE_URL).then(m => {
      if (redirects === 0) throw new Error('one-param hook did not take effect: numeric-evolve.js was already loaded in this process');
      return m.evolveNumeric;
    });
  }
  return evolveLoad;
}

const int = (v, name, min, max) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer in [${min}, ${max}]`);
  return n;
};
const SECRETISH = /api[-_]?key|secret|password|passwd|bearer|credential|auth/i;
export function redactArgv(argv) {
  return argv.map((a, i) => {
    if (/^--[^=]+=/.test(a) && SECRETISH.test(a.split('=')[0])) return `${a.split('=')[0]}=<redacted>`;
    return i > 0 && SECRETISH.test(argv[i - 1]) && /^--/.test(argv[i - 1]) && !argv[i - 1].includes('=') ? '<redacted>' : a;
  });
}

function normalize(opts) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  if (typeof o.workRoot !== 'string' || !o.workRoot) throw new Error('--work-root is required');
  o.workRoot = resolve(o.workRoot);
  o.generations = int(o.generations, 'generations', 0, 1000);
  o.children = int(o.children, 'children', 1, 64);
  o.concurrency = int(o.concurrency, 'concurrency', 1, 64);
  o.seed = int(o.seed, 'seed', 0, 2 ** 31 - 1);
  o.sigma = Number(o.sigma);
  if (!Number.isFinite(o.sigma) || o.sigma <= 0 || o.sigma > 1) throw new Error('--sigma must be in (0, 1]');
  o.evaluatorTimeoutMs = int(o.evaluatorTimeoutMs, 'evaluator-timeout-ms', 2000, 7 * 24 * 3600 * 1000);
  o.seedBase = int(o.seedBase, 'seed-base', 0, 2 ** 40);
  o.attempts = int(o.attempts, 'attempts', 4, 64);
  o.confirmAttempts = int(o.confirmAttempts, 'confirm-attempts', 0, 64);
  if (o.attempts % 4 || o.confirmAttempts % 4) throw new Error('--attempts / --confirm-attempts must be multiples of 4 (0 disables confirmation)');
  o.confirmSeedBase = int(o.confirmSeedBase ?? o.seedBase + 100_000, 'confirm-seed-base', 0, 2 ** 40);
  if (o.confirmAttempts > 0 && o.confirmSeedBase < o.seedBase + o.attempts && o.seedBase < o.confirmSeedBase + o.confirmAttempts) {
    throw new Error('--confirm-seed-base must give a seed range disjoint from the search seeds (fresh instances)');
  }
  o.passthrough = [...(o.passthrough ?? [])];
  const owned = o.passthrough.find(a => DRIVER_OWNED.some(f => a === f || a.startsWith(`${f}=`)));
  if (owned) throw new Error(`${owned.split('=')[0]} is owned by the driver (use run-darwin's own flag / --max-total-new-cells)`);
  const ci = o.passthrough.indexOf('--concurrency');
  const evalConc = ci >= 0 ? Number(o.passthrough[ci + 1]) : 2; // evaluator.mjs default
  if (!o.mock && !(o.concurrency * evalConc <= MAX_PARALLEL_RUNNER_CALLS)) {
    throw new Error(`driver --concurrency x evaluator --concurrency exceeds ${MAX_PARALLEL_RUNNER_CALLS} parallel runner calls`);
  }
  if (o.maxTotalNewCells === undefined || o.maxTotalNewCells === null) {
    if (!o.mock) throw new Error('--max-total-new-cells is required for evaluator runs (it bounds GPU work, in runner calls)');
    o.maxTotalNewCells = Infinity;
  } else {
    o.maxTotalNewCells = int(o.maxTotalNewCells, 'max-total-new-cells', 0, 1_000_000);
  }
  return o;
}

async function loadCells(path) {
  if (!existsSync(path)) throw new Error(`cells module not found: ${path}`);
  const cells = await import(pathToFileURL(resolve(path)).href);
  for (const name of ['FAMILIES', 'genomeSpec', 'baselineGenome', 'genomeToCells']) {
    if (!(name in cells)) throw new Error(`cells module ${path} does not export ${name}`);
  }
  return cells;
}

/** Run one evolution (+ fresh-seed confirmation). Returns the report (also written to <workRoot>/reports/darwin-run.json). */
export async function runDarwin(options) {
  const o = normalize(options);
  const cells = await loadCells(o.cellsModule);
  const famOpts = o.families ? { families: o.families } : undefined;
  const genomeSpec = cells.genomeSpec(famOpts);
  const baselineGenome = cells.baselineGenome(famOpts);
  if (Object.keys(baselineGenome).sort().join(',') !== Object.keys(genomeSpec).sort().join(',')) throw new Error('baselineGenome keys do not match genomeSpec');
  cells.genomeToCells(baselineGenome); // throws on unsupported knob params before any work starts
  if (existsSync(join(o.workRoot, 'archive.json'))) {
    throw new Error(`${o.workRoot} already holds an archive; use a fresh --work-root (cell results are cached by the evaluator)`);
  }
  let evaluatorArgv = null;
  let makeRun;
  if (o.mock) {
    const mock = makeMockEvaluator(cells.genomeToCells);
    makeRun = () => (genome, variantId) => mock.evaluate(genome, variantId);
  } else {
    if (!existsSync(o.evaluator)) throw new Error(`evaluator not found: ${o.evaluator}`);
    evaluatorArgv = [process.execPath, '--experimental-strip-types', resolve(o.evaluator), ...o.passthrough];
    const margin = Math.min(60_000, Math.floor(o.evaluatorTimeoutMs / 4));
    makeRun = (seedBase, attempts) => (genome, variantId, allowance) => new ShellEvaluator({
      // cwd = caller's cwd, so relative passthrough paths (--cache-dir ./c) resolve like --work-root does.
      command: [...evaluatorArgv, '--seed-base', String(seedBase), '--attempts', String(attempts), '--max-new-cells', String(allowance),
        '--deadline-ms', String(o.evaluatorTimeoutMs - margin)],
      cwd: process.cwd(), timeoutMs: o.evaluatorTimeoutMs,
    }).evaluate(genome, variantId);
  }
  // Mock cells have no seeds/attempts, so a mock cell costs 1 unit.
  const budget = makeBudgetedEvaluator({ genomeToCells: cells.genomeToCells, run: makeRun(o.seedBase, o.attempts),
    maxTotalNewCells: o.maxTotalNewCells, unitsPerCell: o.mock ? 1 : o.attempts / 4, namespace: `search:${o.seedBase}:${o.attempts}` });
  // A regressed baseline would make every child "beat" it for free (a failed cell scores 0): stop spending GPU.
  let aborted = null;
  const guarded = { evaluate: async (genome, variantId) => {
    if (aborted && variantId !== 'baseline') return failCard(variantId, 'baseline_regressed: run aborted, child not evaluated', { attemptedNewCells: 0, runnerCalls: 0 });
    const card = await budget.evaluate(genome, variantId);
    if (variantId === 'baseline' && (card.regressed || !isFiniteCard(card))) {
      aborted = card.evaluatorError ?? card.raw?.regressedReasons?.join(',') ?? 'regressed';
    }
    return card;
  } };
  const evolveNumeric = await loadOneParamEvolve();
  await mkdir(join(o.workRoot, 'reports'), { recursive: true });
  const result = await evolveNumeric({ genomeSpec, evaluator: guarded, generations: o.generations,
    childrenPerGeneration: o.children, seed: o.seed, concurrency: o.concurrency, mutationSigma: o.sigma,
    crossover: false, workRoot: o.workRoot, baselineGenome });

  const byId = new Map(result.records.map(r => [r.variant.id, r]));
  const violations = oneParamViolations(result.records);
  const baseline = byId.get('baseline');
  const winner = aborted ? null : rankRecords(result.records)[0] ?? null;
  const evaluated = result.records.filter(r => r.score).length;
  const improved = !!winner && !!baseline?.score && winner.variant.id !== 'baseline' && winner.score.primary > baseline.score.primary;
  let confirmation = { status: 'skipped', reason: aborted ? 'baseline_regressed' : o.mock ? 'mock landscape has no seeds; mock cards are never gate-admissible'
    : o.confirmAttempts === 0 ? '--confirm-attempts 0' : !improved ? 'no search winner beats the baseline' : null };
  if (confirmation.reason === null) {
    confirmation = await confirmWinner({ budget, makeRun, genomeToCells: cells.genomeToCells, baselineGenome,
      winnerGenome: winner.variant.genome, seedBase: o.confirmSeedBase, attempts: o.confirmAttempts });
  }
  const stats = budget.stats();
  const reports = join(o.workRoot, 'reports');
  const files = { archive: join(o.workRoot, 'archive.json'), engineWinner: join(reports, 'winner.json'),
    run: join(reports, 'darwin-run.json'), winnerGenome: join(reports, 'winner-genome.json'),
    baselineScorecard: join(reports, 'baseline-scorecard.json'), winnerScorecard: join(reports, 'winner-scorecard.json'),
    confirmBaselineScorecard: join(reports, 'confirm-baseline-scorecard.json'), confirmWinnerScorecard: join(reports, 'confirm-winner-scorecard.json'),
    confirmPaired: join(reports, 'confirm-paired.json') };
  const report = {
    kind: 'openenv_arena_darwin_run', version: 2, mode: o.mock ? 'mock' : 'evaluator',
    evidence: o.mock ? 'synthetic_toy_landscape_not_model_rollouts'
      : o.passthrough.includes('--dry-run') || result.records.some(r => r.score?.raw?.dryRun === true)
        ? 'evaluator_dry_run_fake_rows_not_model_rollouts' : 'evaluator_scorecards',
    config: { generations: o.generations, childrenPerGeneration: o.children, concurrency: o.concurrency,
      seed: o.seed, sigma: o.sigma, crossover: false, mutation: 'one_param_at_a_time', seedBase: o.seedBase, attempts: o.attempts,
      confirmSeedBase: o.confirmSeedBase, confirmAttempts: o.confirmAttempts,
      evaluatorTimeoutMs: o.evaluatorTimeoutMs, evaluatorArgv: evaluatorArgv && redactArgv(evaluatorArgv) },
    // gate.mjs --run reads this: it refuses scorecards from the selection seed base and splits alpha over `evaluated`.
    selection: { seedBase: o.seedBase, attempts: o.attempts, evaluated, mock: !!o.mock,
      baselineRunnerCalls: stats.ledger.find(e => e.variantId === 'baseline')?.charged ?? null },
    budget: { unit: 'runner call = one 4-seed block of one cell (attempts/4 per cell)',
      maxTotalNewCells: Number.isFinite(stats.maxTotalNewCells) ? stats.maxTotalNewCells : 'unlimited',
      reservedNewCells: stats.reservedNewCells, refusedEvaluations: stats.refusedEvaluations,
      evaluatorRefusedEvaluations: stats.evaluatorRefusedEvaluations, releasedFailedCells: stats.releasedFailedCells,
      reportedAttemptedNewCells: o.mock ? null : stats.reportedAttemptedNewCells, reportedRunnerCalls: o.mock ? null : stats.reportedRunnerCalls },
    oneParamInvariant: { ok: violations.length === 0, violations },
    aborted: aborted ? `baseline_regressed: ${aborted}` : null,
    evaluated,
    baseline: baseline && { variantId: 'baseline', genome: baseline.variant.genome, score: scoreOf(baseline.score) },
    winner: winner && { variantId: winner.variant.id, genome: winner.variant.genome, score: scoreOf(winner.score),
      lineage: lineage(byId, winner.variant.id), improvedOverBaseline: improved },
    engineWinnerId: result.winner?.variant.id ?? null,
    ranked: rankRecords(result.records).map(r => ({ id: r.variant.id, primary: r.score.primary, noopRate: r.score.noopRate, costPerWin: r.score.costPerWin })),
    children: childRows(result.records, byId),
    confirmation: confirmationSection(confirmation, evaluated),
    gateCommand: confirmation.status === 'measured' ? `node --experimental-strip-types gate.mjs --run ${files.run} --out <receipt.json>` : null,
    files,
  };
  await writeFile(files.run, `${JSON.stringify(report, null, 2)}\n`);
  if (baseline?.score) await writeFile(files.baselineScorecard, `${JSON.stringify(baseline.score, null, 2)}\n`);
  if (winner) {
    await writeFile(files.winnerGenome, `${JSON.stringify({ variantId: winner.variant.id,
      genome: winner.variant.genome, cells: cells.genomeToCells(winner.variant.genome) }, null, 2)}\n`);
    await writeFile(files.winnerScorecard, `${JSON.stringify(winner.score, null, 2)}\n`);
  }
  if (confirmation.status === 'measured') {
    await writeFile(files.confirmBaselineScorecard, `${JSON.stringify(confirmation.baseline, null, 2)}\n`);
    await writeFile(files.confirmWinnerScorecard, `${JSON.stringify(confirmation.winner, null, 2)}\n`);
    await writeFile(files.confirmPaired, `${JSON.stringify({ pairedOutcomes: confirmation.pairs }, null, 2)}\n`);
  }
  if (violations.length || aborted) {
    const error = new Error(violations.length ? `one_param_invariant_violated: ${violations.join('; ')}` : report.aborted);
    error.report = report;
    throw error;
  }
  return report;
}

const USAGE = `usage: node run-darwin.mjs --work-root DIR (--mock | --max-total-new-cells N) [--generations N] [--children N]
  [--concurrency N] [--seed N] [--sigma F] [--families a,b,..] [--seed-base N] [--attempts N]
  [--confirm-seed-base N] [--confirm-attempts N (0 = no confirmation)] [--evaluator PATH] [--evaluator-timeout-ms N]
  [--cells-module PATH] [-- <flags passed verbatim to evaluator.mjs, e.g. --dry-run --cache-dir D --concurrency 4 ...>]
  --max-total-new-cells counts runner calls (one 4-seed block of one cell); a cell at A attempts costs A/4.`;

async function main(argv) {
  const split = argv.indexOf('--');
  const own = split < 0 ? argv : argv.slice(0, split);
  const passthrough = split < 0 ? [] : argv.slice(split + 1);
  const s = { type: 'string' };
  const { values: v } = parseArgs({ args: own, strict: true, allowPositionals: false, options: {
    'work-root': s, generations: s, children: s, concurrency: s, seed: s, sigma: s, 'max-total-new-cells': s, mock: { type: 'boolean' },
    evaluator: s, 'evaluator-timeout-ms': s, 'cells-module': s, families: s, 'seed-base': s, attempts: s, 'confirm-seed-base': s,
    'confirm-attempts': s, help: { type: 'boolean' } } });
  if (v.help) { console.log(USAGE); return 0; }
  const report = await runDarwin({ workRoot: v['work-root'], generations: v.generations, children: v.children, concurrency: v.concurrency,
    seed: v.seed, sigma: v.sigma, maxTotalNewCells: v['max-total-new-cells'], mock: v.mock === true, evaluator: v.evaluator,
    evaluatorTimeoutMs: v['evaluator-timeout-ms'], cellsModule: v['cells-module'], seedBase: v['seed-base'], attempts: v.attempts,
    confirmSeedBase: v['confirm-seed-base'], confirmAttempts: v['confirm-attempts'],
    families: v.families?.split(',').map(x => x.trim()).filter(Boolean), passthrough });
  console.log(summarize(report));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    if (error.report) console.log(summarize(error.report));
    console.error(`run-darwin: ${error.message}`);
    if (!error.report) console.error(USAGE);
    process.exitCode = error.report ? 3 : 2;
  });
}
