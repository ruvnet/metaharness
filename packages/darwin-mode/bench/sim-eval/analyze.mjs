// SPDX-License-Identifier: MIT
//
// Pre-registered analysis for the #523 sealed SIM evaluation. Pure over the
// raw JSONL rows; `node analyze.mjs [resultsDir]` writes summary.json and
// prints markdown tables. Smoke rows and aborted rows are never analysed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, POISON_ARM, PRIMARY_CONTRASTS, TRANSFER_CONTRASTS } from './plan.mjs';
import { contrast, holm, quantile, ratioCi } from './stats.mjs';

export function loadRows(dir, phase) {
  const f = join(dir, `raw-${phase}.jsonl`);
  if (!existsSync(f)) return [];
  const rows = [];
  for (const r of readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
    if (r.supersededLane) { const drop = new Set(r.supersededLane); for (let i = rows.length - 1; i >= 0; i--) if (drop.has(rows[i].id)) rows.splice(i, 1); continue; }
    rows.push(r);
  }
  return rows;
}

/** Total real spend from the append-only ledger (all phases, incl. smoke/calib). */
export function ledgerSpend(dir) {
  const f = join(dir, 'spend-ledger.jsonl');
  if (!existsSync(f)) return { usd: 0, calls: 0 };
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { usd: rows.reduce((s, r) => s + r.chargedUsd, 0), calls: rows.length, unpriced: rows.filter((r) => r.reportedUsd === null).length };
}

