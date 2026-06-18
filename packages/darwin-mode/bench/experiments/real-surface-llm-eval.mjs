// SPDX-License-Identifier: MIT
//
// ADR-098 nucleus (toward SWE-bench): a variant's REAL contextBuilder surface
// selects which files a REAL LLM gets to see, and a REAL test is the verdict.
// This closes the loop ADR-106 (real surface code) + ADR-107 (real LLM + real
// test) were missing between: here the surface's output actually GATES the LLM's
// success on a real bug. Bounded to ~2 calls (~$0.003).
//
// Run with the strip-types flag so it can import the variant's .ts surfaces:
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types bench/experiments/real-surface-llm-eval.mjs [model]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';

const model = process.argv[2] || 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

// A real buggy module + real test (touching-interval merge bug), placed among
// many same-overlap distractor files so it survives into the contextBuilder
// window only if the window is wide enough.
const BUGGY = `export function merge(intervals){const xs=[...intervals].sort((a,b)=>a[0]-b[0]);const out=[];for(const [s,e] of xs){const last=out[out.length-1];if(last&&s<last[1]){last[1]=Math.max(last[1],e);}else out.push([s,e]);}return out;}\n`;
const TEST = `import { merge } from './merge_intervals.js'; import assert from 'node:assert';
assert.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]],'touching must merge'); console.log('PASS');\n`;

function makeRepo() {
  const r = mkdtempSync(join(tmpdir(), 'rsl-'));
  mkdirSync(join(r, 'src'), { recursive: true });
  writeFileSync(join(r, 'package.json'), '{"name":"x","version":"1.0.0"}');
  // 40 same-term distractors, then the buggy file at rank ~40.
  const files = [];
  for (let i = 0; i < 40; i++) { const f = `src/merge_intervals_${i}.ts`; writeFileSync(join(r, f), `export const k${i}=${i};\n`); files.push(f); }
  writeFileSync(join(r, 'merge_intervals.js'), BUGGY); // at root, where test.mjs imports it
  files.push('merge_intervals.js');
  writeFileSync(join(r, 'test.mjs'), TEST);
  return { dir: r, files, buggy: 'merge_intervals.js' };
}

function runTest(dir) {
  try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return { pass: true, output: 'PASS' }; }
  catch (e) { return { pass: false, output: (e.stderr?.toString() || e.message || '').split('\n').slice(0, 3).join(' | ').slice(0, 240) }; }
}

async function llmFix(buggyCode, testSrc) {
  const prompt = `merge_intervals.js fails the test below. Fix the file so the test passes. Return ONLY the corrected full contents of merge_intervals.js — no fences, no prose.\n--- merge_intervals.js ---\n${buggyCode}\n--- test.mjs (currently failing) ---\n${testSrc}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.1 }),
  });
  const j = await res.json();
  let fix = j.choices?.[0]?.message?.content ?? '';
  const m = fix.match(/```(?:[a-z]*)\n([\s\S]*?)\n```/i); if (m) fix = m[1];
  return { fix: fix.trim() + '\n', cost: j.usage?.cost ?? null, tokens: j.usage?.total_tokens ?? null };
}

// Evaluate one variant: its REAL contextBuilder picks the files the LLM sees.
async function evalVariant(variantDir, label, repo) {
  const ctxb = await import(`${variantDir}/context_builder.ts`);
  const selected = (ctxb.buildContext('fix merge intervals', repo.files) ?? []).map((c) => c.path);
  const sees = selected.includes(repo.buggy);
  // The agent can only fix what its contextBuilder surfaced.
  if (!sees) return { label, sawBug: false, fixed: false, note: 'contextBuilder did not surface the buggy file → LLM never sees it' };
  const before = runTest(repo.dir); // confirm it fails first
  const r = await llmFix(readFileSync(join(repo.dir, repo.buggy), 'utf8'), readFileSync(join(repo.dir, 'test.mjs'), 'utf8'));
  writeFileSync(join(repo.dir, repo.buggy), r.fix);
  const after = runTest(repo.dir);
  return { label, sawBug: true, fixed: after.pass, cost: r.cost, tokens: r.tokens };
}

// Baseline harness (real surfaces). Build a narrow-window and wide-window copy.
const prof = await profileRepo(makeRepo().dir);
const wr = mkdtempSync(join(tmpdir(), 'rsl-wr-'));
const base = await generateBaselineHarness(prof, wr);
function windowed(id, w) { const d = join(wr, 'variants', id); cpSync(base.dir, d, { recursive: true }); const cb = readFileSync(join(d, 'context_builder.ts'), 'utf8'); writeFileSync(join(d, 'context_builder.ts'), cb.replace('.slice(0, 30)', `.slice(0, ${w})`)); return d; }
const narrowDir = windowed('narrow', 10);
const wideDir = windowed('wide', 60);

const out = [];
out.push(await evalVariant(narrowDir, 'narrow-window(10)', makeRepo()));
out.push(await evalVariant(wideDir, 'wide-window(60)', makeRepo()));
console.log(JSON.stringify({ model, results: out }, null, 2));
