// SPDX-License-Identifier: MIT
//
// ADR-143 (Stage B2) — the CLOSED-LOOP solver: ADR-126's repair loop on real SWE-bench. Per
// instance, up to N attempts: select → search/replace patch → if it applies, run the instance's
// FAIL_TO_PASS in its official swebench Docker image → if resolved, stop; else feed the failure
// (apply-rejection OR pytest traceback) back and retry. Reuses the official `swebench` harness as
// BOTH the test executor and the resolved oracle (no reimplementation). Attacks both pilot failure
// modes: empty-patch (apply-rejection feedback) and patched-but-wrong (traceback feedback).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//   bench/swebench/solve-repair.mjs [--instance <id>] [--attempts 3] [--k 15]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { selectFiles } from '../swe-bench-runner.mjs';
import { buildIndex, retrieveHybrid, formatExemplars } from './patch-memory.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const onlyInstance = argv('--instance', null);
const ATTEMPTS = +argv('--attempts', 3);
const K = +argv('--k', 15);
const SLICE = +argv('--slice', 45000); // per-file char budget; shrink for small-context local models (ADR-150)
const LOCALIZE = args.includes('--localize');
const MODEL = argv('--model', 'deepseek/deepseek-chat');
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'predictions-repair.jsonl'));
const REPORT = rel(argv('--report', 'solve-repair-report.json'));
// ADR-169 (research E3) — persistent patch memory: retrieve prior resolved
// (issue→patch) exemplars and inject as few-shot. `--patch-memory <corpus.json>`
// enables it; `--pm-k`, `--pm-min-score` (the anti-negative-transfer gate). $0,
// deterministic (BM25; dense rerank is opt-in via an embedder, not wired to a
// paid model here). The corpus must EXCLUDE the eval set's own patches (we pass
// excludeId per instance, but build from a disjoint resolved set to be safe).
const PM_PATH = argv('--patch-memory', null);
const PM_K = +argv('--pm-k', 3);
const PM_MIN = +argv('--pm-min-score', 0.30);
let pmIndex = null;
if (PM_PATH) {
  try {
    const raw = JSON.parse(readFileSync(rel(PM_PATH), 'utf8'));
    const entries = Array.isArray(raw) ? raw : raw.entries;
    pmIndex = buildIndex(entries); // BM25 ($0); dense rerank opt-in later
    console.error(`[patch-memory] loaded ${entries.length} resolved exemplars from ${PM_PATH} (k=${PM_K}, min-score=${PM_MIN})`);
  } catch (e) { console.error(`[patch-memory] disabled — could not load ${PM_PATH}: ${String(e).slice(0, 120)}`); }
}
const VENV = '/tmp/swebench-venv';
// ADR-150: configurable OpenAI-compatible endpoint (default OpenRouter; point --base-url at a
// tailscale-served local model, e.g. http://ruv-mac-mini:8000/v1). --api-key-env names the env
// var holding the key; a keyless local endpoint works (empty bearer tolerated).
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
if (onlyInstance) manifest = manifest.filter((i) => i.instance_id === onlyInstance);

