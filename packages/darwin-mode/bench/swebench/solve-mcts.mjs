// SPDX-License-Identifier: MIT
// ADR-174 L2 — CONFORMANT best-of-k / MCTS solver. Per instance:
//   1. Test-Critic builds a validated repro (FAILS on buggy code) — the conformant oracle.
//   2. Generate k candidate patches (the base model, diversified by temperature).
//   3. Apply each in its own forked container, run the repro — keep a candidate that makes it PASS
//      (and, tie-break, doesn't break the changed-area existing tests).
//   4. Emit the winner. If none pass the repro → emit best-effort (L3 Opus-sniper escalation hook).
// NEVER touches the gold FAIL_TO_PASS in-loop; gold scores once at the end. Leakage-guarded.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, appendFileSync, rmSync } from 'node:fs';
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
const MODEL = argv('--model', 'deepseek/deepseek-v4-flash');         // Test-Critic / repro driver (cheap)
const PATCH_MODEL = argv('--patch-model', MODEL);                    // MCTS candidate-patch model (the heavy-lifter, e.g. minimax/minimax-m2.7)
const SNIPER = argv('--sniper', 'anthropic/claude-opus-4.8');        // L3 escalation model
const K = +argv('--k', 5);
const SLICE = +argv('--slice', 40000);
const BRANCH_TURNS = +argv('--branch-turns', 5);          // hard cap per branch (backstop; early-exit on clean apply)
const APPLICATOR = argv('--applicator', 'line');          // 'line' = robust line-range edits (SWE-agent primitive); 'search' = legacy search/replace
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'predictions-mcts.jsonl'));
const REPORT = rel(argv('--report', 'solve-mcts-report.json'));
const CONCURRENCY = Math.max(1, +argv('--concurrency', 2));
const MAX_COST = +argv('--max-cost', Infinity);
// ADR-175 #47 — human-in-the-loop test review (the "Conformant + review" middle mode).
// Phase 1 (`--pause-for-test-review`): write each agent repro to REPRO_DIR for a human to read/edit,
// and DO NOT patch/trust unreviewed instances. Phase 2 (add `--approved-repros <dir>`): only instances
// whose repro a human approved (a file <dir>/<instance_id>.py) proceed — an approved repro is effectively
// a user-supplied test, collapsing that instance to the trustworthy oracle-ON contract.
const PAUSE_REVIEW = args.includes('--pause-for-test-review');
const APPROVED_DIR = argv('--approved-repros', null);
const REPRO_DIR = rel(argv('--repro-dir', 'mcts-repros'));
if (PAUSE_REVIEW) try { mkdirSync(REPRO_DIR, { recursive: true }); } catch { /**/ }
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

// ADR-174 L2″ — the SWE-agent line-number editing primitive. The model points at a line
// RANGE instead of synthesizing a perfect multi-line string match (the failure mode that
// left ~50% of search/replace patches empty). Format:
//   EDIT <path> <start>-<end>\n<new lines>\nENDEDIT   (1-indexed inclusive; start>end ⇒ insert before start)
const LINE_SYS = `You edit Python by LINE RANGE. Output ONLY edit blocks, no prose:
EDIT path/to/file.py <start>-<end>
<replacement lines — exact indentation, no line numbers>
ENDEDIT
Replaces lines start..end (1-indexed, inclusive) shown in the numbered snapshot. Use the EXACT path and
numbers from the snapshot. Emit one or more blocks. To insert without deleting, use <start>-<start-1>.`;

