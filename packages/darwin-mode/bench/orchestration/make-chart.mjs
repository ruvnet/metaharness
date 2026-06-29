// SPDX-License-Identifier: MIT
//
// make-chart.mjs — Pareto chart for the learned-router experiment.
// Reads runs/learned-eval.json, emits an SVG: x = $/task (log), y = resolve (EM).
// Static baselines = labeled points; learned V-sweep = a connected frontier line;
// oracle-per-question = a dashed upper-bound marker. Up-and-LEFT is better.
//
// Run: node --experimental-strip-types make-chart.mjs --in runs/learned-eval.json --out ../../../../docs/research/orchestration/charts/01-learned-vs-static.svg

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const IN = rel(argv('--in', 'runs/learned-eval.json'));
const OUT = rel(argv('--out', '../../../../docs/research/orchestration/charts/01-learned-vs-static.svg'));

const r = JSON.parse(readFileSync(IN, 'utf8'));
const W = 760, H = 480, M = { l: 70, r: 30, t: 50, b: 60 };
const plotW = W - M.l - M.r, plotH = H - M.t - M.b;

// data points
const learned = r.learned_sweep.map((p) => ({ x: p.cost_per_task_usd, y: p.resolve, label: `V=${p.V}` }));
const statics = Object.entries(r.static_baselines).map(([id, s]) => ({ x: s.cost_per_task_usd, y: s.resolve, label: id, name: s.label }));
const oracleUB = r.oracle_per_question_eval_upper_bound;

const allX = [...learned, ...statics].map((p) => p.x).filter((x) => x > 0);
const xmin = Math.min(...allX) * 0.7, xmax = Math.max(...allX) * 1.4;
const ymin = 0, ymax = Math.max(0.6, ...[...learned, ...statics].map((p) => p.y), oracleUB.resolve) * 1.1;
const lx = (x) => M.l + (Math.log10(Math.max(x, xmin)) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin)) * plotW;
const ly = (y) => M.t + plotH - (y - ymin) / (ymax - ymin) * plotH;

const xticks = [];
for (let e = Math.floor(Math.log10(xmin)); e <= Math.ceil(Math.log10(xmax)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= xmin && v <= xmax) xticks.push(v); }
const yticks = []; for (let y = 0; y <= ymax; y += 0.1) yticks.push(Math.round(y * 100) / 100);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="ui-sans-serif,system-ui,sans-serif">`;
svg += `<rect width="${W}" height="${H}" fill="#fff"/>`;
svg += `<text x="${W / 2}" y="26" text-anchor="middle" font-size="16" font-weight="700">Learned router vs static policies — FRAMES (eval n=${r.split.eval_n}, train n=${r.split.train_n})</text>`;
svg += `<text x="${W / 2}" y="42" text-anchor="middle" font-size="11" fill="#666">resolve (GAIA-EM) vs cost; learned line incl. probe tax. Up-and-left = better $/correct.</text>`;
// grid + axes
for (const xv of xticks) { const x = lx(xv); svg += `<line x1="${x}" y1="${M.t}" x2="${x}" y2="${M.t + plotH}" stroke="#eee"/><text x="${x}" y="${M.t + plotH + 16}" text-anchor="middle" font-size="10" fill="#444">$${xv < 0.01 ? xv.toFixed(3) : xv.toFixed(2)}</text>`; }
for (const yv of yticks) { const y = ly(yv); svg += `<line x1="${M.l}" y1="${y}" x2="${M.l + plotW}" y2="${y}" stroke="#eee"/><text x="${M.l - 8}" y="${y + 3}" text-anchor="end" font-size="10" fill="#444">${yv.toFixed(1)}</text>`; }
svg += `<text x="${M.l + plotW / 2}" y="${H - 14}" text-anchor="middle" font-size="12" fill="#222">$ / task (log scale)</text>`;
svg += `<text x="18" y="${M.t + plotH / 2}" text-anchor="middle" font-size="12" fill="#222" transform="rotate(-90 18 ${M.t + plotH / 2})">resolve (exact-match)</text>`;
// oracle UB line
const oy = ly(oracleUB.resolve);
svg += `<line x1="${M.l}" y1="${oy}" x2="${M.l + plotW}" y2="${oy}" stroke="#16a34a" stroke-dasharray="6 4" stroke-width="1.5"/><text x="${M.l + plotW - 4}" y="${oy - 5}" text-anchor="end" font-size="10" fill="#16a34a">per-question oracle UB ${oracleUB.resolve}</text>`;
// learned frontier line
const sorted = learned.slice().sort((a, b) => a.x - b.x);
svg += `<polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="${sorted.map((p) => `${lx(p.x)},${ly(p.y)}`).join(' ')}"/>`;
for (const p of sorted) { svg += `<circle cx="${lx(p.x)}" cy="${ly(p.y)}" r="4" fill="#2563eb"/>`; }
// label the cheapest & dearest learned point
svg += `<text x="${lx(sorted[0].x)}" y="${ly(sorted[0].y) + 16}" font-size="9" fill="#2563eb">${sorted[0].label}</text>`;
svg += `<text x="${lx(sorted[sorted.length - 1].x)}" y="${ly(sorted[sorted.length - 1].y) - 8}" font-size="9" fill="#2563eb">${sorted[sorted.length - 1].label}</text>`;
// static points
const colors = { A: '#ea580c', B: '#9333ea', C: '#0891b2', D: '#dc2626' };
for (const s of statics) { const x = lx(s.x), y = ly(s.y); svg += `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" fill="${colors[s.label] || '#333'}"/><text x="${x + 9}" y="${y + 4}" font-size="11" font-weight="700" fill="${colors[s.label] || '#333'}">${s.label}</text>`; }
// legend
let lyy = M.t + 12;
svg += `<text x="${M.l + 12}" y="${lyy}" font-size="11" font-weight="700">●</text><text x="${M.l + 26}" y="${lyy}" font-size="11" fill="#2563eb">learned router (V-sweep)</text>`;
lyy += 16;
for (const s of statics) { svg += `<rect x="${M.l + 12}" y="${lyy - 9}" width="9" height="9" fill="${colors[s.label]}"/><text x="${M.l + 26}" y="${lyy}" font-size="10" fill="#333">${s.label} = ${esc(s.name)}</text>`; lyy += 14; }
svg += `</svg>`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.error(`chart → ${OUT}`);
