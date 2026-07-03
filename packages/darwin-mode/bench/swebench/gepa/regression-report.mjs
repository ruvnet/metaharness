// SPDX-License-Identifier: MIT
//
// ADR-228 §5.4 (coordinator directive 1) — the MUTATION-LESSON report. For every candidate the pilot
// evaluated, diff it against the FROZEN SEED baseline (directive 2: the seed is authoritative until a
// candidate clears holdout — never let a partial candidate redefine the baseline) and emit a
// regression report:
//   { candidate, target, seed_score, candidate_score, gold_seed, gold_candidate,
//     regressed_instances[], improved_instances[], failure_modes{...}, mutation_diff, decision, lesson }
//
// The LESSON is the point: it gives GEPA memory of what NOT to do without promoting bad policy — the
// ASI-as-gradient mechanism (gepa-loop.mjs threads accepted lessons into subsequent reflection
// prompts via `priorLessons`). Failure modes are derived from the per-instance score PARTS + the ASI
// feedback text the evaluator already persisted (gepa/runs/eval-*.json) — $0, no re-run.
//
// Usage ($0):
//   node gepa/regression-report.mjs --runs-dir gepa/runs [--log gepa/runs/pilot.log] \
//     [--pilot gepa/pilot-result.json] --out gepa/runs/regression-report.json

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── pure, $0-testable ─────────────────────────────────────────────────────────────────────────────

/** Derive the failure-mode flags for one instance from its score PARTS and/or ASI feedback text.
 * Robust to feedback-only input (run-gepa's live entries carry feedbacks but not details.parts):
 * the penalty names printed in makeFeedback's "penalties: …" line are read as a fallback. */
