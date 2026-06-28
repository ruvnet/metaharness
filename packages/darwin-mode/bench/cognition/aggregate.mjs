// SPDX-License-Identifier: MIT
//
// aggregate.mjs — turn the A/B/C results JSONs into the report table + ASCII chart + the
// honest verdict line. Reads runs/results-{A,B,C,ABC}.json; prints markdown to stdout.
//
// Run: node packages/darwin-mode/bench/cognition/aggregate.mjs runs

import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || 'runs';
const D = isAbsolute(dir) ? dir : join(HERE, dir);
const read = (f) => (existsSync(join(D, f)) ? JSON.parse(readFileSync(join(D, f), 'utf8')) : null);

const A = read('results-A.json');
const B = read('results-B.json');
const C = read('results-C.json');
const ABC = read('results-ABC.json');

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const ci = (a) => (a ? `[${(a[0] * 100).toFixed(1)}, ${(a[1] * 100).toFixed(1)}]` : 'n/a');
const usd = (x) => (x == null ? 'n/a' : '$' + Number(x).toFixed(4));
const pp = (x) => (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + 'pp';

const rows = [];
if (A) rows.push(['A — baseline (cold single)', A.n, `${A.correct}/${A.n}`, pct(A.acc), ci(A.ci), pct(A.empty_rate), usd(A.cost_per_task), '— (reference)']);
if (B) {
  rows.push([`B — parallel-selves K=${B.verifier.K} (verifier-judge)`, B.verifier.n, `${B.verifier.correct}/${B.verifier.n}`, pct(B.verifier.acc), ci(B.verifier.ci), pct(B.verifier.empty_rate), usd(B.verifier.cost_per_task), A ? pp(B.verifier.acc - A.acc) : '—']);
  rows.push([`B — parallel-selves K=${B.majority.K} (majority-vote)`, B.majority.n, `${B.majority.correct}/${B.majority.n}`, pct(B.majority.acc), ci(B.majority.ci), pct(B.majority.empty_rate), usd(B.majority.cost_per_task), A ? pp(B.majority.acc - A.acc) : '—']);
}
let cG0, cGL;
if (C && C.curve && C.curve.length) {
  cG0 = C.curve[0]; cGL = C.curve[C.curve.length - 1];
  rows.push([`C — evolved gen0 best`, C.n, `${Math.round(cG0.best_acc * C.n)}/${C.n}`, pct(cG0.best_acc), ci(cG0.best_ci), '—', usd(cG0.best_cost_per_task), A ? pp(cG0.best_acc - A.acc) : '—']);
  rows.push([`C — evolved gen${cGL.gen} best`, C.n, `${Math.round(cGL.best_acc * C.n)}/${C.n}`, pct(cGL.best_acc), ci(cGL.best_ci), '—', usd(cGL.best_cost_per_task), A ? pp(cGL.best_acc - A.acc) : '—']);
}

console.log('| Condition | n | correct | resolve | Wilson 95% CI | empty | $/task | lift vs A |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log('| ' + r.join(' | ') + ' |');

// ── ASCII chart (resolve %, 0–70% scale) ──
console.log('\n```');
console.log('FRAMES resolve (deepseek-v4-pro, n=' + (A?.n ?? '?') + ', seed 42, reasoning OFF)');
const bar = (label, acc) => {
  const w = Math.round((acc || 0) * 60);
  console.log(label.padEnd(26) + '│' + '█'.repeat(w) + ' '.repeat(Math.max(0, 60 - w)) + ' ' + pct(acc));
};
if (A) bar('A baseline', A.acc);
if (B) { bar('B selves (verifier)', B.verifier.acc); bar('B selves (majority)', B.majority.acc); }
if (cG0) bar('C evolved gen0', cG0.best_acc);
if (cGL) bar('C evolved gen' + cGL.gen, cGL.best_acc);
console.log('                          └' + '─'.repeat(60) + '> 100%');
console.log('```');

// ── per-generation curve ──
if (C && C.curve) {
  console.log('\nCondition C per-generation curve:');
  console.log('| gen | evaluated | best resolve | best CI | gen-mean | best $/task | best genome |');
  console.log('|---|---|---|---|---|---|---|');
  for (const g of C.curve) console.log(`| ${g.gen} | ${g.evaluated} | ${pct(g.best_acc)} | ${ci(g.best_ci)} | ${pct(g.mean_acc)} | ${usd(g.best_cost_per_task)} | \`${g.best_key}\` |`);
}

// ── verdict numbers ──
console.log('\n--- VERDICT INPUTS ---');
if (A && B) {
  console.log(`B−A (verifier): ${pp(B.verifier.acc - A.acc)}  |  B−A (majority): ${pp(B.majority.acc - A.acc)}`);
  const eqDollarTasksA = (B.verifier.cost_per_task / (A.cost_per_task || 1));
  console.log(`B costs ${eqDollarTasksA.toFixed(1)}× per task vs A.`);
}
if (cG0 && cGL) console.log(`C gen0→gen${cGL.gen} best: ${pp(cGL.best_acc - cG0.best_acc)}`);
if (ABC) console.log(`Run spend: $${ABC.run_cost_usd}  | cache ${ABC.cache_stats?.hits}h/${ABC.cache_stats?.misses}m | halted=${ABC.halted} ${ABC.haltReason || ''}`);
