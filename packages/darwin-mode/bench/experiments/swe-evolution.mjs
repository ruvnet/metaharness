// SPDX-License-Identifier: MIT
//
// ADR-119 (multi-domain dynamic capstone): does evolution lift the real-LLM
// real-test pass-rate across a MULTI-DOMAIN suite? Ties ADR-110 (single-task
// window evolution) and ADR-118 (multi-domain generalization) together. Five real
// bugs (intervals/slugify/gcd/chunk/query), each buried behind 35 same-term
// distractors so the BASELINE contextBuilder window (30) misses it → baseline
// fails. A real evolutionary loop (real DeterministicMutator) evolves the
// contextBuilder; each variant is scored by the REAL surface→(cached real LLM
// fix)→real test pipeline over all 5 tasks. The LLM fix per bug is constant →
// cached → ≤ 5 real calls total.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) \
//   node --experimental-strip-types --no-warnings bench/experiments/swe-evolution.mjs

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { createChildVariant, DeterministicMutator } from '../../dist/mutator.js';

const model = 'google/gemini-2.5-flash';
const key = (process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

// Real bugs; buggy file buried behind same-term distractors so window gates it.
const TASKS = [
  { id: 'intervals', term: 'intervals', buggy: 'intervals.js', code: `export function merge(iv){const xs=[...iv].sort((a,b)=>a[0]-b[0]);const o=[];for(const [s,e] of xs){const l=o[o.length-1];if(l&&s<l[1]){l[1]=Math.max(l[1],e);}else o.push([s,e]);}return o;}\n`, test: `import {merge} from './intervals.js';import a from 'node:assert';a.deepStrictEqual(merge([[1,4],[4,5]]),[[1,5]]);console.log('PASS');\n` },
  { id: 'slugify', term: 'slug', buggy: 'slug.js', code: `export function slug(s){return s.toLowerCase().replace(/[^a-z0-9]+/g,'-');}\n`, test: `import {slug} from './slug.js';import a from 'node:assert';a.strictEqual(slug('Hello, World!'),'hello-world');console.log('PASS');\n` },
  { id: 'gcd', term: 'gcd', buggy: 'gcd.js', code: `export function gcd(a,b){while(b){[a,b]=[b,a%b];}return a;}\n`, test: `import {gcd} from './gcd.js';import a from 'node:assert';a.strictEqual(gcd(-12,8),4);console.log('PASS');\n` },
  { id: 'chunk', term: 'chunk', buggy: 'chunk.js', code: `export function chunk(arr,n){const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;}\n`, test: `import {chunk} from './chunk.js';import a from 'node:assert';a.deepStrictEqual(chunk([1,2,3],0),[[1,2,3]]);console.log('PASS');\n` },
  { id: 'query', term: 'query', buggy: 'query.js', code: `export function parse(q){const o={};for(const p of q.split('&')){const [k,v]=p.split('=');o[k]=v;}return o;}\n`, test: `import {parse} from './query.js';import a from 'node:assert';a.deepStrictEqual(parse('flag'),{flag:''});console.log('PASS');\n` },
];
const BURY = 35;
function makeRepo(task) {
  const r = mkdtempSync(join(tmpdir(), `sweev-${task.id}-`));
  const files = [];
  for (let i = 0; i < BURY; i++) { const f = `${task.term}_${i}.js`; writeFileSync(join(r, f), `export const k${i}=${i};\n`); files.push(f); }
  writeFileSync(join(r, task.buggy), task.code); files.push(task.buggy); // buried at rank ~BURY
  writeFileSync(join(r, 'test.mjs'), task.test);
  return { dir: r, files };
}
function runTest(dir) { try { execFileSync(process.execPath, ['test.mjs'], { cwd: dir, timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch { return false; } }

const fixCache = new Map();
let llmCalls = 0;
async function fixFor(task, dir) {
  if (fixCache.has(task.id)) return fixCache.get(task.id);
  const code = readFileSync(join(dir, task.buggy), 'utf8');
  const prompt = `Fix ${task.buggy} so its test passes. Return ONLY the corrected full file, no fences.\n--- ${task.buggy} ---\n${code}\n--- test.mjs ---\n${task.test}\n`;
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 800, temperature: 0.1 }) });
  const j = await res.json(); llmCalls++;
  let f = j.choices?.[0]?.message?.content ?? ''; const m = f.match(/```(?:[a-z]*)\n([\s\S]*?)\n```/i); if (m) f = m[1];
  f = f.trim() + '\n'; fixCache.set(task.id, f); return f;
}
async function score(variantDir) {
  const ctxb = await import(`${variantDir}/context_builder.ts`);
  let solved = 0;
  for (const task of TASKS) {
    const repo = makeRepo(task);
    const selected = (ctxb.buildContext(`fix ${task.term}`, repo.files) ?? []).map((c) => c.path);
    if (!selected.includes(task.buggy)) continue;            // surface must surface the buried file
    writeFileSync(join(repo.dir, task.buggy), await fixFor(task, repo.dir)); // cached real LLM fix
    if (runTest(repo.dir)) solved++;
  }
  return solved;
}

const prof = await profileRepo(makeRepo(TASKS[0]).dir);
const wr = mkdtempSync(join(tmpdir(), 'sweev-wr-'));
const baseline = await generateBaselineHarness(prof, wr);
let best = { v: baseline, s: await score(baseline.dir) };
const traj = [`gen0:${best.s}/5`];
const mut = new DeterministicMutator(7);
for (let gen = 1; gen <= 6; gen++) {
  let gb = best;
  for (let i = 0; i < 5; i++) {
    const child = await createChildVariant(best.v, wr, gen, i, mut, 7, { repoSummary: '', parentScore: 0, failedTraces: [] });
    const s = await score(child.dir);
    if (s > gb.s) gb = { v: child, s };
  }
  best = gb; traj.push(`gen${gen}:${best.s}/5`);
}
const win = (readFileSync(join(best.v.dir, 'context_builder.ts'), 'utf8').match(/slice\(0, (\d+)\)/) || [])[1];
console.log(JSON.stringify({ model, llmCalls, trajectory: traj, finalSolved: `${best.s}/5`, finalContextWindow: win }, null, 2));
