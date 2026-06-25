// SPDX-License-Identifier: MIT
//
// ADR-153 (Stage C) — the AGENTIC solver. Wires the real fetchRepo / llm / evalOne / git to the
// unit-tested ReAct core in agentic-loop.mjs. Per instance: clone → run a bounded tool-driven loop
// (the model reads/greps/ls/edits and calls run_tests against the official Docker oracle until it
// submits or the step budget is hit) → write the resulting patch. Mirrors solve-repair.mjs's setup,
// flags, concurrency, fetch-retry, and per-instance cleanup; the difference is the loop, not the I/O.
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//   bench/swebench/solve-agentic.mjs --manifest full-300.json --max-steps 20 --concurrency 2 \
//   --model deepseek/deepseek-chat --out predictions-agentic-300.jsonl
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agenticSolve, chebTemp, buildAgenticSystem } from './agentic-loop.mjs';
import { runConformantTests } from './conformant-tests.mjs';
import { langProfile } from './lang-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const onlyInstance = argv('--instance', null);
const MAX_STEPS = +argv('--max-steps', 20);
const MODEL = argv('--model', 'deepseek/deepseek-chat');
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'predictions-agentic.jsonl'));
const REPORT = rel(argv('--report', 'solve-agentic-report.json'));
const VENV = '/tmp/swebench-venv';
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const CONCURRENCY = Math.max(1, +argv('--concurrency', 1));
// In-solver budget cap (see solve-repair.mjs). `--max-cost <usd>` stops pulling
// new instances once cumulative LLM cost reaches it; in-flight finish + write.
const MAX_COST = +argv('--max-cost', Infinity);
const TEMP = +argv('--temperature', 0); // Best-of-N diversity: run N trajectories at temp>0 to vary them
const CHEB_TEMP = process.argv.includes('--cheb-temp'); // PR#49/ADR-188: Chebyshev step-depth temp (hot→greedy)
const CHEB_HI = +argv('--cheb-hi', 0.8);                 // hot-end temperature for the schedule

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
if (onlyInstance) manifest = manifest.filter((i) => i.instance_id === onlyInstance);

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
// The validated search/replace primitive (shared shape with solve-repair.mjs: exact, then
// whitespace-normalized fuzzy match with indentation re-alignment).
function applyEdit(content, search, replace) {
  if (search.length && content.includes(search)) return content.replace(search, replace);
  const cl = content.split('\n'); const sl = search.split('\n');
  while (sl.length && sl[sl.length - 1].trim() === '') sl.pop();
  while (sl.length && sl[0].trim() === '') sl.shift();
  if (!sl.length) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + sl.length <= cl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) { if (norm(cl[i + j]) !== norm(sl[j])) { ok = false; break; } }
    if (!ok) continue;
    const indOf = (s) => (s.match(/^[ \t]*/) || [''])[0];
    const delta = indOf(cl[i]).length - indOf(sl[0]).length;
    const rl = replace.split('\n').map((line) => { if (!line.trim()) return line; if (delta >= 0) return ' '.repeat(delta) + line; const lead = indOf(line).length; return line.slice(Math.min(-delta, lead)); });
    return [...cl.slice(0, i), ...rl, ...cl.slice(i + sl.length)].join('\n');
  }
  return null;
}
function sleepSync(ms) { try { execSync(`sleep ${(ms / 1000).toFixed(1)}`); } catch { /**/ } }
function fetchRepo(repo, sha) {
  const work = mkdtempSync(join(tmpdir(), 'sbrepo-'));
  g(work, 'git init -q'); g(work, `git remote add origin https://github.com/${repo}.git`);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) sleepSync(3000 * 2 ** (attempt - 1));
    try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); last = null; break; }
    catch { try { g(work, 'git fetch --depth 200 origin -q'); g(work, `git checkout -q ${sha}`); last = null; break; } catch (e2) { last = e2; } }
  }
  if (last) throw last;
  g(work, 'git config user.email b@b'); g(work, 'git config user.name b'); g(work, 'git commit -qam base --allow-empty');
  return work;
}
function mkLlm(model) {
  return async function (prompt, system, temp) {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: 4096, temperature: (temp ?? TEMP) }) });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
