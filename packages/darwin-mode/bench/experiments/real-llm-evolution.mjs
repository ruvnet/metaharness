// SPDX-License-Identifier: MIT
//
// Capstone (ADR-110, toward ADR-098): does EVOLUTION improve a real LLM's real-
// test pass-rate by evolving the harness? A mini evolution loop uses the REAL
// DeterministicMutator to mutate variants; each variant is scored by the REAL
// surface→real-LLM→real-test pipeline (ADR-109) over 3 tasks whose buggy file
// sits at increasing rank, so solving more requires a wider contextBuilder
// window. The LLM fix per bug is constant, so it is cached → ≤ 3 calls total.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/real-llm-evolution.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { createChildVariant, DeterministicMutator } from '../../dist/mutator.js';

const model = 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

const BUGGY = `export function merge(intervals){const xs=[...intervals].sort((a,b)=>a[0]-b[0]);const out=[];for(const [s,e] of xs){const last=out[out.length-1];if(last&&s<last[1]){last[1]=Math.max(last[1],e);}else out.push([s,e]);}return out;}\n`;
const TEST = `import { merge } from './merge_intervals.js'; import assert from 'node:assert';
assert.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]],'touching must merge'); console.log('PASS');\n`;
// 3 tasks: buggy file at ranks ~8 / 38 / 65 → need window > that to surface it.
const TASKS = [{ id: 't-near', before: 8 }, { id: 't-mid', before: 38 }, { id: 't-far', before: 65 }];

const fixCache = new Map(); // taskId → corrected merge_intervals.js (≤1 LLM call/task)
let llmCalls = 0;

async function getFix() {
  // The bug + test are identical across tasks, so one fix serves all.
  if (fixCache.has('merge')) return fixCache.get('merge');
  const prompt = `merge_intervals.js fails its test. Fix the file so the test passes. Return ONLY the corrected full contents, no fences.\n--- merge_intervals.js ---\n${BUGGY}\n--- test.mjs ---\n${TEST}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.1 }),
  });
  const j = await res.json(); llmCalls++;
  let fix = j.choices?.[0]?.message?.content ?? ''; const m = fix.match(/```(?:[a-z]*)\n([\s\S]*?)\n```/i); if (m) fix = m[1];
  fix = fix.trim() + '\n'; fixCache.set('merge', fix); return fix;
}

function repoFor(task) {
  const r = mkdtempSync(join(tmpdir(), 'rle-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  const files = [];
  for (let i = 0; i < task.before; i++) { const f = `src/merge_intervals_${i}.ts`; writeFileSync(join(r, f), `export const k${i}=${i};\n`); files.push(f); }
  writeFileSync(join(r, 'merge_intervals.js'), BUGGY); files.push('merge_intervals.js');
  writeFileSync(join(r, 'test.mjs'), TEST);
  return { dir: r, files, buggy: 'merge_intervals.js' };
}
function runTest(dir) { try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } }

// Score a variant: how many of the 3 tasks its REAL contextBuilder lets it solve.
async function score(variantDir) {
  const ctxb = await import(`${variantDir}/context_builder.ts`);
  let solved = 0;
  for (const task of TASKS) {
    const repo = repoFor(task);
    const selected = (ctxb.buildContext('fix merge intervals', repo.files) ?? []).map((c) => c.path);
    if (!selected.includes(repo.buggy)) continue; // surface didn't surface the bug
    writeFileSync(join(repo.dir, repo.buggy), await getFix());
    if (runTest(repo.dir)) solved++;
  }
  return solved;
}

// Mini evolution: mutate the best variant; keep whoever solves the most.
const prof = await profileRepo(repoFor(TASKS[0]).dir);
const wr = mkdtempSync(join(tmpdir(), 'rle-wr-'));
const baseline = await generateBaselineHarness(prof, wr);
let best = { variant: baseline, solved: await score(baseline.dir) };
const traj = [`gen0:${best.solved}/3`];
const mut = new DeterministicMutator(7);
for (let gen = 1; gen <= 6; gen++) {
  let genBest = best;
  for (let i = 0; i < 5; i++) {
    const child = await createChildVariant(best.variant, wr, gen, i, mut, 7, { repoSummary: '', parentScore: 0, failedTraces: [] });
    const s = await score(child.dir);
    if (s > genBest.solved) genBest = { variant: child, solved: s };
  }
  best = genBest;
  traj.push(`gen${gen}:${best.solved}/3`);
}
const finalWindow = (readFileSync(join(best.variant.dir, 'context_builder.ts'), 'utf8').match(/slice\(0, (\d+)\)/) || [])[1];
console.log(JSON.stringify({ model, llmCalls, trajectory: traj, finalSolved: `${best.solved}/3`, finalContextWindow: finalWindow }, null, 2));