const hr = mkdtempSync(join(tmpdir(), 'sbr-h-')); mkdirSync(join(hr, 'src'), { recursive: true });
writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}'); writeFileSync(join(hr, 'src', 'i.js'), 'export const x=1;\n');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'sbr-hw-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
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
  // Concurrency hammers anonymous GitHub clones → rate-limit/abuse 'git fetch' failures
  // (63/181 in the first concurrent run). Retry the fetch with backoff before giving up.
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) sleepSync(3000 * 2 ** (attempt - 1)); // 3,6,12s
    try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); last = null; break; }
    catch (e1) {
      try { g(work, 'git fetch --depth 200 origin -q'); g(work, `git checkout -q ${sha}`); last = null; break; }
      catch (e2) { last = e2; }
    }
  }
  if (last) throw last;
  g(work, 'git config user.email b@b'); g(work, 'git config user.name b'); g(work, 'git commit -qam base --allow-empty');
  return work;
}
async function llm(prompt, system) {
  // Retry on transient network failures (the repair300 run hit a multi-hour outage that
  // terminally errored 272/300 instances with "fetch failed"). Up to 5 tries, exp backoff.
  // Optional system message carries the format contract (ADR-150: weak local models need it).
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1))); // 2,4,8,16s
    try {
      const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, max_tokens: 4096, temperature: 0 }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('llm failed');
}
// Run the official swebench harness on ONE candidate patch → {resolved, logTail}. The harness is
// the test executor + oracle; we read its per-instance test log for the traceback to feed back.
function evalOne(instanceId, patch, runId) {
  const preds = `/tmp/repair-${runId}.jsonl`;
  writeFileSync(preds, JSON.stringify({ instance_id: instanceId, model_name_or_path: 'darwin-repair', model_patch: patch }) + '\n');
  try { execSync(`. ${VENV}/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${preds} --instance_ids ${instanceId} --run_id ${runId} --max_workers 1 --cache_level instance --timeout 1200`, { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500000, maxBuffer: 1 << 28 }); } catch { /* non-zero when unresolved */ }
  let resolved = false; try { const rep = JSON.parse(readFileSync(`/tmp/darwin-repair.${runId}.json`, 'utf8')); resolved = (rep.resolved_ids || []).includes(instanceId); } catch { /**/ }
  let logTail = ''; try { const lp = `/tmp/logs/run_evaluation/${runId}/darwin-repair/${instanceId}/test_output.txt`; if (existsSync(lp)) { const t = readFileSync(lp, 'utf8'); logTail = t.split('\n').filter((l) => /FAIL|Error|assert|Traceback|^E |raise |\.py:[0-9]/.test(l)).slice(-40).join('\n').slice(-2500); } } catch { /**/ }
  return { resolved, logTail };
}

// LLM file localization (ADR-146), same as solve.mjs — used when --localize is set.
async function localize(problem, work, files, k, pre = 120) {
  const lexTop = selectFiles(problem, work, files, buildContext, pre);
  const sigOf = (f) => { const lines = readFileSync(join(work, f), 'utf8').split('\n'); const sigs = lines.filter((l) => /^\s*(class|def|async def)\s+\w/.test(l)).map((l) => l.trim().replace(/:\s*$/, '')).slice(0, 8); return sigs.length ? `${f}\n    ${sigs.join('\n    ')}` : f; };
  const prompt = `A bug is reported below. From the candidate files (path + top signatures), list ONLY the file paths most likely to contain the fix, most-likely first, one per line, at most ${k}. Output paths verbatim, nothing else.\n--- problem ---\n${problem.slice(0, 4000)}\n--- candidate files ---\n${lexTop.map(sigOf).join('\n').slice(0, 24000)}\n`;
  try {
    const { raw, cost } = await llm(prompt);
    const picked = raw.split('\n').map((l) => l.trim().replace(/^[-*\d.\s]+/, '')).filter((l) => files.includes(l));
    return { selected: [...new Set([...picked, ...lexTop])].slice(0, k), cost };
  } catch { return { selected: lexTop.slice(0, k), cost: 0 }; }
}

// --concurrency N (default 1): run independent instances through a Promise pool. The machine is
// 32-core; the Docker test-runs (the bottleneck) parallelize cleanly. Each instance uses its own
// temp clone (mkdtemp) + unique eval runIds, so there are no cross-instance collisions.
const CONCURRENCY = Math.max(1, +argv('--concurrency', 1));

