#!/usr/bin/env node
// Dependency-free SVG for the ADR-201 H3-code paid localization ablation.
// Grouped bars: per cheap model, dense-cosine vs graph-topology gold-hit@3 with 95% Wilson CI.
// Plus a set-recall annotation (gold present in the arm's K-file set). Reads
// packages/darwin-mode/bench/ruvector/data/h3-code-localize-report.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const BENCH = join(DIR, '../../../packages/darwin-mode/bench/ruvector/data');
const OUT = join(DIR, 'charts');
mkdirSync(OUT, { recursive: true });
const R = JSON.parse(readFileSync(join(BENCH, 'h3-code-localize-report.json'), 'utf8'));

const W = 880, H = 470, M = { t: 78, r: 250, b: 64, l: 60 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = { dense: '#2563eb', graph: '#a855f7', grid: '#e5e7eb', axis: '#374151', text: '#111827', sub: '#6b7280' };
const ymax = 1.0;
const ly = (v) => M.t + PH - (v / ymax) * PH;

let s = `<rect width="${W}" height="${H}" fill="white"/>`;
s += `<text x="${M.l}" y="28" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${C.text}">ADR-201 H3-code: cheap-model gold-file localization — dense cosine vs graph topology</text>`;
s += `<text x="${M.l}" y="48" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.sub}">SWE-rebench Python repos n=${R.n}, K=${R.kCtx} candidate files/arm. dense=top-K cosine; graph=kHop+PageRank topology (NO cosine).</text>`;
s += `<text x="${M.l}" y="64" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.sub}">gold-hit@3 = model's top-3 picks include the gold patch file. Whiskers = 95% Wilson CI. reasoning disabled, $${R.cost_usd}.</text>`;

// y grid
s += `<line x1="${M.l}" y1="${M.t + PH}" x2="${M.l + PW}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
for (let v = 0; v <= 1.0001; v += 0.25) { const y = ly(v); s += `<line x1="${M.l}" y1="${y}" x2="${M.l + PW}" y2="${y}" stroke="${C.grid}" stroke-width="1"/><text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">${(v * 100).toFixed(0)}%</text>`; }
s += `<text transform="translate(16,${M.t + PH / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">gold-hit@3 (localization)</text>`;

const models = R.models;
const groupW = PW / models.length;
const barW = 52, gap = 26;
models.forEach((m, gi) => {
  const p = R.perModel[m];
  const cx = M.l + gi * groupW + groupW / 2;
  const x0 = cx - barW - gap / 2, x1 = cx + gap / 2;
  const arms = [{ x: x0, c: C.dense, a: p.dense, name: 'dense' }, { x: x1, c: C.graph, a: p.graph, name: 'graph' }];
  for (const arm of arms) {
    const y = ly(arm.a.acc3), h = M.t + PH - y;
    s += `<rect x="${arm.x}" y="${y}" width="${barW}" height="${h}" fill="${arm.c}" opacity="0.85" rx="3"/>`;
    s += `<text x="${arm.x + barW / 2}" y="${y - 18}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${arm.c}">${(arm.a.acc3 * 100).toFixed(0)}%</text>`;
    // CI whisker
    const lo = ly(arm.a.ci3[0]), hi = ly(arm.a.ci3[1]);
    s += `<line x1="${arm.x + barW / 2}" y1="${hi}" x2="${arm.x + barW / 2}" y2="${lo}" stroke="${C.axis}" stroke-width="1.3"/>`;
    s += `<line x1="${arm.x + barW / 2 - 6}" y1="${hi}" x2="${arm.x + barW / 2 + 6}" y2="${hi}" stroke="${C.axis}" stroke-width="1.3"/>`;
    s += `<line x1="${arm.x + barW / 2 - 6}" y1="${lo}" x2="${arm.x + barW / 2 + 6}" y2="${lo}" stroke="${C.axis}" stroke-width="1.3"/>`;
    s += `<text x="${arm.x + barW / 2}" y="${M.t + PH + 16}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="${C.text}">${arm.name}</text>`;
  }
  s += `<text x="${cx}" y="${M.t + PH + 36}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11.5" font-weight="600" fill="${C.text}">${esc(m)}</text>`;
  s += `<text x="${cx}" y="${M.t + PH + 50}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" fill="${(p.deltaHit3_pp >= 0 ? '#16a34a' : '#dc2626')}">Δ=${p.deltaHit3_pp >= 0 ? '+' : ''}${p.deltaHit3_pp.toFixed(1)}pp (n.s.)</text>`;
});

// legend / takeaways
let yy = M.t + 4;
s += `<rect x="${M.l + PW + 22}" y="${yy - 2}" width="14" height="14" fill="${C.dense}" rx="2"/><text x="${M.l + PW + 42}" y="${yy + 10}" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">dense — top-K cosine over code</text>`;
yy += 24;
s += `<rect x="${M.l + PW + 22}" y="${yy - 2}" width="14" height="14" fill="${C.graph}" rx="2"/><text x="${M.l + PW + 42}" y="${yy + 10}" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">graph — kHop+PageRank topology</text>`;
yy += 30;
s += `<text x="${M.l + PW + 22}" y="${yy}" font-family="system-ui,sans-serif" font-size="12" font-weight="700" fill="${C.text}">set-recall (gold in K set)</text>`;
yy += 18;
s += `<text x="${M.l + PW + 22}" y="${yy}" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.sub}">dense ${(R.setRecall.denseAcc * 100).toFixed(0)}%  vs  graph ${(R.setRecall.graphAcc * 100).toFixed(0)}%</text>`;
yy += 26;
const lines = [
  'Gate ($0): graph TRAVERSED —',
  'graphHits>0 on 5/5 repos (the',
  'FRAMES structural null did NOT',
  'recur). BUT the "sparse" premise',
  'was FALSE: code is cosine-DENSE',
  '(median 0.48 > FRAMES 0.434).',
  '',
  'Paid: pure topology gives NO',
  'significant localization lift',
  '(Δ −6.9 / +3.4 pp, CIs overlap);',
  'lower recall + ~14% more tokens',
  '(Cr<0). Not a standalone win.',
];
for (const t of lines) { s += `<text x="${M.l + PW + 22}" y="${yy}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">${esc(t)}</text>`; yy += 13.5; }

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif">${s}</svg>`;
writeFileSync(join(OUT, '10-h3-code-localization.svg'), svg);
console.error(`wrote ${join(OUT, '10-h3-code-localization.svg')}`);
