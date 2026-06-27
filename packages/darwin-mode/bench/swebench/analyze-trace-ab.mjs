#!/usr/bin/env node
// Analyze the trace-localize n=300 A/B (treatment) vs the §28/§47 control (51.3%).
// Produces BOTH the full-300 treatment-vs-51.3% number AND the §56-style MATCHED comparison
// (treatment vs control on the EXACT set of instances that actually received the Opus+trace
// treatment), so a budget-truncated escalation still yields a scientifically valid verdict.
//
// Usage: node analyze-trace-ab.mjs \
//   --out <treatment OUT dir with preds-cheap/preds-esc/preds-merged + gold report> \
//   --control /tmp/control-resolved.json   (saved: {resolved:[...], no_generation:[...]})
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = arg('--out', '/opt/darwin/out');
const CONTROL = arg('--control', '/tmp/control-resolved.json');
const TOTAL = +arg('--total', '300');

const jl = (p) => existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null;
const isEmpty = (p) => !((p.model_patch || p.patch || '').trim());

// Wilson 95% CI for a binomial proportion.
function wilson(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x) => (x * 100).toFixed(1);

// ── Control ground truth (per-instance) ──
const ctrl = JSON.parse(readFileSync(CONTROL, 'utf8'));
const ctrlResolved = new Set(ctrl.resolved);
const ctrlEmpty = new Set(ctrl.no_generation || []);
console.log(`CONTROL (§28/§47): ${ctrlResolved.size}/${TOTAL} = ${pct(ctrlResolved.size / TOTAL)}%  (no_generation=${ctrlEmpty.size})`);

// ── Treatment artifacts ──
const cheap = jl(`${OUT}/preds-cheap.jsonl`);
const esc = jl(`${OUT}/preds-esc.jsonl`);
const merged = jl(`${OUT}/preds-merged.jsonl`) || jl(`${OUT}/preds-single.jsonl`);
if (!merged) { console.error(`FATAL: no merged/single preds in ${OUT}`); process.exit(1); }