writeFileSync(OUT, ''); const report = []; let totalCost = 0;
async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, attempts: 0, resolved: false };
  let bestPatch = ''; let work;
  try {
    work = fetchRepo(inst.repo, inst.base_commit);
    const allPy = g(work, "git ls-files '*.py'").toString().split('\n').filter(Boolean)
      .filter((f) => !/(^|\/)(tests?|testing|site-packages|\.tox|build|dist)\//i.test(f) && !/(^|\/)(test_|conftest)/i.test(f) && !/_test\.py$/.test(f))
      .filter((f) => { try { return statSync(join(work, f)).size <= 100_000; } catch { return false; } });
    let selected;
    if (LOCALIZE) { const lz = await localize(inst.problem_statement, work, allPy, K); selected = lz.selected; totalCost += lz.cost; }
    else selected = selectFiles(inst.problem_statement, work, allPy, buildContext, K);
    row.candidateFiles = allPy.length;
    const seen = selected.map((f) => `# ===== ${f} =====\n${readFileSync(join(work, f), 'utf8').slice(0, SLICE)}`).join('\n\n');
    // ADR-169: gated patch-memory exemplars (empty string if nothing clears the
    // similarity gate — never inject a misleading few-shot). Excludes self.
    let pmBlock = '';
    if (pmIndex) {
      const hits = retrieveHybrid(pmIndex, inst.problem_statement, { k: PM_K, excludeId: inst.instance_id, minScore: PM_MIN });
      pmBlock = formatExemplars(hits);
      row.pmHits = hits.length;
    }
    let feedback = '';
    for (let att = 1; att <= ATTEMPTS && !row.resolved; att++) {
      row.attempts = att;
      g(work, 'git checkout -q -- .'); // reset to base before each attempt's edits
      // ADR-150: system message carries the format contract + example (weak local models ignore an
      // inline spec and emit prose; deepseek already complies, so additive).
      const sys = 'You are a non-conversational code-patching tool. Output ONLY search/replace edit blocks. NEVER write prose, explanations, summaries, or markdown fences. Each edit is EXACTLY:\nFILE: path/to/file.py\n<<<SEARCH\n<lines copied verbatim from the file, incl. indentation>\n=======\n<replacement lines>\n>>>REPLACE\nExample:\nFILE: pkg/util.py\n<<<SEARCH\ndef add(a, b):\n    return a - b\n=======\ndef add(a, b):\n    return a + b\n>>>REPLACE';
      const prompt = `Fix the bug by editing the selected real source files. Emit one or more edit blocks in the exact format from the system message. SEARCH must match the file character-for-character (indentation matters). No prose outside blocks.\n--- problem statement ---\n${inst.problem_statement.slice(0, 6000)}\n--- selected source files ---\n${seen}\n${pmBlock}${feedback}`;
      const { raw, cost } = await llm(prompt, sys); totalCost += cost;
      let applied = 0; const re = /FILE:\s*([^\n]+)\n<<<SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>REPLACE/g; const misses = [];
      for (let m; (m = re.exec(raw)); ) { const f = m[1].trim(); if (!selected.includes(f) || !existsSync(join(work, f))) { misses.push(`${f} (not a selected file)`); continue; } const cur = readFileSync(join(work, f), 'utf8'); const next = applyEdit(cur, m[2], m[3]); if (next && next !== cur) { writeFileSync(join(work, f), next); applied++; } else misses.push(`${f} (SEARCH text did not match the file)`); }
      const patch = applied ? g(work, 'git diff').toString() : '';
      if (!patch) { feedback = `\n--- attempt ${att} produced NO applicable edit ---\nThe following SEARCH blocks did not apply: ${misses.join('; ') || '(none emitted)'}. Re-read the selected files and copy the SEARCH text EXACTLY (including indentation) from the region you intend to change.\n`; continue; }
      bestPatch = patch;
      const ev = evalOne(inst.instance_id, patch, `rep_${inst.instance_id}_${att}`.replace(/[^a-zA-Z0-9_]/g, '_'));
      if (ev.resolved) { row.resolved = true; break; }
      feedback = `\n--- attempt ${att}: patch applied but tests still FAIL ---\nFailing-test output (fix the logic so these pass; do not edit tests):\n${ev.logTail || '(no log captured)'}\n`;
    }
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  finally { if (work) try { rmSync(work, { recursive: true, force: true }); } catch { /* best-effort */ } } // ADR: free the temp clone (prevents 40GB+ accumulation)
  appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-deepseek-repair', model_patch: bestPatch }) + '\n');
  row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} attempts=${row.attempts} resolved=${row.resolved} ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
}

// Promise pool: keep CONCURRENCY instances in flight at once.
let cursor = 0;
async function worker() { while (cursor < manifest.length) { const inst = manifest[cursor++]; await runInstance(inst); } }
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

const resolved = report.filter((r) => r.resolved).length;
writeFileSync(REPORT, JSON.stringify({ model: MODEL, attempts: ATTEMPTS, k: K, n: report.length, resolved, totalCost_usd: Math.round(totalCost * 10000) / 10000, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | resolved ${resolved}/${report.length} | $${Math.round(totalCost * 10000) / 10000} | preds → ${OUT}`);
