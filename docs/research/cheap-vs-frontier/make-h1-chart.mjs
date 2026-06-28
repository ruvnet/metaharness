#!/usr/bin/env node
// Dependency-free SVG for the ADR-201 H1 knowledge-flattening pilot.
// Grouped bars per model: base (no-RAG) vs +dense-RAG (lexical) vs +dense-RAG (semantic),
// with 95% Wilson CI whiskers. Reads the two h1-report JSONs from the ruvector bench.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const BENCH = join(DIR, '../../../packages/darwin-mode/bench/ruvector/data');
const OUT = join(DIR, 'charts');
mkdirSync(OUT, { recursive: true });
const lex = JSON.parse(readFileSync(join(BENCH, 'h1-report.json'), 'utf8'));
const onx = JSON.parse(readFileSync(join(BENCH, 'h1-report-onnx.json'), 'utf8'));

const MODELS = lex.config.models;
const W = 860, H = 470, M = { t: 64, r: 210, b: 70, l: 56 };
const PW = W - M.l - M.r, PH = H - M.t - M.b;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const C = { base: '#6b7280', lex: '#dc2626', sem: '#2563eb', grid: '#e5e7eb', axis: '#374151', text: '#111827', sub: '#6b7280' };
const yMax = 0.35;
const sy = (v) => M.t + PH - (v / yMax) * PH;

let s = `<rect width="${W}" height="${H}" fill="white"/>`;
s += `<text x="${M.l}" y="26" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${C.text}">ADR-201 H1: dense-RAG does NOT flatten knowledge for cheap models (FRAMES, n=40)</text>`;
s += `<text x="${M.l}" y="46" font-family="system-ui,sans-serif" font-size="12" fill="${C.sub}">Strict-EM resolve, single-shot, reasoning-off. Whiskers = 95% Wilson CI. Δ = +dense − base (pp). H1 needs Δ_cheap&gt;Δ_frontier&gt;0 → not met in either retriever arm.</text>`;
// axes + y grid
s += `<line x1="${M.l}" y1="${M.t + PH}" x2="${M.l + PW}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
s += `<line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + PH}" stroke="${C.axis}" stroke-width="1.5"/>`;
for (let v = 0; v <= yMax + 1e-9; v += 0.05) { const y = sy(v); s += `<line x1="${M.l}" y1="${y}" x2="${M.l + PW}" y2="${y}" stroke="${C.grid}" stroke-width="1"/><text x="${M.l - 8}" y="${y + 4}" text-anchor="end" font-family="system-ui,sans-serif" font-size="11" fill="${C.sub}">${(v * 100).toFixed(0)}%</text>`; }
s += `<text transform="translate(16,${M.t + PH / 2}) rotate(-90)" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="${C.text}">resolve (strict EM)</text>`;

const groupW = PW / MODELS.length;
const bw = 46, gap = 14;
MODELS.forEach((m, gi) => {
  const cx = M.l + gi * groupW + groupW / 2;
  const sl = lex.summary[m], so = onx.summary[m];
  const bars = [
    { lab: 'base', p: sl.base.p, ci: sl.base.ci, color: C.base },
    { lab: '+dense (lexical)', p: sl.rag.p, ci: sl.rag.ci, color: C.lex },
    { lab: '+dense (semantic)', p: so.rag.p, ci: so.rag.ci, color: C.sem },
  ];
  const total = bars.length * bw + (bars.length - 1) * gap;
  let x = cx - total / 2;
  for (const b of bars) {
    const y = sy(b.p), h = M.t + PH - y;
    s += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${b.color}" opacity="0.88"/>`;
    // CI whisker
    const lo = sy(b.ci[0]), hi = sy(b.ci[1]), xm = x + bw / 2;
    s += `<line x1="${xm}" y1="${hi}" x2="${xm}" y2="${lo}" stroke="${C.axis}" stroke-width="1.4"/><line x1="${xm - 6}" y1="${hi}" x2="${xm + 6}" y2="${hi}" stroke="${C.axis}" stroke-width="1.4"/><line x1="${xm - 6}" y1="${lo}" x2="${xm + 6}" y2="${lo}" stroke="${C.axis}" stroke-width="1.4"/>`;
    s += `<text x="${xm}" y="${y - 6}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.text}">${(b.p * 100).toFixed(1)}</text>`;
    x += bw + gap;
  }
  const short = m.split('/')[1];
  const tier = short.includes('deepseek') ? 'cheap' : 'frontier';
  s += `<text x="${cx}" y="${M.t + PH + 20}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" font-weight="600" fill="${C.text}">${esc(short)}</text>`;
  s += `<text x="${cx}" y="${M.t + PH + 36}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">${tier} · Δlex ${(sl.delta * 100).toFixed(1)}pp · Δsem ${(so.delta * 100).toFixed(1)}pp</text>`;
});

// legend
const items = [['base (no-RAG, parametric)', C.base], ['+dense-RAG (lexical bigram)', C.lex], ['+dense-RAG (ONNX all-MiniLM)', C.sem]];
items.forEach((it, i) => { const y = M.t + 10 + i * 22, x = M.l + PW + 18; s += `<rect x="${x}" y="${y - 8}" width="12" height="12" fill="${it[1]}"/><text x="${x + 18}" y="${y + 2}" font-family="system-ui,sans-serif" font-size="11.5" fill="${C.text}">${esc(it[0])}</text>`; });
s += `<text x="${M.l + PW + 18}" y="${M.t + 92}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">Verdict: H1 NOT supported.</text>`;
s += `<text x="${M.l + PW + 18}" y="${M.t + 108}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">No Δ_cheap&gt;0 lift in either arm;</text>`;
s += `<text x="${M.l + PW + 18}" y="${M.t + 124}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">only frontier gpt-5.5 gains (+7.5pp,</text>`;
s += `<text x="${M.l + PW + 18}" y="${M.t + 140}" font-family="system-ui,sans-serif" font-size="10.5" fill="${C.sub}">CI incl. 0) under semantic RAG.</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
writeFileSync(join(OUT, '08-h1-knowledge-flattening.svg'), svg);
console.log('wrote charts/08-h1-knowledge-flattening.svg (' + svg.length + ' bytes)');