const llm = mkLlm(MODEL);
// ADR-182 — cost cascade: cheap tier-1; escalate ONLY instances whose patch fails the repo's own tests
// (conformant gate). Tier-2 starts COLD (fresh work tree) to preserve trajectory diversity (the union ceiling).
const ESCALATE = argv('--cascade', null);
const llmEsc = ESCALATE ? mkLlm(ESCALATE) : null;
function evalOne(instanceId, patch, runId) {
  const preds = `/tmp/agentic-${runId}.jsonl`;
  writeFileSync(preds, JSON.stringify({ instance_id: instanceId, model_name_or_path: 'darwin-agentic', model_patch: patch }) + '\n');
  try { execSync(`. ${VENV}/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${preds} --instance_ids ${instanceId} --run_id ${runId} --max_workers 1 --cache_level instance --timeout 1200`, { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500000, maxBuffer: 1 << 28 }); } catch { /**/ }
  let resolved = false; try { const rep = JSON.parse(readFileSync(`/tmp/darwin-agentic.${runId}.json`, 'utf8')); resolved = (rep.resolved_ids || []).includes(instanceId); } catch { /**/ }
  let logTail = ''; try { const lp = `/tmp/logs/run_evaluation/${runId}/darwin-agentic/${instanceId}/test_output.txt`; if (existsSync(lp)) { const t = readFileSync(lp, 'utf8'); logTail = t.split('\n').filter((l) => /FAIL|Error|assert|Traceback|^E |raise |\.py:[0-9]/.test(l)).slice(-40).join('\n').slice(-2500); } } catch { /**/ }
  return { resolved, logTail };
}
// ADR-192: test-path guard is now language-aware (driven by the per-instance profile). Default
// stays Python so the bare module-level constant matches the prior behaviour.
const PY_PROFILE = langProfile({ lang: 'py' });
const isTestPath = (r) => PY_PROFILE.testPathRegex(r);

// ADR-173 — LEADERBOARD-CONFORMANT mode. `--no-test-oracle` forbids any in-loop
// call to the gold FAIL_TO_PASS harness; the agent's only feedback is the repo's
// OWN pre-existing tests (run in the work tree). The gold harness is used ONLY
// for the final, separate scoring (never seen during solving) — the rule the
// SWE-bench leaderboard requires. `usedOracleDuringSolve` is asserted false at
// the end as an automated leakage guard.
const NO_ORACLE = args.includes('--no-test-oracle');
let usedOracleDuringSolve = false;
// ADR-173 L0.5/L0.6 — conformant in-loop signal: run the EXISTING tests in the
// changed file's package, inside the instance Docker image (deps present), with
// the agent's SOURCE patch applied but NEVER the gold test patch. Robust rule:
// for a changed `a/b/c.py`, run the nearest `tests/` dir under the package root.
// ADR-192: changed-file extraction + test-target seeding are now driven by the per-instance
// profile (default Python). The diff-file regex accepts the language's source extensions; the
// seeded test paths follow the language's layout (py: tests/test_<mod>.py; js: <mod>.test.js /
// __tests__; go: <mod>_test.go; rust: tests/; java: src/test/...Test.java).
function existingTestTargets(diff, prof = PY_PROFILE) {
  const extAlt = prof.srcGlobs.map((g2) => g2.replace(/^\*\./, '').replace(/\./g, '\\.')).join('|');
  const re = new RegExp(`^\\+\\+\\+ b/(.+\\.(?:${extAlt}))$`, 'gm');
  const files = [...diff.matchAll(re)].map((m) => m[1]).filter((f) => !prof.testPathRegex(f));
  // SPECIFIC test file per changed module — NOT whole package tests/ dirs (sklearn-pytest storm, 2026-06-23).
  const targets = new Set();
  for (const f of files) for (const t of prof.testTargets(f)) targets.add(t);
  return [...targets].slice(0, 4);
}
function runRepoTests(instanceId, diff, prof = PY_PROFILE) {
  const targets = existingTestTargets(diff, prof);
  if (targets.length === 0) return { resolved: false, logTail: 'no source files changed yet — write a fix, then tests run' };
  const cmd = prof.testRunnerCmd(targets);
  const r = runConformantTests(instanceId, diff, cmd, { timeoutMs: 420000 });
  return { resolved: r.ran && r.passed, logTail: (r.ran ? '' : '[tests could not run] ') + r.logTail };
}