export function failureModesForInstance(parts = {}, feedback = '') {
  const fb = String(feedback || '');
  const penalty = (name) => (parts[name] ?? 0) < 0 || new RegExp(`penalties:[^\\n]*\\b${name}\\b`).test(fb);
  return {
    empty_patch: penalty('emptyPatch'),
    wrong_file: /never read it|failure class 1 \(/.test(fb),          // gold file never touched (class 1)
    test_not_run: penalty('noTestsRun'),
    thrash: penalty('repeatedReads') || /repeated-action warnings/.test(fb),
    bad_submit: penalty('testFileEdits'),                             // edited a test file to force a pass
    protocol_error: /\bmalformed turns\b/.test(fb),                   // noop/unparseable tool calls
  };
}

/** Aggregate failure-mode counts across a candidate's instances (only over regressed instances by default). */
export function aggregateFailureModes(details = {}, feedbacks = {}, onlyIds = null) {
  const modes = { empty_patch: 0, wrong_file: 0, test_not_run: 0, thrash: 0, bad_submit: 0, protocol_error: 0 };
  for (const [id, d] of Object.entries(details)) {
    if (onlyIds && !onlyIds.includes(id)) continue;
    const fm = failureModesForInstance(d.parts || {}, feedbacks[id] || '');
    for (const k of Object.keys(modes)) if (fm[k]) modes[k]++;
  }
  return modes;
}

/** Compose the one-line mutation LESSON from a candidate's diff vs seed (directive 1's takeaway). */
export function deriveLesson({ target, decision, goldSeed, goldCand, regressed, improved, seedModes, candModes }) {
  if (decision === 'accepted' && goldCand > goldSeed) return `mutating ${target} raised gold ${goldSeed}→${goldCand} (improved ${improved.length}, regressed ${regressed.length}) — KEEP direction.`;
  if (decision === 'accepted') return `mutating ${target} held gold at ${goldCand} but improved shaping on ${improved.length} instances — neutral-positive, low confidence.`;
  // rejected → find the dominant new failure mode the mutation introduced
  const worsened = Object.keys(candModes).filter((k) => candModes[k] > (seedModes[k] || 0)).sort((a, b) => (candModes[b] - (seedModes[b] || 0)) - (candModes[a] - (seedModes[a] || 0)));
  const top = worsened[0];
  const detail = top ? `increased ${top} ${seedModes[top] || 0}→${candModes[top]}` : `dropped gold ${goldSeed}→${goldCand}`;
  return `AVOID: mutating ${target} ${detail} (regressed ${regressed.length} instances, gold ${goldSeed}→${goldCand}) — this rewrite direction hurts; do not repeat.`;
}

/** Build the full report from loaded eval records + genome files + a decision map. */
export function buildRegressionReport({ seedEval, candidateEvals, genomes = {}, decisions = {} }) {
  const seedScores = seedEval.scores || {};
  const seedDetails = seedEval.details || {};
  const seedFeedbacks = seedEval.feedbacks || {};
  const baseline = { id: seedEval.genome, gold: seedEval.goldResolved, sum: seedEval.sumScore, n: seedEval.n, frozen: true };

  const reports = candidateEvals.map((ev) => {
    const ids = Object.keys(ev.scores || {});
    const regressed = ids.filter((id) => (ev.scores[id] ?? 0) < (seedScores[id] ?? 0));
    const improved = ids.filter((id) => (ev.scores[id] ?? 0) > (seedScores[id] ?? 0));
    const target = genomes[ev.genome]?.meta?.mutated ?? '(unknown)';
    const parent = genomes[ev.genome]?.meta?.parent ?? null;
    const before = genomes[baseline.id]?.components?.[target];
    const after = genomes[ev.genome]?.components?.[target];
    const decision = decisions[ev.genome] ?? 'unknown';
    const seedModes = aggregateFailureModes(seedDetails, seedFeedbacks);
    const candModes = aggregateFailureModes(ev.details || {}, ev.feedbacks || {});
    const regressedModes = aggregateFailureModes(ev.details || {}, ev.feedbacks || {}, regressed);
    const lesson = deriveLesson({ target, decision, goldSeed: seedEval.goldResolved, goldCand: ev.goldResolved, regressed, improved, seedModes, candModes });
    return {
      candidate: ev.genome, parent, target, decision,
      seed_score: seedEval.sumScore, candidate_score: ev.sumScore,
      gold_seed: seedEval.goldResolved, gold_candidate: ev.goldResolved,
      cost: ev.cost,
      regressed_instances: regressed, improved_instances: improved,
      failure_modes: candModes, failure_modes_on_regressed: regressedModes, seed_failure_modes: seedModes,
      mutation_diff: (before != null || after != null) ? { component: target, before, after } : null,
      lesson,
    };
  });
  return { baseline, candidates: reports, lessons: reports.map((r) => r.lesson) };
}

/** Parse accept/reject decisions from a pilot.log tail (fallback when pilot-result.json isn't written yet). */
export function decisionsFromLog(logText) {
  const decisions = {};
  for (const m of String(logText).matchAll(/\[gepa\] (accepted|rejected): (\{.*\})/g)) {
    try { const o = JSON.parse(m[2]); if (o.id) decisions[o.id] = m[1]; } catch { /**/ }
  }
  return decisions;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const BENCH = join(HERE, '..');
  const args = process.argv.slice(2);
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));
  const J = (p) => JSON.parse(readFileSync(p, 'utf8'));

  const runsDir = rel(argv('--runs-dir', 'gepa/runs'));
  const out = rel(argv('--out', 'gepa/runs/regression-report.json'));
  const evalFiles = readdirSync(runsDir).filter((f) => /^eval-\d+-.*\.json$/.test(f)).sort();
  if (!evalFiles.length) { console.error(`no eval-*.json in ${runsDir}`); process.exit(1); }
  const evals = evalFiles.map((f) => J(join(runsDir, f)));
  const seedEval = evals.find((e) => /seed/.test(e.genome)) || evals[0];
  const candidateEvals = evals.filter((e) => e !== seedEval);

  const genomes = {};
  for (const f of readdirSync(runsDir).filter((f) => /^genome-\d+-.*\.json$/.test(f))) {
    try { const g = J(join(runsDir, f)); genomes[g.meta?.id] = g; } catch { /**/ }
  }

  let decisions = {};
  const pilotPath = argv('--pilot', 'gepa/pilot-result.json');
  if (existsSync(rel(pilotPath))) {
    try { for (const h of J(rel(pilotPath)).history || []) if (['accepted', 'pareto-added', 'discarded'].includes(h.event)) decisions[h.id] = h.event === 'accepted' ? 'accepted' : 'rejected'; } catch { /**/ }
  }
  const logPath = argv('--log', 'gepa/runs/pilot.log');
  if (Object.keys(decisions).length === 0 && existsSync(rel(logPath))) decisions = decisionsFromLog(readFileSync(rel(logPath), 'utf8'));

  const report = buildRegressionReport({ seedEval, candidateEvals, genomes, decisions });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), seedFrozenBaseline: report.baseline, ...report }, null, 2));
  console.error(`REGRESSION REPORT — baseline (FROZEN) ${report.baseline.id}: gold ${report.baseline.gold}/${report.baseline.n} sum ${report.baseline.sum}`);
  for (const c of report.candidates) console.error(`  ${c.candidate} [${c.target}] ${c.decision}: gold ${c.gold_seed}→${c.gold_candidate}, regressed ${c.regressed_instances.length}, improved ${c.improved_instances.length}\n    lesson: ${c.lesson}`);
  console.error(`→ ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
