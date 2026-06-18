// SPDX-License-Identifier: MIT
//
// Completes the ADR-111 story (ADR-113). ADR-111 showed the contextBuilder's
// RANKING was irrelevant — but only because its distractors shared the buggy
// file's terms (flat overlap → ranking == input order). The realistic case is
// VARIED relevance. Here the buggy file has HIGH relevance but is BURIED at input
// position 50 among LOW-relevance distractors. A relevance ranker surfaces it
// even at a small window; a position-based (first-N) selector misses it. If so,
// ranking quality IS causal when relevance varies — refining ADR-111's flat-case
// finding into the complete picture. Zero LLM calls (deterministic fix).
//
// Run: node --experimental-strip-types --no-warnings bench/experiments/ranking-matters.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const BUGGY = `export function merge(intervals){const xs=[...intervals].sort((a,b)=>a[0]-b[0]);const out=[];for(const [s,e] of xs){const last=out[out.length-1];if(last&&s<last[1]){last[1]=Math.max(last[1],e);}else out.push([s,e]);}return out;}\n`;
const FIX = BUGGY.replace('s<last[1]', 's<=last[1]');
const TEST = `import { merge } from './merge_intervals.js'; import assert from 'node:assert';
assert.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]],'touching'); console.log('PASS');\n`;

// Buggy file (HIGH relevance to "fix merge intervals") buried at input index 50,
// behind 50 LOW-relevance distractors (no shared terms).
function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), 'rank-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  const files = [];
  for (let i = 0; i < 50; i++) { const f = `src/helper_${i}.ts`; writeFileSync(join(r, f), `export const h${i}=${i};\n`); files.push(f); }
  writeFileSync(join(r, 'merge_intervals.js'), BUGGY); files.push('merge_intervals.js'); // index 50, high relevance
  writeFileSync(join(r, 'test.mjs'), TEST);
  return { dir: r, files, buggy: 'merge_intervals.js' };
}
function testPasses(dir) { try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } }

const prof = await profileRepo(makeRepo().dir);
const wr = mkdtempSync(join(tmpdir(), 'rank-wr-'));
const base = await generateBaselineHarness(prof, wr);
const ctxbCache = new Map();
async function realCtxb(window) {
  if (!ctxbCache.has(window)) {
    const d = join(wr, 'variants', `w${window}`); cpSync(base.dir, d, { recursive: true });
    const src = readFileSync(join(d, 'context_builder.ts'), 'utf8');
    writeFileSync(join(d, 'context_builder.ts'), src.replace('.slice(0, 30)', `.slice(0, ${window})`));
    ctxbCache.set(window, await import(`${d}/context_builder.ts`));
  }
  return ctxbCache.get(window);
}
const selectors = {
  'real-contextBuilder (relevance ranking)': async (files, window) => (await realCtxb(window)).buildContext('fix merge intervals', files).map((c) => c.path),
  'first-N (position, no ranking)': async (files, window) => files.slice(0, window),
};
async function solves(selector, window) {
  const repo = makeRepo();
  const selected = await selector(repo.files, window);
  if (!selected.includes(repo.buggy)) return false;
  writeFileSync(join(repo.dir, repo.buggy), FIX);
  return testPasses(repo.dir);
}
const out = {};
for (const [name, sel] of Object.entries(selectors)) {
  out[name] = { 'window-10': await solves(sel, 10), 'window-30': await solves(sel, 30) };
}
console.log(JSON.stringify({
  question: 'When file relevance VARIES (buggy file buried but highly relevant), does contextBuilder RANKING matter?',
  setup: 'buggy file at input index 50 (high relevance) behind 50 low-relevance distractors',
  results: out,
}, null, 2));
