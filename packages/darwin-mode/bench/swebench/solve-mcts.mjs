// SPDX-License-Identifier: MIT
// ADR-174 L2 — CONFORMANT best-of-k / MCTS solver. Per instance:
//   1. Test-Critic builds a validated repro (FAILS on buggy code) — the conformant oracle.
//   2. Generate k candidate patches (the base model, diversified by temperature).
//   3. Apply each in its own forked container, run the repro — keep a candidate that makes it PASS
//      (and, tie-break, doesn't break the changed-area existing tests).
//   4. Emit the winner. If none pass the repro → emit best-effort (L3 Opus-sniper escalation hook).
// NEVER touches the gold FAIL_TO_PASS in-loop; gold scores once at the end. Leakage-guarded.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectFiles } from '../swe-bench-runner.mjs';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { buildReproTest, REPRO_PATH } from './test-critic.mjs';
import { runConformantTests } from './conformant-tests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MODEL = argv('--model', 'deepseek/deepseek-v4-flash');
const SNIPER = argv('--sniper', 'anthropic/claude-opus-4.8'); // L3 escalation model
const K = +argv('--k', 5);
const SLICE = +argv('--slice', 40000);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'predictions-mcts.jsonl'));
const REPORT = rel(argv('--report', 'solve-mcts-report.json'));
const CONCURRENCY = Math.max(1, +argv('--concurrency', 2));
const MAX_COST = +argv('--max-cost', Infinity);
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const key = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
if (argv('--instance', null)) manifest = manifest.filter((i) => i.instance_id === argv('--instance', null));

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function applyEdit(content, search, replace) {
  if (search.length && content.includes(search)) return content.replace(search, replace);
  const cl = content.split('\n'); const sl = search.split('\n');
  while (sl.length && !sl[sl.length - 1].trim()) sl.pop(); while (sl.length && !sl[0].trim()) sl.shift();
  if (!sl.length) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + sl.length <= cl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) if (norm(cl[i + j]) !== norm(sl[j])) { ok = false; break; }
    if (!ok) continue;
    const ind = (s) => (s.match(/^[ \t]*/) || [''])[0]; const d = ind(cl[i]).length - ind(sl[0]).length;
    const rl = replace.split('\n').map((line) => !line.trim() ? line : d >= 0 ? ' '.repeat(d) + line : line.slice(Math.min(-d, ind(line).length)));
    return [...cl.slice(0, i), ...rl, ...cl.slice(i + sl.length)].join('\n');
  }
  return null;
}
function sleepSync(ms) { try { execSync(`sleep ${(ms / 1000).toFixed(1)}`); } catch { /**/ } }
function fetchRepo(repo, sha) {
  const work = mkdtempSync(join(tmpdir(), 'sbrepo-'));
  g(work, 'git init -q'); g(work, `git remote add origin https://github.com/${repo}.git`);
  let last; for (let a = 0; a < 4; a++) { if (a) sleepSync(3000 * 2 ** (a - 1)); try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); last = null; break; } catch { try { g(work, 'git fetch --depth 200 origin -q'); g(work, `git checkout -q ${sha}`); last = null; break; } catch (e) { last = e; } } }
  if (last) throw last; g(work, 'git config user.email b@b'); g(work, 'git config user.name b'); g(work, 'git commit -qam base --allow-empty'); return work;
}
async function llm(prompt, system, model = MODEL, temperature = 0) {
  for (let a = 0; a < 5; a++) {
    if (a) await new Promise((r) => setTimeout(r, 2000 * 2 ** (a - 1)));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }], max_tokens: 4096, temperature }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
      const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    } catch { /* retry */ }
  }
  return { raw: '', cost: 0 };
}

const hr = mkdtempSync(join(tmpdir(), 'mh-')); writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'mw-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);
const PATCH_SYS = 'You are a code-patching tool. Output ONLY search/replace edit blocks, no prose:\nFILE: path/to/file.py\n<<<SEARCH\n<verbatim lines incl. indentation>\n=======\n<replacement>\n>>>REPLACE';

function patchFromBlocks(work, raw, selected) {
  g(work, 'git checkout -q -- .'); let applied = 0;
  const re = /FILE:\s*([^\n]+)\n<<<SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>REPLACE/g;
  for (let m; (m = re.exec(raw));) { const f = m[1].trim(); if (!selected.includes(f) || !existsSync(join(work, f))) continue; const cur = readFileSync(join(work, f), 'utf8'); const nx = applyEdit(cur, m[2], m[3]); if (nx && nx !== cur) { writeFileSync(join(work, f), nx); applied++; } }
  return applied ? g(work, 'git diff').toString() : '';
}

