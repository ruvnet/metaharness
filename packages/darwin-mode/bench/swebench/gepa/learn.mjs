// SPDX-License-Identifier: MIT
//
// `metaharness learn` — the PRODUCTIZED thin wrapper over the GEPA harness (ADR-228).
//
// It runs one GEPA optimization for one (model) on one (slice) via run-gepa.mjs, then applies the
// STRICT product promotion rule to the HOLDOUT eval and emits a keyed promotion report. The
// promote/reject *decision* is advisory output — actually changing a base genome is the caller's
// call; this command just computes and records the verdict + evidence.
//
// STRICT promotion rule (product spec) — promote the winning candidate ONLY if ALL hold on the
// UNSEEN holdout slice:
//   (1) gold does NOT regress — no instance the seed resolved is lost by the candidate;
//   (2) empty-patch rate improves — strictly fewer class-3 (exploration-loop / empty-patch) failures;
//   (3) cost/resolved does not worsen — candidate $/resolved <= seed $/resolved.
// Empty-patch = failureClass===3 (metric.mjs classifyFailure). All facts come from each holdout
// eval's per-instance `.details` ({ gold, failureClass, thrash, cost }).
//
// Usage:
//   OPENROUTER_API_KEY=... node gepa/learn.mjs \
//     --host <h> --model <m> --slice <manifest> \
//     [--seed <genomeFile>] [--train-first 12] [--max-cost 12] [--dry-run]
//   Extra pass-through: --reflection-model, --max-candidates, --max-steps, --concurrency,
//   --per-eval-max-cost, --run-id, --vertical, --language, --task-class.
//
// $0 unit-tested: the promotion-rule predicate, report shape, and composite key are pure functions
// exported below and exercised in learn.test.mjs. --dry-run performs NO spend (prints the plan).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── pure helpers ($0-tested) ────────────────────────────────────────────────────────────────────

/** Empty-patch instance ⇔ failureClass===3 (exploration-loop / empty patch). */
export const isEmptyPatchDetail = (d) => d && d.failureClass === 3;

/** Set of instance_ids the run gold-resolved, from an eval JSON's `.details`. */
export function resolvedIdSet(details = {}) {
  return new Set(Object.keys(details).filter((id) => details[id] && details[id].gold === true));
}

/** Empty-patch rate = (# class-3 instances) / N, over an eval JSON's `.details`. */
export function emptyPatchRate(details = {}) {
  const ids = Object.keys(details);
  if (!ids.length) return 0;
  const empties = ids.filter((id) => isEmptyPatchDetail(details[id])).length;
  return Math.round((empties / ids.length) * 1000) / 1000;
}

/** Sum of per-instance thrash from `.details`. */
export function totalThrash(details = {}) {
  return Object.values(details).reduce((s, d) => s + (d && d.thrash ? d.thrash : 0), 0);
}

/** Roll a full eval JSON into the comparable summary the report + rule consume. */
export function summarizeEval(ev = {}) {
  const details = ev.details || {};
  const gold = typeof ev.goldResolved === 'number'
    ? ev.goldResolved
    : resolvedIdSet(details).size;
  const cost = typeof ev.cost === 'number' ? ev.cost : 0;
  const costPerResolved = gold > 0 ? Math.round((cost / gold) * 1e4) / 1e4 : Infinity;
  return {
    n: ev.n ?? Object.keys(details).length,
    gold,
    sum: ev.sumScore ?? null,
    emptyPatchRate: emptyPatchRate(details),
    thrash: totalThrash(details),
    cost: Math.round(cost * 1e4) / 1e4,
    costPerResolved,
    resolvedIds: [...resolvedIdSet(details)],
  };
}

/**
 * The STRICT promotion predicate over HOLDOUT seed vs candidate summaries (from summarizeEval).
 * Returns { promote, reason, checks, regressions, gains }.
 */
export function evaluatePromotion({ seed, cand }) {
  const seedSet = new Set(seed.resolvedIds || []);
  const candSet = new Set(cand.resolvedIds || []);
  const regressions = [...seedSet].filter((id) => !candSet.has(id)); // seed-resolved lost by cand
  const gains = [...candSet].filter((id) => !seedSet.has(id));        // newly resolved by cand

  const goldNoRegress = regressions.length === 0;
  const emptyPatchImproves = cand.emptyPatchRate < seed.emptyPatchRate;
  // "does not worsen": candidate $/resolved must be <= seed's (Infinity when 0 resolved).
  const costPerResolvedNotWorse = cand.costPerResolved <= seed.costPerResolved;

  const checks = { goldNoRegress, emptyPatchImproves, costPerResolvedNotWorse };
  const promote = goldNoRegress && emptyPatchImproves && costPerResolvedNotWorse;

  const fails = [];
  if (!goldNoRegress) fails.push(`gold regressed: lost seed-resolved ${JSON.stringify(regressions)}`);
  if (!emptyPatchImproves) fails.push(`empty-patch rate did not improve (${seed.emptyPatchRate} → ${cand.emptyPatchRate})`);
  if (!costPerResolvedNotWorse) fails.push(`cost/resolved worsened ($${seed.costPerResolved} → $${cand.costPerResolved})`);

  const reason = promote
    ? `PROMOTE: gold no-regress (${gains.length} new, 0 lost), empty-patch ${seed.emptyPatchRate}→${cand.emptyPatchRate}, cost/resolved $${seed.costPerResolved}→$${cand.costPerResolved}`
    : `REJECT: ${fails.join('; ')}`;

  return { promote, reason, checks, regressions, gains };
}