writeFileSync(OUT, ''); const report = []; let totalCost = 0;
// One agentic attempt in a FRESH work tree (cold). Returns {res, work}; caller cleans up.
async function solveTier(inst, llmFn) {
  const work = fetchRepo(inst.repo, inst.base_commit); let evalCount = 0;
  // ADR-192: resolve the per-instance language profile once (explicit inst.lang wins; else detect
  // from repo root). It drives the grep default glob, the test-path guard, the conformant test
  // runner, and the tool-call examples in the system prompt. Default degrades to Python.
  const prof = langProfile(inst, work);
  const defGlob = prof.srcGlobs[0];
  const io = {
    work, path: { join },
    readFile: (p) => readFileSync(p, 'utf8'),
    listDir: (p) => readdirSync(p, { withFileTypes: true }).map((d) => d.isDirectory() ? d.name + '/' : d.name),
    writeFile: (p, c) => writeFileSync(p, c),
    exists: (p) => existsSync(p),
    gitDiff: () => g(work, 'git diff').toString(),
    grepRepo: (pattern, glob) => { try { const gl = glob ? `-- '${glob}'` : `-- '${defGlob}'`; return g(work, `git grep -n -e ${JSON.stringify(pattern)} ${gl} | head -60 || true`).toString(); } catch { return ''; } },
    applyEdit, isTestPath: (r) => prof.testPathRegex(r),
    runTests: () => {
      if (NO_ORACLE) return runRepoTests(inst.instance_id, g(work, 'git diff').toString(), prof); // conformant gate
      usedOracleDuringSolve = true;
      return evalOne(inst.instance_id, g(work, 'git diff').toString(), `ag_${inst.instance_id}_${++evalCount}`.replace(/[^a-zA-Z0-9_]/g, '_'));
    },
    MAX_OUT: 4000,
  };
  const system = buildAgenticSystem(prof.exampleExt, defGlob);
  const res = await agenticSolve({ problem: inst.problem_statement, io, llm: llmFn, maxSteps: MAX_STEPS, system, tempSchedule: CHEB_TEMP ? ((s, n) => chebTemp(s, n, CHEB_HI)) : undefined });
  return { res, work };
}
// Cascade tie-break: neither tier passed the repo gate — judge picks the likelier fix (cheap, conformant).
async function judgePick(inst, pA, pB) {
  if (!pA.trim()) return pB; if (!pB.trim()) return pA;
  try { const { raw, cost } = await llm(`A GitHub issue and TWO candidate patches, neither verified by tests. Pick the one more likely to correctly fix it.\n\nISSUE:\n${String(inst.problem_statement).slice(0, 4000)}\n\nPATCH A:\n${pA.slice(0, 5000)}\n\nPATCH B:\n${pB.slice(0, 5000)}\n\nReply ONLY 'A' or 'B'.`); totalCost += cost; return /^\s*B/i.test(raw) ? pB : pA; } catch { return pA; }
}
async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, tier: 'T1', resolved: false };
  let patch = '';
  try {
    const { res, work } = await solveTier(inst, llm);
    patch = res.patch; totalCost += res.cost; row.steps = res.steps; row.submitted = res.submitted; row.resolvedInLoop = res.resolvedInLoop;
    try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
    if (ESCALATE && !res.resolvedInLoop) {                       // escalate ONLY the hard tail
      row.escalated = true;
      const { res: r2, work: w2 } = await solveTier(inst, llmEsc); // COLD tier-2
      totalCost += r2.cost; row.steps2 = r2.steps; row.resolvedInLoop2 = r2.resolvedInLoop;
      try { rmSync(w2, { recursive: true, force: true }); } catch { /**/ }
      if (r2.resolvedInLoop) { patch = r2.patch; row.tier = 'T2'; }
      else { patch = await judgePick(inst, res.patch, r2.patch); row.tier = 'judge'; }
      row.resolved = !!(res.resolvedInLoop || r2.resolvedInLoop);
    } else row.resolved = !!res.resolvedInLoop;
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-agentic', model_patch: patch }) + '\n');
  row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} tier=${row.tier} esc=${!!row.escalated} inloop=${row.resolvedInLoop}/${row.resolvedInLoop2 ?? '-'} ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
}

let cursor = 0; let cappedAt = null;
async function worker() {
  while (cursor < manifest.length) {
    if (totalCost >= MAX_COST) { if (cappedAt === null) { cappedAt = report.length; console.error(`[max-cost] cumulative $${totalCost.toFixed(2)} ≥ cap $${MAX_COST} — stopping after in-flight (${report.length}/${manifest.length} done)`); } return; }
    const inst = manifest[cursor++];
    await runInstance(inst);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

const inloop = report.filter((r) => r.resolved).length;
const escalated = report.filter((r) => r.escalated).length;
const byTier = report.reduce((h, r) => { h[r.tier] = (h[r.tier] || 0) + 1; return h; }, {});
// ADR-173 leakage guard: in conformant mode the gold harness must NEVER have run during solving.
const conformant = NO_ORACLE && !usedOracleDuringSolve;
if (NO_ORACLE && usedOracleDuringSolve) console.error('⚠️ LEAKAGE: gold harness was called during solve despite --no-test-oracle — run is NON-conformant.');
writeFileSync(REPORT, JSON.stringify({ model: MODEL, escalateModel: ESCALATE, cascade: !!ESCALATE, maxSteps: MAX_STEPS, n: report.length, resolvedInLoop: inloop, escalated, byTier, noTestOracle: NO_ORACLE, leaderboardConformant: conformant, cappedAtInstance: cappedAt, maxCost: MAX_COST===Infinity?null:MAX_COST, totalCost_usd: Math.round(totalCost * 10000) / 10000, blendedCostPerInst_usd: report.length ? Math.round(totalCost / report.length * 1e5) / 1e5 : 0, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | in-loop ${inloop}/${report.length} | cascade=${!!ESCALATE} escalated=${escalated} tiers=${JSON.stringify(byTier)} | $${Math.round(totalCost * 10000) / 10000} (${report.length?(totalCost/report.length).toFixed(4):0}/inst) | preds → ${OUT}`);