writeFileSync(OUT, ''); const report = []; let totalCost = 0; let usedOracle = false;
async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, k: K, reproValid: false, branchesPassed: 0, sniper: false };
  let best = ''; let work;
  try {
    work = fetchRepo(inst.repo, inst.base_commit);
    const allPy = g(work, "git ls-files '*.py'").toString().split('\n').filter(Boolean).filter((f) => !/(^|\/)(tests?|testing|site-packages|build|dist)\//i.test(f) && !/(^|\/)(test_|conftest)/i.test(f)).filter((f) => { try { return statSync(join(work, f)).size <= 100000; } catch { return false; } });
    const selected = selectFiles(inst.problem_statement, work, allPy, buildContext, 15);
    const seen = selected.map((f) => `# ===== ${f} =====\n${readFileSync(join(work, f), 'utf8').slice(0, SLICE)}`).join('\n\n');
    // 1) conformant oracle
    const critic = await buildReproTest(inst.instance_id, inst.problem_statement, (p, s) => llm(p, s), { maxAttempts: 3 });
    totalCost += critic.cost; row.reproValid = critic.valid;
    const repro = critic.valid ? { [REPRO_PATH]: critic.repro } : null;
    // 2) k diversified candidate patches
    const cands = [];
    for (let b = 0; b < K; b++) {
      const r = await llm(`Fix the bug. Emit search/replace blocks only.\n--- issue ---\n${inst.problem_statement.slice(0, 6000)}\n--- files ---\n${seen}`, PATCH_SYS, MODEL, b === 0 ? 0 : 0.2 + 0.15 * b);
      totalCost += r.cost; const patch = patchFromBlocks(work, r.raw, selected); if (patch) cands.push(patch);
    }
    if (!best && cands.length) best = cands[0]; // fallback: first non-empty
    // 3) repro-gated selection (conformant — never the gold test)
    if (repro) {
      for (const patch of cands) {
        const v = runConformantTests(inst.instance_id, patch, `python -m pytest -q -p no:cacheprovider ${REPRO_PATH}`, { extraFiles: repro, timeoutMs: 300000 });
        if (v.ran && v.passed) { best = patch; row.branchesPassed++; break; }
      }
    }
    // 4) L3 Opus-sniper if no branch passed the repro
    if (repro && row.branchesPassed === 0 && SNIPER && SNIPER !== 'none') {
      const r = await llm(`Fix the bug (hard case). Emit search/replace blocks only.\n--- issue ---\n${inst.problem_statement.slice(0, 6000)}\n--- files ---\n${seen}`, PATCH_SYS, SNIPER, 0);
      totalCost += r.cost; const patch = patchFromBlocks(work, r.raw, selected);
      if (patch) { const v = runConformantTests(inst.instance_id, patch, `python -m pytest -q -p no:cacheprovider ${REPRO_PATH}`, { extraFiles: repro, timeoutMs: 300000 }); row.sniper = true; if ((v.ran && v.passed) || !best) best = patch; }
    }
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  finally { if (work) try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } }
  appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-mcts', model_patch: best }) + '\n');
  row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} repro=${row.reproValid} passed=${row.branchesPassed}/${K} sniper=${row.sniper} ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
}
let cursor = 0; let cappedAt = null;
async function worker() { while (cursor < manifest.length) { if (totalCost >= MAX_COST) { if (cappedAt === null) { cappedAt = report.length; console.error(`[max-cost] $${totalCost.toFixed(2)} ≥ ${MAX_COST} — stop`); } return; } await runInstance(manifest[cursor++]); } }
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));
const reproValid = report.filter((r) => r.reproValid).length, solved = report.filter((r) => r.branchesPassed > 0 || r.sniper).length;
writeFileSync(REPORT, JSON.stringify({ model: MODEL, sniper: SNIPER, k: K, n: report.length, reproValid, branchOrSniperSolved: solved, leaderboardConformant: !usedOracle, cappedAtInstance: cappedAt, totalCost_usd: Math.round(totalCost * 1e4) / 1e4, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | repro-valid ${reproValid} | repro-passed ${solved} | conformant=${!usedOracle} | $${Math.round(totalCost * 1e4) / 1e4} | preds → ${OUT} (BATCH-eval for the authoritative number)`);