/** Composite registry key: host+model+vertical+language+task_class+genome_version. */
export function compositeKey({ host, model, vertical, language, task_class, genome_version }) {
  return [host, model, vertical, language, task_class, genome_version]
    .map((x) => String(x ?? 'unknown')).join('+');
}

/**
 * Assemble the full promotion report object (pure — the CLI just feeds it real evals + writes it).
 *   host, model, slice, seedId, candId, genomeVersion
 *   train  { seed, cand }  holdout { seed, cand }  — each a summarizeEval() result (cand optional)
 *   keyMeta { vertical, language, task_class }
 *   run    { budget, best, frontier, ... }  (optional provenance from run-gepa)
 */
export function buildPromotionReport({
  host, model, slice, seedId, candId, genomeVersion,
  train, holdout, keyMeta = {}, run = null, ranAt = new Date().toISOString(),
}) {
  const vertical = keyMeta.vertical || 'code-repair';
  const language = keyMeta.language || 'python';
  const task_class = keyMeta.task_class || 'bug-fix';
  const key = compositeKey({ host, model, vertical, language, task_class, genome_version: genomeVersion });

  // The load-bearing decision is HOLDOUT-only (out-of-sample).
  const verdict = evaluatePromotion({ seed: holdout.seed, cand: holdout.cand || holdout.seed });

  return {
    ranAt,
    key,
    keyParts: { host, model, vertical, language, task_class, genome_version: genomeVersion },
    slice,
    seed: seedId,
    candidate: candId,
    train: { seed: train.seed, cand: train.cand || null },
    holdout: { seed: holdout.seed, cand: holdout.cand || null },
    regressions: verdict.regressions,
    gains: verdict.gains,
    checks: verdict.checks,
    verdict: verdict.promote ? 'promote' : 'reject',
    reason: verdict.reason,
    rule: 'strict: gold-no-regress AND holdout-empty-patch-improves AND cost/resolved-not-worse',
    run: run ? {
      best: run.best, frontier: run.frontier, bestMean: run.bestMean,
      budget: run.budget, holdoutGoldDelta: run.holdout ? run.holdout.goldDelta : null,
    } : null,
  };
}

// ── CLI wiring (spawns run-gepa.mjs, then loads its eval artifacts) ───────────────────────────────

