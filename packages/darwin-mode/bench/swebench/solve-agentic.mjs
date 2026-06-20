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
import { agenticSolve } from './agentic-loop.mjs';

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
async function llm(prompt, system) {
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, max_tokens: 4096, temperature: 0 }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('llm failed');
}
function evalOne(instanceId, patch, runId) {
  const preds = `/tmp/agentic-${runId}.jsonl`;
  writeFileSync(preds, JSON.stringify({ instance_id: instanceId, model_name_or_path: 'darwin-agentic', model_patch: patch }) + '\n');
  try { execSync(`. ${VENV}/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${preds} --instance_ids ${instanceId} --run_id ${runId} --max_workers 1 --cache_level instance --timeout 1200`, { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500000, maxBuffer: 1 << 28 }); } catch { /**/ }
  let resolved = false; try { const rep = JSON.parse(readFileSync(`/tmp/darwin-agentic.${runId}.json`, 'utf8')); resolved = (rep.resolved_ids || []).includes(instanceId); } catch { /**/ }
  let logTail = ''; try { const lp = `/tmp/logs/run_evaluation/${runId}/darwin-agentic/${instanceId}/test_output.txt`; if (existsSync(lp)) { const t = readFileSync(lp, 'utf8'); logTail = t.split('\n').filter((l) => /FAIL|Error|assert|Traceback|^E |raise |\.py:[0-9]/.test(l)).slice(-40).join('\n').slice(-2500); } } catch { /**/ }
  return { resolved, logTail };
}
const isTestPath = (r) => /(^|\/)(tests?|testing)\//i.test(r) || /(^|\/)(test_|conftest)/i.test(r) || /_test\.py$/.test(r);

writeFileSync(OUT, ''); const report = []; let totalCost = 0;
async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, steps: 0, resolved: false };
  let patch = ''; let work; let evalCount = 0;
  try {
    work = fetchRepo(inst.repo, inst.base_commit);
    const io = {
      work, path: { join },
      readFile: (p) => readFileSync(p, 'utf8'),
      listDir: (p) => readdirSync(p, { withFileTypes: true }).map((d) => d.isDirectory() ? d.name + '/' : d.name),
      writeFile: (p, c) => writeFileSync(p, c),
      exists: (p) => existsSync(p),
      gitDiff: () => g(work, 'git diff').toString(),
      grepRepo: (pattern, glob) => { try { const gl = glob ? `-- '${glob}'` : "-- '*.py'"; return g(work, `git grep -n -e ${JSON.stringify(pattern)} ${gl} | head -60 || true`).toString(); } catch { return ''; } },
      applyEdit, isTestPath,
      runTests: () => { const cur = g(work, 'git diff').toString(); return evalOne(inst.instance_id, cur, `ag_${inst.instance_id}_${++evalCount}`.replace(/[^a-zA-Z0-9_]/g, '_')); },
      MAX_OUT: 4000,
    };
    const res = await agenticSolve({ problem: inst.problem_statement, io, llm, maxSteps: MAX_STEPS });
    patch = res.patch; totalCost += res.cost; row.steps = res.steps; row.submitted = res.submitted; row.resolvedInLoop = res.resolvedInLoop;
    // tool-call histogram + the per-step trace (capped) — debuggability for the next-arc tuning.
    row.toolHist = res.transcript.reduce((h, t) => { const k = (t.actionRaw.match(/"tool":"(\w+)"|"raw"/) || [])[1] || 'noop'; h[k] = (h[k] || 0) + 1; return h; }, {});
    row.trace = res.transcript.map((t) => `${t.actionRaw} => ${t.obs.slice(0, 120)}`);
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  finally { if (work) try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } }
  appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-agentic', model_patch: patch }) + '\n');
  row.sec = Math.round((Date.now() - t0) / 1000); row.resolved = !!row.resolvedInLoop; report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} steps=${row.steps} submit=${row.submitted} inloop=${row.resolvedInLoop} ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
}

let cursor = 0;
async function worker() { while (cursor < manifest.length) { const inst = manifest[cursor++]; await runInstance(inst); } }
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

const inloop = report.filter((r) => r.resolvedInLoop).length;
writeFileSync(REPORT, JSON.stringify({ model: MODEL, maxSteps: MAX_STEPS, n: report.length, resolvedInLoop: inloop, totalCost_usd: Math.round(totalCost * 10000) / 10000, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | in-loop resolved ${inloop}/${report.length} (BATCH-eval the predictions for the authoritative number) | $${Math.round(totalCost * 10000) / 10000} | preds → ${OUT}`);