// Find the gold-eval report (swebench writes *<run_id>.json with resolved_ids).
let report = null;
for (const f of readdirSync(OUT)) {
  if (/\.json$/.test(f) && /darwin|report|results/i.test(f)) {
    try { const j = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8')); if (Array.isArray(j.resolved_ids)) { report = j; console.log(`treatment gold report: ${f}`); break; } } catch { /**/ }
  }
}
if (!report) { console.error('FATAL: no gold report with resolved_ids found in', OUT); process.exit(1); }
const txResolved = new Set(report.resolved_ids);

// ── Escalation / trace-fire accounting ──
// The set ACTUALLY escalated = GLM-empty in the treatment cheap base.
const glmEmpty = cheap ? new Set(cheap.filter(isEmpty).map((p) => p.instance_id)) : null;
// The set that actually got an Opus attempt this run = those present in preds-esc (truncation-aware:
// if ESCCOST/account-gate cut the escalation, only a prefix of glmEmpty appears here).
const escRows = esc || [];
const escIds = new Set(escRows.map((p) => p.instance_id));
const traceFired = escRows.filter((p) => p.traceLocalized === true).map((p) => p.instance_id);
const traceFireRate = escRows.length ? traceFired.length / escRows.length : 0;

console.log('\n── ESCALATION / TRACE-FIRE ──');
console.log(`GLM-empty (escalation candidates): ${glmEmpty ? glmEmpty.size : 'unknown (no preds-cheap)'}`);
console.log(`Opus actually attempted this run (preds-esc): ${escIds.size}`);
const truncated = glmEmpty ? escIds.size < glmEmpty.size : null;
console.log(`TRUNCATED escalation? ${truncated === null ? 'unknown' : truncated} ${truncated ? `(only ${escIds.size}/${glmEmpty.size} empties got Opus — budget/cap cut it)` : ''}`);
console.log(`trace-localize FIRED: ${traceFired.length}/${escIds.size} escalated = ${pct(traceFireRate)}%  (§56 fire-check)`);

// ── (1) Full-300 treatment vs 51.3% (VALID ONLY IF escalation completed) ──
const txFull = txResolved.size;
const [fl, fh] = wilson(txFull, TOTAL);
console.log('\n── (1) FULL-300 treatment ──');
console.log(`treatment: ${txFull}/${TOTAL} = ${pct(txFull / TOTAL)}%  [Wilson 95% CI ${pct(fl)}–${pct(fh)}]`);
console.log(`delta vs control 51.3%: ${(txFull / TOTAL * 100 - 51.3).toFixed(1)} pts (${txFull - ctrlResolved.size} instances)`);
if (truncated) console.log('  ⚠️  CONFOUNDED: escalation truncated — untreated empties count as fails. DO NOT use this as the verdict (coordinator §guard). Use the matched comparison below.');

// ── (2) MATCHED comparison on the actually-treated set (§56 methodology) ──
// S = instances that actually received the Opus+trace treatment this run (escIds).
// treatment resolve on S vs control resolve on the SAME ids.
const S = [...escIds];
const txOnS = S.filter((id) => txResolved.has(id)).length;
const ctrlOnS = S.filter((id) => ctrlResolved.has(id)).length;
const [ml, mh] = wilson(txOnS, S.length);
const [cl, ch] = wilson(ctrlOnS, S.length);
console.log('\n── (2) MATCHED comparison (the verdict-grade number, truncation-robust) ──');
console.log(`N = ${S.length} (instances that actually got Opus+trace this run)`);
console.log(`treatment (Opus+trace):  ${txOnS}/${S.length} = ${pct(txOnS / S.length)}%  [Wilson ${pct(ml)}–${pct(mh)}]`);
console.log(`control   (Opus only):   ${ctrlOnS}/${S.length} = ${pct(ctrlOnS / S.length)}%  [Wilson ${pct(cl)}–${pct(ch)}]`);
console.log(`MATCHED DELTA: ${txOnS - ctrlOnS} instances (${(txOnS / S.length * 100 - ctrlOnS / S.length * 100).toFixed(1)} pts on N=${S.length})`);
// Crack list: resolved by treatment but NOT by control, among the trace-fired set.
const cracks = S.filter((id) => txResolved.has(id) && !ctrlResolved.has(id));
const cracksTraced = cracks.filter((id) => traceFired.includes(id));
console.log(`cracks (tx-resolved & control-unresolved): [${cracks.join(', ') || 'none'}]`);
console.log(`  of which trace FIRED on: [${cracksTraced.join(', ') || 'none'}]`);
const regress = S.filter((id) => !txResolved.has(id) && ctrlResolved.has(id));
console.log(`regressions (control-resolved but tx-not): [${regress.join(', ') || 'none'}]`);

// ── verdict heuristic (honest) ──
console.log('\n── VERDICT INPUTS ──');
const fullBeyondCI = !truncated && fl > 0.513; // full-300 lower CI above 51.3
console.log(`full-300 lower CI (${pct(fl)}%) > 51.3%? ${fullBeyondCI}`);
console.log(`matched delta = +${txOnS - ctrlOnS} on N=${S.length}; matched CIs ${pct(ml)}-${pct(mh)} vs ${pct(cl)}-${pct(ch)} (overlap = within noise)`);
console.log(JSON.stringify({
  control_full: ctrlResolved.size, total: TOTAL,
  tx_full: txFull, tx_full_pct: +pct(txFull / TOTAL), tx_full_ci: [+pct(fl), +pct(fh)], delta_vs_513: +(txFull / TOTAL * 100 - 51.3).toFixed(1),
  escalated: escIds.size, glm_empty: glmEmpty ? glmEmpty.size : null, truncated,
  trace_fired: traceFired.length, trace_fire_rate: +pct(traceFireRate),
  matched_n: S.length, matched_tx: txOnS, matched_ctrl: ctrlOnS, matched_delta: txOnS - ctrlOnS,
  cracks, cracks_traced: cracksTraced, regressions: regress,
}, null, 0));
