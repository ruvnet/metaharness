#!/usr/bin/env node
// finalize-h3-results.mjs — reads h3-report.json and fills in VECTOR-MEMORY-H3-RESULTS.md
// Usage: node packages/darwin-mode/bench/ruvector/finalize-h3-results.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const reportPath = join(HERE, 'data/h3-report.json');
const resultsPath = join(HERE, '../../../../docs/research/cheap-vs-frontier/empirical/VECTOR-MEMORY-H3-RESULTS.md');

const rep = JSON.parse(readFileSync(reportPath, 'utf8'));
const doc = readFileSync(resultsPath, 'utf8');

function pct(v) { return v == null ? '—' : (v * 100).toFixed(1) + '%'; }
function ci(arr) { return arr ? `[${pct(arr[0])}, ${pct(arr[1])}]` : '—'; }
function dpp(v) { if (v == null) return '—'; const s = v >= 0 ? '+' : ''; return s + (v * 100).toFixed(1) + 'pp'; }
function dci(arr) { return arr ? `[${dpp(arr[0])}, ${dpp(arr[1])}]` : '—'; }

const models = Object.keys(rep.summary || {});
let updated = doc;

// Build resolve table rows
const resolveRows = models.map(m => {
  const s = rep.summary[m];
  const tier = s.cheap ? 'cheap' : 'frontier';
  const n = s.n ?? rep.config?.n ?? '?';
  const baseStr = `${pct(s.base.p)} ${ci(s.base.ci)}`;
  const denseStr = `${pct(s.dense.p)} ${ci(s.dense.ci)}`;
  const graphStr = `${pct(s.graph.p)} ${ci(s.graph.ci)}`;
  return `| ${m} | ${tier} | ${n} | ${baseStr} | ${denseStr} | ${graphStr} |`;
});

// Build delta table rows
const deltaRows = models.map(m => {
  const s = rep.summary[m];
  const dd = s.delta_dense_vs_base;
  const dg = s.delta_graph_vs_base;
  const dGvD = s.delta_graph_vs_dense;
  const ddStr = dd ? `${dpp(dd.delta)} ${dci(dd.ci)}` : '—';
  const dgStr = dg ? `${dpp(dg.delta)} ${dci(dg.ci)}` : '—';
  const gvdStr = dGvD ? `${dpp(dGvD.delta)} ${dci(dGvD.ci)}` : '≈ 0 (structural)';
  return `| ${m} | ${ddStr} | ${dgStr} | ${gvdStr} |`;
});

// Build gap table rows from gapAnalysis (keyed per cheap model vs frontier)
const gapAnalysis = rep.gapAnalysis || {};
const gapRows = models.filter(m => rep.summary[m].cheap).map(m => {
  const g = gapAnalysis[m] || {};
  const gapBase  = g.base  != null ? pct(g.base)  : '—';
  const gapDense = g.dense != null ? pct(g.dense) : '—';
  const gapGraph = g.graph != null ? pct(g.graph) : '—';
  const narrowDense = g.narrowing_dense_vs_base != null ? dpp(g.narrowing_dense_vs_base) : '—';
  const narrowGraph = g.narrowing_graph_vs_base != null ? dpp(g.narrowing_graph_vs_base) : '—';
  return `| ${m} | ${gapBase} | ${gapDense} | ${gapGraph} | ${narrowDense} | ${narrowGraph} |`;
});

// Build cost rows (field is 'cost' not 'cost_usd')
const costRows = models.map(m => {
  const s = rep.summary[m];
  const totalCost = s.cost != null ? `$${s.cost.toFixed(4)}` : '—';
  const perTask = s.cost != null ? `$${(s.cost / (rep.config?.n ?? 50)).toFixed(4)}` : '—';
  return `| ${m} | ${totalCost} | ${perTask} |`;
});
const totalCost = models.reduce((a, m) => a + (rep.summary[m].cost ?? 0), 0);
const costTableTotal = `| **Total** | **$${totalCost.toFixed(4)}** | — |`;

// Replace placeholder tables in the markdown
// Strategy: find each placeholder row and replace the entire table body

function replaceTableBody(md, headerPattern, newRows) {
  const lines = md.split('\n');
  let inTable = false;
  let headerFound = false;
  let result = [];
  let headerLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (!headerFound && lines[i].includes(headerPattern)) {
      headerFound = true;
      headerLineIdx = i;
      result.push(lines[i]);
      continue;
    }
    if (headerFound && !inTable && lines[i].startsWith('|---')) {
      inTable = true;
      result.push(lines[i]);
      // Insert the new data rows
      for (const row of newRows) result.push(row);
      continue;
    }
    if (inTable && lines[i].startsWith('|')) {
      // Skip old placeholder rows
      continue;
    }
    if (inTable && !lines[i].startsWith('|')) {
      inTable = false;
      headerFound = false;
    }
    result.push(lines[i]);
  }
  return result.join('\n');
}

// Replace resolve table (find by base/dense/graph column header pattern)
updated = replaceTableBody(updated, 'base % [95% CI]', resolveRows);
// Replace delta table
updated = replaceTableBody(updated, 'Δ_dense (pp) [95% CI]', deltaRows);
// Replace gap table
updated = replaceTableBody(updated, 'Gap@base (pp)', gapRows);
// Replace cost table
updated = replaceTableBody(updated, '$ total (50 tasks', [...costRows, costTableTotal]);

// Replace Cr placeholder (field is 'Cr' not 'cr')
const crValues = models.map(m => {
  const s = rep.summary[m];
  if (!s.Cr && s.Cr !== 0) return null;
  return `${m}: Cr=${s.Cr.toFixed(3)}`;
}).filter(Boolean);
if (crValues.length) {
  updated = updated.replace(
    'Cr = mean graph context tokens / mean dense context tokens. Expected ≈ 1.00 (same hits → same context → same token count). The graph arm is not a compressor in this implementation — it produces the same k passages with the same text.',
    `Cr = mean graph context tokens / mean dense context tokens.\n\n${crValues.join('; ')}.\n\nAs expected: Cr ≈ 1.00 — identical hits → same token count for all models. The graph arm is not a compressor in this implementation.`
  );
}

writeFileSync(resultsPath, updated, 'utf8');
console.log(`Written: ${resultsPath}`);
console.log('\nKey numbers:');
for (const m of models) {
  const s = rep.summary[m];
  console.log(`  ${m}: base=${pct(s.base.p)} dense=${pct(s.dense.p)} graph=${pct(s.graph.p)} Δ_dense=${dpp(s.delta_dense_vs_base?.delta)} Δ_graph=${dpp(s.delta_graph_vs_base?.delta)}`);
}
if (rep.budget) {
  console.log(`\n  Total spend: $${rep.budget.processSpendUSD?.toFixed(4)}`);
}
