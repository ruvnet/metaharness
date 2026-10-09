// Report building and the human summary for run-darwin.mjs.
import { isFiniteCard } from './run-budget.mjs';
import { confirmationPower } from './confirm.mjs';

export const scoreOf = s => s && { primary: s.primary, noopRate: s.noopRate, costPerWin: s.costPerWin, regressed: s.regressed,
  ...(s.evaluatorError ? { evaluatorError: s.evaluatorError } : {}) };

export function lineage(byId, id) {
  const path = [];
  for (let cur = byId.get(id); cur && !path.includes(cur.variant.id); cur = byId.get(cur.variant.parentId ?? '')) path.unshift(cur.variant.id);
  return path;
}

export function rankRecords(records) {
  return records.map((r, i) => ({ r, i }))
    .filter(({ r }) => r.score && !r.score.regressed && isFiniteCard(r.score))
    .sort((a, b) => b.r.score.primary - a.r.score.primary || a.i - b.i)
    .map(({ r }) => r);
}

export function childRows(records, byId) {
  return records.filter(r => r.variant.parentId !== null).map(r => {
    const parent = byId.get(r.variant.parentId);
    const param = r.variant.mutatedParams[0] ?? null;
    const delta = r.score && parent?.score && isFiniteCard(r.score) && isFiniteCard(parent.score)
      ? r.score.primary - parent.score.primary : null;
    return { id: r.variant.id, parentId: r.variant.parentId, generation: r.variant.generation, param,
      from: param ? parent?.variant.genome[param] : null, to: param ? r.variant.genome[param] : null,
      score: scoreOf(r.score), primaryDeltaVsParent: delta };
  });
}

/** Confirmation section: fresh-seed scores, paired-evidence tally and whether the gate's e-value can even reach 1/alpha. */
export function confirmationSection(c, evaluated, { alpha = 0.05, lambda = 0.5 } = {}) {
  if (!c || c.status === 'skipped') return c ?? { status: 'skipped', reason: 'not run' };
  const pairs = c.pairs ?? [];
  const tally = { total: pairs.length, informative: pairs.filter(p => p.candidateWon !== p.baselineWon).length,
    candidateWins: pairs.filter(p => p.candidateWon && !p.baselineWon).length,
    baselineWins: pairs.filter(p => p.baselineWon && !p.candidateWon).length };
  const power = (candidateBudget) => confirmationPower({ changedCells: c.changedFamilies.length, attempts: c.attempts, alpha, lambda, candidateBudget });
  return { status: c.status, reason: c.reason ?? null, seedBase: c.seedBase, attempts: c.attempts, changedFamilies: c.changedFamilies,
    baseline: scoreOf(c.baseline), winner: scoreOf(c.winner), primaryDelta: c.primaryDelta ?? null, pairs: tally,
    power: { atCandidateBudgetEvaluated: { candidateBudget: evaluated, ...power(evaluated) }, atCandidateBudget1: { candidateBudget: 1, ...power(1) } } };
}

const fmt = s => (s && Number.isFinite(s.primary)
  ? `primary ${s.primary.toFixed(4)} noop ${s.noopRate.toFixed(3)} cost/signal ${s.costPerWin.toFixed(1)}` : `failed (${s?.evaluatorError ?? 'no score'})`);

export function summarize(report) {
  const b = report.budget;
  const c = report.confirmation;
  const pw = c?.power?.atCandidateBudgetEvaluated;
  const lines = [
    `darwin [${report.mode}]: ${report.config.generations} generation(s), ${report.evaluated} candidates scored, ` +
      `${b.refusedEvaluations} refused by run budget, ${b.evaluatorRefusedEvaluations ?? 0} refused by evaluator, ` +
      `runner calls charged ${b.reservedNewCells}/${b.maxTotalNewCells}` +
      (b.reportedRunnerCalls === null ? '' : ` (evaluator ran ${b.reportedRunnerCalls})`),
    `search: seed base ${report.selection.seedBase}, ${report.selection.attempts} attempts/cell` +
      (report.selection.baselineRunnerCalls ? `, baseline cost ${report.selection.baselineRunnerCalls} runner calls` : ''),
    `baseline: ${fmt(report.baseline?.score)}`,
    ...(report.aborted ? [`ABORTED: ${report.aborted.slice(0, 400)} (no winner files written; children were not run; full reason in the report)`] : []),
    report.winner ? `search winner ${report.winner.variantId}: ${fmt(report.winner.score)} ` +
      `(${report.winner.improvedOverBaseline ? 'beats baseline on SEARCH data (selection-biased)' : 'no improvement over baseline'}) lineage ${report.winner.lineage.join(' > ')}`
      : 'winner: none (no non-regressed scorecard)',
    ...report.children.map(ch => `  ${ch.id} <- ${ch.parentId}: ${ch.param} ${ch.from} -> ${ch.to}  ${fmt(ch.score)}` +
      (ch.primaryDeltaVsParent === null ? '' : ` (Δ ${ch.primaryDeltaVsParent >= 0 ? '+' : ''}${ch.primaryDeltaVsParent.toFixed(4)})`)),
    c?.status === 'measured'
      ? `confirmation (fresh seeds ${c.seedBase}, ${c.attempts} attempts): baseline ${fmt(c.baseline)} | winner ${fmt(c.winner)} | ` +
        `paired blocks ${c.pairs.total} (candidate ${c.pairs.candidateWins} : baseline ${c.pairs.baselineWins})`
      : `confirmation: ${c?.status ?? 'skipped'}${c?.reason ? ` (${c.reason})` : ''}`,
    ...(pw && !pw.reachable ? [`NOTE: at candidate budget ${pw.candidateBudget} the gate needs ${pw.blocksNeeded} net winning blocks; ` +
      `${c.changedFamilies.length} changed cell(s) x ${c.attempts / 4} blocks cannot reach it. Use --confirm-attempts ` +
      `${Math.min(64, pw.attemptsPerChangedCellNeeded)}${pw.attemptsPerChangedCellNeeded > 64 ? ' (max; still short)' : ''} or gate with an explicit, justified --candidate-budget.`] : []),
    ...(report.engineWinnerId !== (report.winner?.variantId ?? null)
      ? [`WARNING: engine reports/winner.json names ${report.engineWinnerId} (archive.best ignores regressed); ` +
        'use reports/winner-genome.json (non-regressed, finite only)'] : []),
    `one-param invariant: ${report.oneParamInvariant.ok ? 'ok' : 'VIOLATED'}`,
    ...(report.gateCommand ? [`gate: ${report.gateCommand}`] : []),
    `report: ${report.files.run}`,
  ];
  if (report.evidence !== 'evaluator_scorecards') lines.push(`NOTE: ${report.evidence} — not evidence about the real model or arena.`);
  return lines.join('\n');
}
