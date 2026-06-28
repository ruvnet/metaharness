#!/usr/bin/env node
// Dependency-free SVG for the ruvector SemanticRouter cost-Pareto pilot.
// Scatter: $/task (log-x) vs resolve% (strict EM), with 95% Wilson CI whiskers.
// Points: always-cheap, always-frontier, ORACLE router (perfect difficulty), and
// the ruvector router @maxF1 (which collapses onto always-frontier — no signal).
// Reads packages/darwin-mode/bench/ruvector/data/router-pilot-results.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const BENCH = join(DIR, '../../../packages/darwin-mode/bench/ruvector/data');
const OUT = join(DIR, 'charts');
mkdirSync(OUT, { recursive: true });
const R = JSON.parse(readFileSync(join(BENCH, 'router-pilot-results.json'), 'utf8'));
const P = R.cost_pareto;

const W = 880, H = 500, M = { t: 70, r: 230, b: 72, l: 64 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = { cheap: '#16a34a', front: '#dc2626', oracle: '#2563eb', router: '#a855f7', grid: '#e5e7eb', axis: '#374151', text: '#111827', sub: '#6b7280' };

// log-x over $/task
const xmin = 0.015, xmax = 0.40;
const lx = (v) => M.l + (Math.log10(v) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin)) * PW;
const ymin = 0.35, ymax = 0.58;
const ly = (v) => M.t + PH - (v - ymin) / (ymax - ymin) * PH;

let s = `<rect width="${W}" height="${H}" fill="white"/>`;
s += `<text x="${M.l}" y="28" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${C.text}">ruvector SemanticRouter cost-Pareto — FRAMES n=${R.config.n} (deepseek-v4-pro ↔ gpt-5.2)</text>`;
s += `<text x="${M.l}" y="48" font-family="system-ui,sans-serif" font-size="12" fill="${C.sub}">Strict-EM resolve vs $/task (log). Whiskers = 95% Wilson CI. Labels from solve outcomes ($0). Router difficulty AUC=${R.routing_separation.knn_exemplar_auc.toFixed(2)} (≈chance) → no usable signal.</text>`;

// axes
s += `<line x1="${M.l}" y1="${M.t + PH}" x2="${M.l + PW}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
s += `<line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
for (let v = 0.35; v <= ymax + 1e-9; v += 0.05) { const y = ly(v); s += `<line x1="${M.l}" y1="${y}" x2="${M.l + PW}" y2="${y}" stroke="${C.grid}" stroke-width="1"/><text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">${(v * 100).toFixed(0)}%</text>`; }
for (const v of [0.02, 0.05, 0.1, 0.2, 0.4]) { const x = lx(v); s += `<line x1="${x}" y1="${M.t}" x2="${x}" y2="${M.t + PH}" stroke="${C.grid}" stroke-width="1"/><text x="${x}" y="${M.t + PH + 20}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">$${v.toFixed(2)}</text>`; }
s += `<text x="${M.l + PW / 2}" y="${H - 16}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">cost $/task (log scale)</text>`;
s += `<text transform="translate(18,${M.t + PH / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">resolve (strict EM)</text>`;

const pts = [
  { name: 'always-cheap', p: P.always_cheap, color: C.cheap },
  { name: 'always-frontier', p: P.always_frontier, color: C.front },
  { name: 'ORACLE router (perfect)', p: P.oracle_router, color: C.oracle },
  { name: 'ruvector router @maxF1', p: P.router_maxF1_pure, color: C.router },
];
// "Pareto frontier" guide line cheap → oracle
s += `<line x1="${lx(P.always_cheap.cost_per_task)}" y1="${ly(P.always_cheap.acc)}" x2="${lx(P.oracle_router.cost_per_task)}" y2="${ly(P.oracle_router.acc)}" stroke="${C.oracle}" stroke-width="1.2" stroke-dasharray="5 4" opacity="0.5"/>`;

for (const pt of pts) {
  const x = lx(pt.p.cost_per_task), y = ly(pt.p.acc);
  const lo = ly(pt.p.ci[0]), hi = ly(pt.p.ci[1]);
  s += `<line x1="${x}" y1="${hi}" x2="${x}" y2="${lo}" stroke="${pt.color}" stroke-width="1.3" opacity="0.7"/>`;
  // router collapses onto frontier — offset its marker slightly so both show
  const dx = pt.name.startsWith('ruvector') ? 9 : 0, dy = pt.name.startsWith('ruvector') ? -9 : 0;
  s += `<circle cx="${x + dx}" cy="${y + dy}" r="7" fill="${pt.color}" stroke="white" stroke-width="1.5"/>`;
}

// legend
let lyy = M.t + 6;
s += `<text x="${M.l + PW + 22}" y="${lyy}" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${C.text}">Strategy ($/task · resolve)</text>`;
lyy += 22;
for (const pt of pts) {
  s += `<circle cx="${M.l + PW + 30}" cy="${lyy - 4}" r="6" fill="${pt.color}"/>`;
  s += `<text x="${M.l + PW + 44}" y="${lyy}" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.text}">${esc(pt.name)}</text>`;
  lyy += 16;
  s += `<text x="${M.l + PW + 44}" y="${lyy}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">$${pt.p.cost_per_task.toFixed(4)} · ${(pt.p.acc * 100).toFixed(1)}% · up=${(pt.p.route_up_rate * 100).toFixed(0)}%</text>`;
  lyy += 24;
}
lyy += 6;
const lines = [
  'Finding: always-cheap already',
  'matches frontier EM at ~5× lower',
  '$/task. A PERFECT router adds',
  '+10pp (union ceiling) — but the',
  'embedding cannot predict which',
  '15/150 are "hard" (AUC≈chance),',
  'so the real router collapses onto',
  'always-frontier. No Pareto gain.',
];
for (const t of lines) { s += `<text x="${M.l + PW + 22}" y="${lyy}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">${esc(t)}</text>`; lyy += 14; }

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif">${s}</svg>`;
writeFileSync(join(OUT, '09-router-cost-pareto.svg'), svg);
console.error(`wrote ${join(OUT, '09-router-cost-pareto.svg')}`);