const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) : 'n/a');
const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(4)}` : 'n/a');
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Jaccard overlap of SIM selections between two arms, paired by run and call index. */
function selectionOverlap(rows, armA, armB) {
  const key = (r) => `${r.model}|${r.bench}|${r.seed}`;
  const b = new Map(rows.filter((r) => r.arm === armB).map((r) => [key(r), r]));
  const js = [];
  for (const ra of rows.filter((r) => r.arm === armA)) {
    const rb = b.get(key(ra));
    if (!rb) continue;
    const n = Math.min(ra.sim.selections.length, rb.sim.selections.length);
    for (let i = 0; i < n; i++) {
      const A = new Set(ra.sim.selections[i]);
      const B = new Set(rb.sim.selections[i]);
      const inter = [...A].filter((x) => B.has(x)).length;
      const uni = new Set([...A, ...B]).size;
      if (uni > 0) js.push(inter / uni);
    }
  }
  return { meanJaccard: mean(js), comparisons: js.length };
}

/** Per-arm descriptive row. */
function armStats(rows, arm) {
  const rs = rows.filter((r) => r.arm === arm);
  const lat = rs.flatMap((r) => [r.proposer.p50LatencyMs]).filter(Number.isFinite);
  const proposals = rs.reduce((s, r) => s + r.candidates, 0);
  const perSolve = ratioCi(rs, (r) => r.proposer.costUsd, (r) => r.heldoutSolved);
  return {
    arm, runs: rs.length,
    heldout: mean(rs.map((r) => r.value)), winnerTrain: mean(rs.map((r) => r.winnerTrain)),
    costUsd: rs.reduce((s, r) => s + r.proposer.costUsd, 0), meanRunCostUsd: mean(rs.map((r) => r.proposer.costUsd)),
    usdPerHeldoutSolve: perSolve,
    promptTokensPerCall: rs.reduce((s, r) => s + r.proposer.promptTokens, 0) / Math.max(1, rs.reduce((s, r) => s + r.proposer.calls, 0)),
    simContextTokens: mean(rs.map((r) => r.sim.meanTokens)), simRecords: mean(rs.map((r) => r.sim.meanRecords)),
    retrieval: rs.reduce((m, r) => { for (const [k, v] of Object.entries(r.sim.retrieval)) m[k] = (m[k] ?? 0) + v; return m; }, {}),
    rvfUsedRuns: rs.filter((r) => r.rvf?.used).length,
    simSurfaceMatchRate: rs.reduce((s, r) => s + (r.proposer.simSurfaceMatch ?? 0), 0) / Math.max(1, rs.reduce((s, r) => s + r.proposer.withSimContext, 0)),
    p50LatencyMs: quantile(lat, 0.5), p95LatencyMs: quantile(rs.map((r) => r.proposer.p95LatencyMs), 0.95),
    proposals, failures: rs.reduce((s, r) => s + r.proposer.failures, 0), truncated: rs.reduce((s, r) => s + r.proposer.truncated, 0),
    validatorRejections: rs.reduce((s, r) => s + r.validatorRejections, 0),
    validatorRejectionRate: proposals ? rs.reduce((s, r) => s + r.validatorRejections, 0) / proposals : NaN,
    canaryRejections: rs.reduce((s, r) => s + r.canaryRejections, 0),
    disqualifiedTraces: rs.reduce((s, r) => s + r.disqualifiedTraces, 0),
    childErrorTraces: rs.reduce((s, r) => s + r.childErrorTraces, 0),
    effectiveSurfaceEdits: mean(rs.map((r) => r.effectiveSurfaceEdits)),
    noOps: rs.reduce((s, r) => s + r.noOps, 0),
  };
}

export function analyze(dir) {
  const target = loadRows(dir, 'target').filter((r) => !r.aborted);
  const aborted = loadRows(dir, 'target').filter((r) => r.aborted);
  const source = loadRows(dir, 'source').filter((r) => !r.aborted);
  const allArms = [...ARMS.map((a) => a.arm), POISON_ARM.arm];

  // Primary: two contrasts, Holm-adjusted p, Bonferroni (97.5%) CIs for the decision.
  const primary = PRIMARY_CONTRASTS.map(([a, c]) => contrast(target, a, c, { alpha: 0.05 / PRIMARY_CONTRASTS.length }));
  const adj = holm(primary.map((x) => x.p));
  primary.forEach((x, i) => { x.pHolm = adj[i]; x.ciLevel = 0.975; });

  const transfer = TRANSFER_CONTRASTS.map(([a, c]) => contrast(target, a, c));
  const negativeTransfer = transfer.filter((x) => x.verdict === 'negative').map((x) => `${x.arm} vs ${x.control}`);

  // Security: per-run validator-rejection rate vs off (paired), and the poison probe vs retr-in.
  const rejRate = (r) => (r.candidates ? r.validatorRejections / r.candidates : 0);
  const security = ['full-in', 'retr-in', 'full-xmodel', 'retr-xmodel', 'full-xbench', 'retr-xbench']
    .map((a) => ({ ...contrast(target, a, 'off', { value: rejRate }), metric: 'validatorRejectionRate' }));
  const poisonRows = target.filter((r) => r.model === target.find((x) => x.arm === 'retr-poison')?.model && r.bench === 'loc');
  const poison = {
    rejection: contrast(poisonRows, 'retr-poison', 'retr-in', { value: rejRate }),
    canary: contrast(poisonRows, 'retr-poison', 'retr-in', { value: (r) => r.canaryRejections }),
    heldout: contrast(poisonRows, 'retr-poison', 'retr-in'),
  };
  const securityRegression = security.filter((x) => x.lo > 0).map((x) => x.arm);

  const arms = allArms.map((a) => armStats(target, a)).filter((s) => s.runs > 0);
  const overlap = selectionOverlap(target, 'full-in', 'retr-in');
  const totals = {
    targetRuns: target.length, abortedRuns: aborted.length, sourceRuns: source.length,
    targetCostUsd: target.reduce((s, r) => s + r.proposer.costUsd, 0),
    sourceCostUsd: source.reduce((s, r) => s + r.proposer.costUsd, 0),
    ledger: ledgerSpend(dir),
  };
  const byCell = {};
  for (const r of target) {
    const k = `${r.model} / ${r.bench}`;
    byCell[k] ??= {};
    (byCell[k][r.arm] ??= []).push(r.value);
  }
  return { totals, primary, transfer, negativeTransfer, security, securityRegression, poison, arms, overlap, byCell, aborted };
}

export function markdown(s) {
  const L = [];
  L.push('### Primary contrasts (held-out solve rate, sealed partitions; 97.5% CIs, Holm p)', '');
  L.push('| contrast | pairs | estimate (pt) | 97.5% CI (pt) | p | p (Holm) | verdict |', '|---|---|---|---|---|---|---|');
  for (const x of s.primary) L.push(`| ${x.arm} − ${x.control} | ${x.pairs} | ${pct(x.estimate, 2)} | [${pct(x.lo, 2)}, ${pct(x.hi, 2)}] | ${x.p.toFixed(4)} | ${x.pHolm.toFixed(4)} | **${x.verdict}** |`);
  L.push('', '### Transfer contrasts (95% CIs)', '');
  L.push('| contrast | pairs | estimate (pt) | 95% CI (pt) | p | verdict |', '|---|---|---|---|---|---|');
  for (const x of s.transfer) L.push(`| ${x.arm} − ${x.control} | ${x.pairs} | ${pct(x.estimate, 2)} | [${pct(x.lo, 2)}, ${pct(x.hi, 2)}] | ${x.p.toFixed(4)} | ${x.verdict} |`);
  L.push('', '### Per-arm outcomes, cost and latency', '');
  L.push('| arm | runs | held-out % | winner train % | proposer USD | USD / held-out solve [95% CI] | prompt tok/call | SIM ctx tok | p50 / p95 call ms | effective edits/run |',
    '|---|---|---|---|---|---|---|---|---|---|');
  for (const a of s.arms) {
    const ps = a.usdPerHeldoutSolve;
    L.push(`| ${a.arm} | ${a.runs} | ${pct(a.heldout)} | ${pct(a.winnerTrain)} | ${usd(a.costUsd)} | ${usd(ps.estimate)} [${usd(ps.lo)}, ${usd(ps.hi)}] | ${Math.round(a.promptTokensPerCall)} | ${Math.round(a.simContextTokens)} | ${a.p50LatencyMs ?? 'n/a'} / ${a.p95LatencyMs ?? 'n/a'} | ${a.effectiveSurfaceEdits.toFixed(1)} |`);
  }
  L.push('', '### Safety', '');
  L.push('| arm | proposals | validator rejections | rate | canary rejections | disqualified traces | child errors | API failures | truncated |', '|---|---|---|---|---|---|---|---|---|');
  for (const a of s.arms) L.push(`| ${a.arm} | ${a.proposals} | ${a.validatorRejections} | ${pct(a.validatorRejectionRate, 2)}% | ${a.canaryRejections} | ${a.disqualifiedTraces} | ${a.childErrorTraces} | ${a.failures} | ${a.truncated} |`);
  L.push('', '| security contrast (rejection rate vs off) | estimate (pt) | 95% CI (pt) | p |', '|---|---|---|---|');
  for (const x of s.security) L.push(`| ${x.arm} | ${pct(x.estimate, 2)} | [${pct(x.lo, 2)}, ${pct(x.hi, 2)}] | ${x.p.toFixed(4)} |`);
  const p = s.poison;
  L.push('', `Poison probe (retr-poison − retr-in, ${p.rejection.pairs} pairs): rejection rate ${pct(p.rejection.estimate, 2)}pt [${pct(p.rejection.lo, 2)}, ${pct(p.rejection.hi, 2)}]; canary rejections/run ${p.canary.estimate.toFixed(2)} [${p.canary.lo.toFixed(2)}, ${p.canary.hi.toFixed(2)}]; held-out ${pct(p.heldout.estimate, 2)}pt [${pct(p.heldout.lo, 2)}, ${pct(p.heldout.hi, 2)}].`);
  L.push('', `SIM context holding a record for the surface being edited: ${s.arms.filter((a) => a.arm !== 'off').map((a) => `${a.arm} ${pct(a.simSurfaceMatchRate)}%`).join(', ')}.`);
  L.push('', `Manipulation check: full-in vs retr-in selected-record Jaccard ${s.overlap.meanJaccard.toFixed(3)} over ${s.overlap.comparisons} paired context calls.`);
  L.push('', '### Held-out by cell (mean %, n)', '');
  const arms = s.arms.map((a) => a.arm);
  L.push(`| cell | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
  for (const [cell, m] of Object.entries(s.byCell)) L.push(`| ${cell} | ${arms.map((a) => (m[a] ? `${pct(mean(m[a]))} (${m[a].length})` : '–')).join(' | ')} |`);
  return L.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? fileURLToPath(new URL('./results', import.meta.url)));
  const s = analyze(dir);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(s, null, 1) + '\n');
  console.log(markdown(s));
}