function numberedSnapshot(work, selected, sliceLines = 700) {
  return selected.map((f) => {
    const lines = readFileSync(join(work, f), 'utf8').split('\n').slice(0, sliceLines);
    return `# ===== ${f} (${lines.length} lines shown) =====\n` + lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  }).join('\n\n');
}
// Apply line-range edits bottom-to-top per file (so earlier edits don't shift later line numbers).
function applyLineEdits(work, raw, selected) {
  g(work, 'git checkout -q -- .');
  const re = /EDIT\s+(\S+)\s+(\d+)-(\d+)\s*\n([\s\S]*?)\nENDEDIT/g;
  const byFile = {}; const failures = [];
  for (let m; (m = re.exec(raw));) {
    const f = m[1].trim(); const s = +m[2]; const e = +m[3]; const body = m[4];
    if (!selected.includes(f) || !existsSync(join(work, f))) { failures.push(`unknown file ${f}`); continue; }
    (byFile[f] ||= []).push({ s, e, body });
  }
  let applied = 0;
  for (const [f, edits] of Object.entries(byFile)) {
    const lines = readFileSync(join(work, f), 'utf8').split('\n');
    edits.sort((a, b) => b.s - a.s); // bottom-to-top
    for (const { s, e, body } of edits) {
      if (s < 1 || e > lines.length || e < s - 1) { failures.push(`${f} ${s}-${e} out of range (1-${lines.length})`); continue; }
      lines.splice(s - 1, e - s + 1, ...body.split('\n')); applied++;
    }
    writeFileSync(join(work, f), lines.join('\n'));
  }
  return { patch: applied ? g(work, 'git diff').toString() : '', failures, changedFiles: Object.keys(byFile) };
}
// Local syntax backstop (py_compile only parses — no deps needed).
function pyCompile(work, files) {
  for (const f of files) {
    try { execSync(`python3 -m py_compile ${JSON.stringify(join(work, f))}`, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return { ok: false, err: String(e.stderr || e.message).split('\n').slice(-4).join('\n').slice(-500) }; }
  }
  return { ok: true, err: '' };
}

// One MCTS branch: a bounded stateful read-then-edit loop. Early-exit the instant the repro passes.
// Returns { patch, passed, cost }. Reasoning turns capped at BRANCH_TURNS; syntax retries are a separate
// 2-retry sub-budget (don't consume reasoning turns).
async function runBranch(instanceId, problem, snapshot, selected, model, temp, repro, work) {
  let feedback = ''; let cost = 0; let lastPatch = '';
  for (let turn = 0; turn < BRANCH_TURNS; turn++) {
    const r = await llm(`Fix the bug.\n--- issue ---\n${problem.slice(0, 6000)}\n--- numbered source ---\n${snapshot}${feedback}`, LINE_SYS, model, temp);
    cost += r.cost;
    let { patch, failures, changedFiles } = applyLineEdits(work, r.raw, selected);
    if (!patch) { feedback = `\n--- no edit applied (${failures.slice(0, 3).join('; ') || 'no EDIT block parsed'}). Re-emit EDIT blocks with exact paths + line numbers from the snapshot. ---`; continue; }
    // syntax sub-loop (separate 2-retry budget)
    let syn = pyCompile(work, changedFiles);
    for (let s = 0; s < 2 && !syn.ok; s++) {
      const fix = await llm(`Your edit caused a syntax error:\n${syn.err}\nRe-emit corrected EDIT blocks.\n--- numbered source ---\n${numberedSnapshot(work, changedFiles)}`, LINE_SYS, model, temp);
      cost += fix.cost; const re2 = applyLineEdits(work, fix.raw, selected);
      if (re2.patch) { patch = re2.patch; changedFiles = re2.changedFiles; } syn = pyCompile(work, changedFiles);
    }
    if (!syn.ok) { feedback = `\n--- still a syntax error after retries:\n${syn.err}\nTry a different edit. ---`; continue; }
    lastPatch = patch;
    if (!repro) return { patch, passed: false, cost }; // no oracle to gate on → keep best-effort
    const v = runConformantTests(instanceId, patch, `python ${REPRO_PATH}`, { extraFiles: repro, timeoutMs: 300000 });
    if (v.ran && v.passed) return { patch, passed: true, cost }; // EARLY EXIT
    feedback = `\n--- patch applied + compiles but the reproduction test still FAILS:\n${(v.logTail || '').slice(-700)}\nFix the logic.\n--- numbered source ---\n${numberedSnapshot(work, changedFiles)}`;
  }
  return { patch: lastPatch, passed: false, cost };
}

writeFileSync(OUT, ''); const report = []; let totalCost = 0; let usedOracle = false;
async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, k: K, reproValid: false, branchesPassed: 0, sniper: false };
  let best = ''; let work;
  try {
    work = fetchRepo(inst.repo, inst.base_commit);
    const allPy = g(work, "git ls-files '*.py'").toString().split('\n').filter(Boolean).filter((f) => !/(^|\/)(tests?|testing|site-packages|build|dist)\//i.test(f) && !/(^|\/)(test_|conftest)/i.test(f)).filter((f) => { try { return statSync(join(work, f)).size <= 100000; } catch { return false; } });
    const selected = selectFiles(inst.problem_statement, work, allPy, buildContext, 15);
    const seen = APPLICATOR === 'line' ? numberedSnapshot(work, selected) : selected.map((f) => `# ===== ${f} =====\n${readFileSync(join(work, f), 'utf8').slice(0, SLICE)}`).join('\n\n');
    // 1) conformant oracle
    const critic = await buildReproTest(inst.instance_id, inst.problem_statement, (p, s) => llm(p, s), { maxAttempts: 3 });
    totalCost += critic.cost; row.reproValid = critic.valid;
    let repro = critic.valid ? { [REPRO_PATH]: critic.repro } : null;
    // ADR-175 #47 human-in-the-loop test review
    if (PAUSE_REVIEW && repro) {
      const approvedPath = APPROVED_DIR ? join(rel(APPROVED_DIR), inst.instance_id + '.py') : null;
      if (approvedPath && existsSync(approvedPath)) {
        repro = { [REPRO_PATH]: readFileSync(approvedPath, 'utf8') }; row.reproApproved = true; // human-approved → trustworthy contract
      } else {
        try { writeFileSync(join(REPRO_DIR, inst.instance_id + '.py'), critic.repro); } catch { /**/ }
        row.awaitingReview = true; // do NOT patch/trust an unreviewed self-test
        appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-mcts', model_patch: '' }) + '\n');
        row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
        console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} AWAITING-REVIEW (repro written) ${row.sec}s`);
        return;
      }
    }
    // 2+3) k diversified agentic branches — each a bounded read-then-edit loop, repro-gated, early-exit on pass.
    if (APPLICATOR === 'line') {
      for (let b = 0; b < K; b++) {
        const br = await runBranch(inst.instance_id, inst.problem_statement, seen, selected, PATCH_MODEL, b === 0 ? 0 : 0.2 + 0.15 * b, repro, work);
        totalCost += br.cost;
        if (br.patch && !best) best = br.patch; // fallback: first applicable
        if (br.passed) { best = br.patch; row.branchesPassed++; break; } // EARLY EXIT — repro passed
      }
    } else {
      const cands = [];
      for (let b = 0; b < K; b++) {
        const r = await llm(`Fix the bug. Emit search/replace blocks only.\n--- issue ---\n${inst.problem_statement.slice(0, 6000)}\n--- files ---\n${seen}`, PATCH_SYS, PATCH_MODEL, b === 0 ? 0 : 0.2 + 0.15 * b);
        totalCost += r.cost; const patch = patchFromBlocks(work, r.raw, selected); if (patch) cands.push(patch);
      }
      if (!best && cands.length) best = cands[0];
      if (repro) for (const patch of cands) {
        const v = runConformantTests(inst.instance_id, patch, `python ${REPRO_PATH}`, { extraFiles: repro, timeoutMs: 300000 });
        if (v.ran && v.passed) { best = patch; row.branchesPassed++; break; }
      }
    }
    // 4) L3 Opus-sniper if no branch passed the repro
    if (repro && row.branchesPassed === 0 && SNIPER && SNIPER !== 'none') {
      const sn = await runBranch(inst.instance_id, inst.problem_statement, numberedSnapshot(work, selected), selected, SNIPER, 0, repro, work);
      totalCost += sn.cost; row.sniper = true;
      if (sn.passed) { row.branchesPassed++; best = sn.patch; } else if (sn.patch && !best) best = sn.patch;
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
const reproValid = report.filter((r) => r.reproValid).length, solved = report.filter((r) => r.branchesPassed > 0 || r.sniper).length, awaiting = report.filter((r) => r.awaitingReview).length;
writeFileSync(REPORT, JSON.stringify({ model: MODEL, patchModel: PATCH_MODEL, sniper: SNIPER, k: K, n: report.length, reproValid, branchOrSniperSolved: solved, awaitingReview: awaiting, pauseForTestReview: PAUSE_REVIEW, leaderboardConformant: !usedOracle, cappedAtInstance: cappedAt, totalCost_usd: Math.round(totalCost * 1e4) / 1e4, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | repro-valid ${reproValid} | repro-passed ${solved} | conformant=${!usedOracle} | $${Math.round(totalCost * 1e4) / 1e4} | preds → ${OUT} (BATCH-eval for the authoritative number)`);