function loadEvalArtifacts(workDir, { trainFirst, seedId, bestId }) {
  const files = existsSync(workDir)
    ? readdirSync(workDir).filter((f) => /^eval-.*\.json$/.test(f))
    : [];
  const parsed = files.map((f) => {
    let data = null; try { data = JSON.parse(readFileSync(join(workDir, f), 'utf8')); } catch { /**/ }
    const m = f.match(/^eval-(\d+)-/); // train evals are eval-NN-<id>.json; holdout are eval-holdout-*.json
    return { file: f, evalN: m ? +m[1] : null, data };
  }).filter((e) => e.data);

  const byName = (name) => parsed.find((e) => e.file === name)?.data || null;

  // train seed = the first evaluation (evalN=1); train evals have skip===0
  const trainEvals = parsed.filter((e) => e.data.skip === 0 && e.evalN != null);
  const trainSeed = trainEvals.slice().sort((a, b) => a.evalN - b.evalN)[0]?.data || null;
  // train best: seed==best ⇒ same; else the latest skip-0 eval whose genome id == bestId
  let trainBest = null;
  if (bestId && bestId !== seedId) {
    const matches = trainEvals.filter((e) => e.data.genome === bestId).sort((a, b) => b.evalN - a.evalN);
    trainBest = matches[0]?.data || null;
  } else trainBest = trainSeed;

  // holdout files are named deterministically by run-gepa (tags holdout-seed / holdout-best)
  const holdoutSeed = byName('eval-holdout-seed.json');
  const holdoutBest = byName('eval-holdout-best.json') || holdoutSeed; // best===seed ⇒ run-gepa reuses seed

  return { trainSeed, trainBest, holdoutSeed, holdoutBest };
}

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const BENCH = join(HERE, '..');
  const args = process.argv.slice(2);
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));

  const host = argv('--host', 'ruvultra');
  const model = argv('--model', 'z-ai/glm-5.2');
  const slice = argv('--slice', argv('--manifest', 'advisor-medium-25.json'));
  const seedPath = rel(argv('--seed', 'gepa/seed-genome.json'));
  const trainFirst = +argv('--train-first', 12);
  const maxCost = +argv('--max-cost', 12);
  const dryRun = args.includes('--dry-run');
  const runId = argv('--run-id', `learn_${model}`.replace(/[^a-zA-Z0-9_]/g, '_'));
  const keyMeta = {
    vertical: argv('--vertical', 'code-repair'),
    language: argv('--language', 'python'),
    task_class: argv('--task-class', 'bug-fix'),
  };
  // pass-throughs to run-gepa
  const reflectionModel = argv('--reflection-model', 'anthropic/claude-sonnet-5');
  const maxCandidates = argv('--max-candidates', '15');
  const maxSteps = argv('--max-steps', '12');
  const concurrency = argv('--concurrency', '2');
  const perEvalCost = argv('--per-eval-max-cost', '3');
  // Gateway backend (ADR-210/204): forward --base-url + --api-key-env to run-gepa (→ evaluate-genome →
  // solve-advisor + the reflection call) so rollouts + reflection route through the meta-llm Completions
  // API (host-normalization + shared genome-prefix cache + central metering). Absent ⇒ OpenRouter-direct.
  const baseUrl = argv('--base-url', null);
  const apiKeyEnv = argv('--api-key-env', null);
  const keyEnvName = apiKeyEnv || 'OPENROUTER_API_KEY';

  const modelSlug = model.replace(/[^a-zA-Z0-9_-]/g, '_');
  const hostSlug = host.replace(/[^a-zA-Z0-9_-]/g, '_');
  const workDir = rel(argv('--work-dir', `gepa/runs/learn-${hostSlug}-${modelSlug}`));
  const runOut = rel(argv('--out', `gepa/runs/learn-result-${hostSlug}-${modelSlug}.json`));
  const reportOut = rel(argv('--report', `gepa/runs/promotion-report-${hostSlug}-${modelSlug}.json`));
  mkdirSync(workDir, { recursive: true });

  const seedGenome = JSON.parse(readFileSync(seedPath, 'utf8'));
  const seedId = seedGenome.meta?.id || basename(seedPath);

  // Base args are safe to echo (no key-named token). The --api-key-env pair is kept OUT of this
  // array so it never flows to a log; it's appended only for the real exec below.
  const gepaArgs = [
    '--no-warnings', join(HERE, 'run-gepa.mjs'),
    '--seed', seedPath, '--model', model, '--manifest', slice,
    '--train-first', String(trainFirst), '--reflection-model', reflectionModel,
    '--max-candidates', String(maxCandidates), '--max-cost', String(maxCost),
    '--max-steps', String(maxSteps), '--concurrency', String(concurrency),
    '--per-eval-max-cost', String(perEvalCost),
    // namespace the Docker run-ids per (host,model) so parallel learn runs on the same slice don't collide
    '--run-tag', `gepa_${hostSlug}_${modelSlug}`.slice(0, 48),
    ...(baseUrl ? ['--base-url', baseUrl] : []),
    '--work-dir', workDir, '--out', runOut,
  ];
  const keyEnvArgs = apiKeyEnv ? ['--api-key-env', apiKeyEnv] : [];

  if (dryRun) {
    console.error('[learn] DRY-RUN — no spend. Would execute:');
    // gepaArgs carries no key-named token; the --api-key-env value is shown as a constant placeholder.
    console.error(`  node ${gepaArgs.join(' ')}${apiKeyEnv ? ' --api-key-env <env>' : ''}`);
    console.error(`[learn] seed=${seedId} host=${host} model=${model} slice=${slice} trainFirst=${trainFirst} maxCost=$${maxCost}`);
    console.error(`[learn] report → ${reportOut}, key template → ${compositeKey({ host, model, ...keyMeta, genome_version: '<candidate>' })}`);
    return;
  }

  const KEY = (process.env[keyEnvName] || '').trim();
  if (!KEY) { console.error('FATAL: no API key (set OPENROUTER_API_KEY, or the env var named by --api-key-env)'); process.exit(1); }

  console.error(`[learn] host=${host} model=${model} slice=${slice} seed=${seedId} — launching GEPA (cap $${maxCost})${baseUrl ? ` via ${baseUrl}` : ''}`);
  execFileSync('node', [...gepaArgs, ...keyEnvArgs], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 8 * 3600 * 1000, env: { ...process.env, [keyEnvName]: KEY } });

  const run = JSON.parse(readFileSync(runOut, 'utf8'));
  const bestId = run.best;
  const arts = loadEvalArtifacts(workDir, { trainFirst, seedId, bestId });
  if (!arts.holdoutSeed) { console.error('[learn] FATAL: no holdout-seed eval artifact — cannot apply promotion rule'); process.exit(2); }

  const report = buildPromotionReport({
    host, model, slice, seedId, candId: bestId, genomeVersion: bestId,
    train: { seed: summarizeEval(arts.trainSeed), cand: arts.trainBest ? summarizeEval(arts.trainBest) : null },
    holdout: { seed: summarizeEval(arts.holdoutSeed), cand: arts.holdoutBest ? summarizeEval(arts.holdoutBest) : null },
    keyMeta, run,
  });

  writeFileSync(reportOut, JSON.stringify(report, null, 2));
  console.error(`[learn] VERDICT ${report.verdict.toUpperCase()} — ${report.reason}`);
  console.error(`[learn] key=${report.key}`);
  console.error(`[learn] report → ${reportOut}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
