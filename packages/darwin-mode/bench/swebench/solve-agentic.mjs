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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agenticSolve, agenticSolveNative, chebTemp, buildAgenticSystem } from './agentic-loop.mjs';
import { runConformantTests } from './conformant-tests.mjs';
import { langProfile } from './lang-profile.mjs';
// ADR-195 Phase-2 capability stack (all opt-in; off by default — backward-compatible).
import { localizeSeed, formatSeedForAgent } from './localize.mjs';
import { reproGateSolve, reproFeedbackBlock } from './repro-gate.mjs';
import { reviewerSolve, parseReview, buildReviewPrompt, reviseFeedbackBlock, REVIEW_SYSTEM } from './reviewer.mjs';
import { buildReproTest, REPRO_PATH } from './test-critic.mjs';
// ADR-196 — execution-trace localization (the §53 dynamic-localization lever; distinct from §52's naive semantic localize).
import { traceLocalize, formatTraceSeedForAgent, buildPyTracer, TRACE_PATH } from './trace-localize.mjs';
// ADR-205 — harness handoff: darwin as router, claude -p as hard-tail actuator (loop handoff, NOT model embedding).
import { parseEscalateChain, acceptHop, solveViaClaudeP, escalationSignals, evaluateEscalation, buildReceipt, runEscalationChain, pickChainPatch } from './handoff-solver.mjs';

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
// ── ADR-195 Phase-2 capability flags (all opt-in; absent === pre-Phase-2 behaviour) ──
const LOCALIZE = args.includes('--localize');            // RuVector-HNSW retrieval-seeded localization
const REPRO_GATE = args.includes('--repro-gate');        // reproduction-first iterate loop
const REVIEWER = args.includes('--reviewer');            // critic sub-agent + bounded revise loop
const TRACE_LOCALIZE = args.includes('--trace-localize'); // ADR-196: repro→run-under-tracer→trace→evidence-seed
const EMBED_MODEL = argv('--embed-model', 'openai/text-embedding-3-small');
const LOCALIZE_K = +argv('--localize-k', 12);
const GNN_RERANK = args.includes('--gnn-rerank');        // optional ruvector-gnn-rerank diffusion
const REPRO_ROUNDS = +argv('--repro-rounds', 3);
const REVIEW_REVISIONS = +argv('--review-revisions', 2);
// ADR-197 — native OpenRouter/OpenAI function-calling path (opt-in; default OFF = the pre-existing
// text-JSON tool protocol, byte-identical). See agentic-loop.mjs's agenticSolveNative for the loop and
// NATIVE-TOOLUSE.md for the diagnosis that motivated it.
const NATIVE_TOOLS = args.includes('--native-tools');
// ADR-205 — `--escalate-to <chain>`: ordered, comma-separated escalation chain (aliases like
// `claude-p-fable`, or generic `darwin:<model>` / `claude-p:<model>` rungs). When set, an instance
// that FAILS darwin's cheap attempt is handed off rung-by-rung; the first ACCEPTED rung's patch
// replaces darwin's. Absent ⇒ every path below is byte-identical to pre-ADR-205 behaviour.
const ESCALATE_TO = argv('--escalate-to', null);
const HANDOFF_CHAIN = ESCALATE_TO ? parseEscalateChain(ESCALATE_TO) : null;
// ADR-205 — escalation POLICY. `two-of-n` (default) is the production cost-saver: escalate only when
// ≥2 failure signals fire (right for MIXED workloads where the cheap base resolves the easy share).
// `aggressive` escalates EVERY darwin miss (tests_failed OR empty_patch) — the proof policy for a
// hard slice where the base resolves ~0 (2-of-N would under-escalate confident-but-wrong submits and
// measure darwin's ceiling, not the handoff's). Validated eagerly so a typo fails fast.
const ESCALATE_POLICY = argv('--escalate-policy', 'two-of-n');
if (HANDOFF_CHAIN) evaluateEscalation({ tests_failed: false, empty_patch: false, no_submit: false, thrash_repeat: false, too_many_files: false }, ESCALATE_POLICY);
const HANDOFF_MAX_TURNS = +argv('--handoff-max-turns', 40);
const HANDOFF_TIMEOUT_MS = +argv('--handoff-timeout', 900) * 1000;
// ADR-205 — the solver_receipt stream (one JSONL row per instance; plus one per chain hop when a
// chain runs). This is the future MetaHarness router's training data: BOTH classes (escalated and
// not) with real costs and real reasons. Only written when --escalate-to is set.
const RECEIPTS = rel(argv('--receipts', 'handoff-receipts.jsonl'));
const INITIAL_SOLVER = `darwin-${MODEL.split('/').pop()}`;
// ADR-205 perf — concurrent escalations. The claude -p rung is an independent async subprocess, so
// under `--concurrency N` the hard tail must NOT serialize behind one handoff at a time; a small
// semaphore caps concurrent claude -p subprocesses (default 2, keep ≤3 — endpoint rate limits).
// darwin-model rungs are ordinary LLM calls and stay governed by --concurrency alone.
const HANDOFF_CONCURRENCY = Math.max(1, +argv('--handoff-concurrency', 2));
let handoffActive = 0; const handoffWaiters = [];
async function withHandoffSlot(fn) {
  while (handoffActive >= HANDOFF_CONCURRENCY) await new Promise((r) => handoffWaiters.push(r));
  handoffActive++;
  try { return await fn(); } finally { handoffActive--; const r = handoffWaiters.shift(); if (r) r(); }
}
// ADR-205 perf — `--early-escalate` (flag-gated, DEFAULT OFF so benchmark arms measure the spec'd
// behaviour; noted in the ADR as the measured-next-step): if darwin has burned half its step budget
// without a single edit/line_edit attempt, the attempt is un-recoverable often enough that finishing
// the budget is pure overhead — abort the loop and let the 2-of-N rules escalate immediately.
const EARLY_ESCALATE = args.includes('--early-escalate');

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
// ADR-197 — native tool-calling variant of mkLlm: sends the running `messages` array (already built by
// agenticSolveNative) plus `tools`/`tool_choice: 'required'` and returns the assistant `message` object
// (which may carry `tool_calls`) instead of a raw text string. Same retry/backoff shape as mkLlm.
function mkLlmNative(model) {
  return async function (messages, toolsSchema, temp) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const body = { model, messages, max_tokens: 4096, temperature: (temp ?? TEMP), tools: toolsSchema, tool_choice: 'required' };
        const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        return { message: j.choices?.[0]?.message ?? {}, cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
const llm = NATIVE_TOOLS ? mkLlmNative(MODEL) : mkLlm(MODEL);
// judgePick (below) always needs a plain-text {raw,cost} completion regardless of --native-tools —
// kept as a separate instance so the native-tools loop llm's different return shape never leaks there.
const llmJudge = mkLlm(MODEL);
// ADR-182 — cost cascade: cheap tier-1; escalate ONLY instances whose patch fails the repo's own tests
// (conformant gate). Tier-2 starts COLD (fresh work tree) to preserve trajectory diversity (the union ceiling).
const ESCALATE = argv('--cascade', null);
const llmEsc = ESCALATE ? (NATIVE_TOOLS ? mkLlmNative(ESCALATE) : mkLlm(ESCALATE)) : null;
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

// (The worktree-a29099 probe's standalone `--localize-seed`/loadSeedBlock path was superseded by
// ADR-195's localizeHint mechanism in solveTier; the probe tool ruvector-localize.mjs + LEARNINGS §52
// keep the empirical n=5 A/B that motivated it.)
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ADR-195 Phase-2 wiring — the REAL injected dependencies for the pure capability cores. Each is only
// constructed when its flag is on, so a default run never touches ruvector / the embeddings API.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { createRequire } from 'node:module';
import { relative } from 'node:path';
const _require = createRequire(import.meta.url);
const RUVECTOR_PATH = process.env.RUVECTOR_PATH || '/home/ruvultra/projects/ruvector/node_modules/ruvector';

// Batched OpenRouter embeddings (code-capable model). Returns number[][].
async function embedBatchRemote(inputs, model = EMBED_MODEL) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE_URL}/embeddings`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: inputs }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
      const j = await res.json();
      if (!j.data) continue;
      totalCost += (j.usage?.total_tokens || 0) / 1e6 * 0.02; // text-embedding-3-small price
      return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch { /* retry */ }
  }
  throw new Error('embed failed');
}
async function embedAll(texts, batchSize = 64) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) out.push(...await embedBatchRemote(texts.slice(i, i + batchSize).map((t) => t.slice(0, 8000))));
  return out;
}
// RuVector native HNSW factory matching localizeSeed's makeIndex contract.
function makeRuvectorIndex({ dimensions }) {
  const rv = _require(RUVECTOR_PATH);
  const VectorDB = rv.VectorDB || rv.VectorDb || rv.default;
  return new VectorDB({ dimensions, distanceMetric: 'Cosine' });
}
// Read the repo source into the {relPath->text} map the pure chunkRepo expects.
function readRepoFiles(work, maxFiles = 6000) {
  const out = {};
  const rec = (dir) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (Object.keys(out).length >= maxFiles) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) rec(p); }
      else { try { if (statSync(p).size < 400_000) out[relative(work, p)] = readFileSync(p, 'utf8'); } catch { /**/ } }
    }
  };
  rec(work);
  return out;
}
// Build the localization seed text for an instance. Clones a scratch tree, indexes it via ruvector,
// returns the agent hint string. Empty string on any failure — localization never blocks the solve.
async function buildLocalizeHint(inst) {
  let work;
  try {
    work = fetchRepo(inst.repo, inst.base_commit);
    const files = readRepoFiles(work);
    const seed = await localizeSeed({ files, problem: inst.problem_statement, embed: (t) => embedAll(t), makeIndex: makeRuvectorIndex, k: LOCALIZE_K, gnn: GNN_RERANK });
    return formatSeedForAgent(seed);
  } catch (e) { console.error(`[localize] ${inst.instance_id} skipped: ${String(e.message || e).slice(0, 120)}`); return ''; }
  finally { if (work) try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } }
}

writeFileSync(OUT, ''); const report = []; let totalCost = 0;
if (HANDOFF_CHAIN) writeFileSync(RECEIPTS, ''); // truncate the receipt stream per run
// One agentic attempt in a FRESH work tree (cold). Returns {res, work}; caller cleans up.
// ADR-195: `opts.localizeHint` (string) is prepended to the problem surface; `opts.extraContext`
// (string) is appended as additional turn-1 context (repro test / review critique). Both default
// empty so the call is identical to the pre-Phase-2 path when no capability is on. `opts.keepWork`
// returns the tree without the caller having cleaned it (the repro/reviewer loops re-run tests on it).
async function solveTier(inst, llmFn, opts = {}) {
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
  // ADR-195: assemble the problem surface — localization hint first (where to look), then the issue,
  // then any extra capability context (self-written repro / reviewer critique). All empty by default.
  // (Supersedes the worktree-a29099 probe's loadSeedBlock --localize-seed path; the standalone probe
  // tool ruvector-localize.mjs + LEARNINGS §52 record the empirical n=5 A/B that motivated this.)
  const problem = [opts.localizeHint, inst.problem_statement, opts.extraContext].filter(Boolean).join('\n\n');
  const tempSchedule = CHEB_TEMP ? ((s, n) => chebTemp(s, n, CHEB_HI)) : undefined;
  // ADR-197: --native-tools swaps the text-JSON ReAct core for the native function-calling one. The
  // default path below (agenticSolve + buildAgenticSystem) is untouched and stays byte-identical.
  // ADR-205: chain rungs may carry their own step budget (spec.maxSteps); default is the global.
  // `opts.onStep` passes straight through to the loop (used by --early-escalate's abort hook).
  const maxSteps = opts.maxSteps || MAX_STEPS;
  const res = NATIVE_TOOLS
    ? await agenticSolveNative({ problem, io, llm: llmFn, maxSteps, ext: prof.exampleExt, glob: defGlob, tempSchedule, onStep: opts.onStep })
    : await agenticSolve({ problem, io, llm: llmFn, maxSteps, system: buildAgenticSystem(prof.exampleExt, defGlob), tempSchedule, onStep: opts.onStep });
  return { res, work, prof };
}
// Cascade tie-break: neither tier passed the repo gate — judge picks the likelier fix (cheap, conformant).
async function judgePick(inst, pA, pB) {
  if (!pA.trim()) return pB; if (!pB.trim()) return pA;
  try { const { raw, cost } = await llmJudge(`A GitHub issue and TWO candidate patches, neither verified by tests. Pick the one more likely to correctly fix it.\n\nISSUE:\n${String(inst.problem_statement).slice(0, 4000)}\n\nPATCH A:\n${pA.slice(0, 5000)}\n\nPATCH B:\n${pB.slice(0, 5000)}\n\nReply ONLY 'A' or 'B'.`); totalCost += cost; return /^\s*B/i.test(raw) ? pB : pA; } catch { return pA; }
}
// ── ADR-195 Phase-2 #2: reproduction-first gate (wires the pure reproGateSolve to the real repro
// writer + COLD agentic rounds + the conformant repro runner). Returns the reproGateSolve result. ──
async function runReproGate(inst, llmFn, localizeHint) {
  let repro = ''; // captured from writeRepro, read by solveRound's feedback block
  const r = await reproGateSolve({
    writeRepro: async () => { const rb = await buildReproTest(inst.instance_id, inst.problem_statement, llmFn, { maxAttempts: 2 }); repro = rb.repro || ''; return rb; },
    solveRound: async ({ reproTrace }) => {
      const extra = reproFeedbackBlock(repro, reproTrace);
      const { res, work } = await solveTier(inst, llmFn, { localizeHint, extraContext: extra });
      try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
      return { patch: res.patch, cost: res.cost, resolvedInLoop: res.resolvedInLoop };
    },
    runRepro: ({ patch, repro: rp }) => {
      const rr = runConformantTests(inst.instance_id, patch, `python ${REPRO_PATH}`, { extraFiles: { [REPRO_PATH]: rp }, timeoutMs: 300000 });
      return { ran: rr.ran, passed: rr.passed, logTail: rr.logTail };
    },
    maxRounds: REPRO_ROUNDS,
  });
  totalCost += r.cost;
  return r;
}

// ── ADR-196 Phase-2 #4: execution-trace localization. Reuses the repro WRITE (test-critic.buildReproTest,
// same as the repro-gate), then RUNS that repro under a stdlib `sys.settrace` tracer in the conformant
// base env (deps present, gold test_patch NEVER applied), parses the captured (file,func,line) frames +
// failure traceback, and seeds the agent with that EVIDENCE (not an authoritative hint — §52 lesson).
// Returns the agent-facing hint string ('' on any miss → identical to no-trace-localize). ──
async function buildTraceHint(inst, llmFn) {
  let repro = '';
  const r = await traceLocalize({
    writeRepro: async () => { const rb = await buildReproTest(inst.instance_id, inst.problem_statement, llmFn, { maxAttempts: 2 }); repro = rb.repro || ''; return rb; },
    runTrace: ({ repro: rp }) => {
      // Stage the tracer + the repro into /testbed; run the tracer (it imports+runs the repro under
      // sys.settrace and prints the trace block between sentinels). Conformant: no patch, no gold test.
      const tracer = buildPyTracer('/testbed', REPRO_PATH);
      const rr = runConformantTests(inst.instance_id, '', `python ${TRACE_PATH}`, {
        extraFiles: { [REPRO_PATH]: rp, [TRACE_PATH]: tracer }, timeoutMs: 300000,
        // ADR-196 fix: the tracer emits a JSON block that routinely exceeds the default 2500-char
        // tail; without a wider tail the TRACE_BEGIN sentinel is truncated and parseTrace silently
        // returns ok:false (every trace seed becomes null → the lever is a no-op).
        // ADR-196 fix #3 (§61): 200 KB was NOT ample for django. `django.setup()` touches 300+ source
        // files, so the tracer's `counts` map alone serializes to ~223 KB (measured on django-11099) —
        // larger than the 200 KB byte-cap → TRACE_BEGIN is dropped by the BYTE-slice even after the §59
        // line-cap fix preserves it. django is 114/300 of Lite-300 and dominates the escalated empties,
        // so this silently killed the lever on >1/3 of the target set. Raised to 4 MB (django worst case
        // is ~223 KB; 4 MB is comfortable headroom for any conceivable trace volume).
        tailBytes: 4_000_000,
        // ADR-196 fix #2 (§59): ALSO widen the in-container `| tail -N` LINE cap. A chatty repro emits
        // many lines BEFORE the tracer sentinels; the default `tail -50` drops TRACE_BEGIN → null seed.
        // This was the silent 0/82 fire-rate on the full-300 escalated set (django/sympy/sphinx are
        // verbose) despite the byte-tail being ample. 5000 lines captures the repro output + the block.
        tailLines: 5000,
      });
      return { ran: rr.ran, logTail: rr.logTail };
    },
    k: LOCALIZE_K,
  });
  totalCost += r.cost;
  if (!r.seed) { console.error(`[trace-localize] ${inst.instance_id} no seed (${r.stats?.note || 'miss'})`); return ''; }
  return formatTraceSeedForAgent(r.seed);
}

// ── ADR-195 Phase-2 #3: reviewer + bounded revise loop (wires reviewerSolve to the review LLM + a
// COLD revise round). Takes the chosen patch and refines it; returns {patch,approved,...}. ──
async function runReviewer(inst, basePatch, llmFn, localizeHint) {
  const reviewLlm = async ({ patch, testTrace }) => {
    try { const { raw, cost } = await llm(buildReviewPrompt(inst.problem_statement, patch, testTrace), REVIEW_SYSTEM); const v = parseReview(raw); return { approved: v.approved, reason: v.reason, cost }; }
    catch { return { approved: true, reason: 'review-error (default approve)', cost: 0 }; } // never block on a review error
  };
  const r = await reviewerSolve({
    review: reviewLlm,
    reviseRound: async ({ reason }) => {
      const { res, work } = await solveTier(inst, llmFn, { localizeHint, extraContext: reviseFeedbackBlock(reason) });
      try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
      return { patch: res.patch, cost: res.cost, resolvedInLoop: res.resolvedInLoop };
    },
    patch: basePatch,
    maxRevisions: REVIEW_REVISIONS,
  });
  totalCost += r.cost;
  return r;
}

// ── ADR-205 — the REAL rung runners injected into handoff-solver's pure runEscalationChain
// traversal. 'darwin-model' rungs rerun darwin's OWN loop cold with a different model (cheap ladder
// rungs); 'claude-p-model' rungs shell out to the claude -p subprocess solver (the loop handoff —
// the whole point of ADR-205). Every rung's cost lands in totalCost so --max-cost gates the chain
// BEFORE each rung launches (claude -p has no mid-run budget flag; this gate is the enforcement). ──
async function runChainFor(inst, chain, { localizeHint, priorAttempts = [] } = {}) {
  return runEscalationChain(chain, {
    overBudget: () => totalCost >= MAX_COST,
    priorAttempts,
    runDarwinHop: async (spec) => {
      const hopLlm = NATIVE_TOOLS ? mkLlmNative(spec.model) : mkLlm(spec.model);
      const t0h = Date.now();
      const { res, work } = await solveTier(inst, hopLlm, { localizeHint, maxSteps: spec.maxSteps });
      try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
      totalCost += res.cost || 0;
      return { status: res.patch.trim() ? 'resolved' : 'failed', patch: res.patch, cost_usd: res.cost || 0, latency_ms: Date.now() - t0h, turns: res.steps, solver: spec.name, resolvedInLoop: !!res.resolvedInLoop, error: '' };
    },
    runClaudeP: async (spec, prior) => {
      const result = await withHandoffSlot(() => solveViaClaudeP({
        instanceId: inst.instance_id, repo: inst.repo, baseCommit: inst.base_commit, problemStatement: inst.problem_statement,
        model: spec.model, maxTurns: HANDOFF_MAX_TURNS, timeoutMs: HANDOFF_TIMEOUT_MS || spec.timeoutMs, priorAttempts: prior,
      }));
      result.solver = spec.name;
      totalCost += result.cost_usd || 0;
      return result;
    },
  });
}

async function runInstance(inst) {
  const t0 = Date.now(); const row = { instance_id: inst.instance_id, repo: inst.repo, tier: 'T1', resolved: false };
  let patch = '';
  try {
    // ADR-195 #1: compute the localization hint once (off → empty string → identical to before).
    const semanticHint = LOCALIZE ? await buildLocalizeHint(inst) : '';
    if (LOCALIZE) row.localized = !!semanticHint;
    // ADR-196 #4: execution-trace localization hint (dynamic; composes with the semantic seed). Off →
    // empty. Trace evidence leads (it's observed-execution, the stronger signal) when both are on.
    const traceHint = TRACE_LOCALIZE ? await buildTraceHint(inst, ESCALATE ? llmEsc : llm) : '';
    if (TRACE_LOCALIZE) row.traceLocalized = !!traceHint;
    const localizeHint = [traceHint, semanticHint].filter(Boolean).join('\n\n');

    let t1res = null; // ADR-205: the cheap attempt's raw loop result — the escalation rules read it.
    if (REPRO_GATE) {
      // ADR-195 #2: reproduction-first path replaces the base solve (it owns the iterate loop).
      const rg = await runReproGate(inst, llm, localizeHint);
      patch = rg.patch; row.tier = 'repro'; row.reproValid = rg.reproValid; row.reproPassed = rg.reproPassed; row.reproRounds = rg.rounds; row.resolved = !!rg.reproPassed;
    } else {
      // ADR-205 perf (--early-escalate): abort the cheap attempt at half budget if it has not even
      // ATTEMPTED an edit — the dominant unrecoverable signature (all-exploration, zero edits).
      let earlyStopped = false;
      let earlyOnStep;
      if (HANDOFF_CHAIN && EARLY_ESCALATE) {
        let edited = false;
        earlyOnStep = (step, action) => {
          if (action.tool === 'edit' || action.tool === 'line_edit') edited = true;
          if (!edited && step >= Math.ceil(MAX_STEPS / 2)) { earlyStopped = true; return 'stop'; }
        };
      }
      const { res, work } = await solveTier(inst, llm, { localizeHint, onStep: earlyOnStep });
      t1res = res;
      if (earlyStopped) row.earlyEscalated = true;
      patch = res.patch; totalCost += res.cost; row.steps = res.steps; row.submitted = res.submitted; row.resolvedInLoop = res.resolvedInLoop;
      try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
      if (ESCALATE && !res.resolvedInLoop) {                       // escalate ONLY the hard tail
        row.escalated = true;
        const { res: r2, work: w2 } = await solveTier(inst, llmEsc, { localizeHint }); // COLD tier-2
        totalCost += r2.cost; row.steps2 = r2.steps; row.resolvedInLoop2 = r2.resolvedInLoop;
        try { rmSync(w2, { recursive: true, force: true }); } catch { /**/ }
        if (r2.resolvedInLoop) { patch = r2.patch; row.tier = 'T2'; }
        else { patch = await judgePick(inst, res.patch, r2.patch); row.tier = 'judge'; }
        row.resolved = !!(res.resolvedInLoop || r2.resolvedInLoop);
      } else row.resolved = !!res.resolvedInLoop;
    }

    // ADR-205 — harness handoff: when the cheap attempt FAILS the rule-based 2-of-N trigger (darwin
    // stays the router), walk the escalation chain and let the first accepted rung's patch replace
    // darwin's. Gated entirely on --escalate-to: absent ⇒ this block never runs ⇒ byte-identical
    // output. NOTE: the trigger is the practical subset computable from what the loop ALREADY
    // tracks — learned thresholds (confidence/complexity scores) over the receipt stream are
    // explicitly future work, not invented here.
    if (HANDOFF_CHAIN && t1res) {
      const signals = escalationSignals({ resolvedInLoop: !!t1res.resolvedInLoop, submitted: !!t1res.submitted, thrash: t1res.thrash || 0, transcript: t1res.transcript, patch });
      const { escalate, reasons } = evaluateEscalation(signals, ESCALATE_POLICY);
      const darwinBase = { instanceId: inst.instance_id, initialSolver: INITIAL_SOLVER, darwinCostUsd: t1res.cost || 0, darwinSteps: t1res.steps ?? null, signals, escalatePolicy: ESCALATE_POLICY };
      let hops = [];
      if (escalate) {
        row.handoffChain = HANDOFF_CHAIN.map((s) => s.name); row.escalationReasons = reasons;
        hops = await runChainFor(inst, HANDOFF_CHAIN, {
          localizeHint,
          priorAttempts: [{ solver: INITIAL_SOLVER, failureReasons: reasons, steps: t1res.steps }],
        });
        row.handoffHops = hops.map((h) => ({ solver: h.spec.name, status: h.result?.status ?? (h.skipped ? `skipped:${h.skipped}` : 'unknown'), cost_usd: h.result?.cost_usd ?? 0, latency_ms: h.result?.latency_ms ?? 0, turns: h.result?.turns ?? 0, accepted: !!(h.result && acceptHop(h.result)) }));
        const best = pickChainPatch(hops); // first ACCEPTED hop, else last non-empty-patch hop
        if (best) { patch = best.hop.result.patch; row.tier = `handoff:${best.hop.spec.name}`; row.handoffAccepted = best.accepted; }
      }
      // Receipt stream: not escalated ⇒ one row (handoff_* null). Escalated ⇒ one row PER HOP
      // (hop/hop_of/hop_accepted extras); a single-rung chain therefore emits exactly the spec'd
      // one-escalated-row shape. diff stats on each row are the instance's FINAL patch.
      if (!escalate) {
        appendFileSync(RECEIPTS, JSON.stringify(buildReceipt({ ...darwinBase, escalated: false, escalationReasons: [], handoff: null, finalPatch: patch })) + '\n');
      } else if (hops.length === 0) {
        appendFileSync(RECEIPTS, JSON.stringify({ ...buildReceipt({ ...darwinBase, escalated: true, escalationReasons: reasons, handoff: null, finalPatch: patch }), handoff_skipped_reason: 'budget' }) + '\n');
      } else {
        hops.forEach((h, i) => {
          const rec = buildReceipt({ ...darwinBase, escalated: true, escalationReasons: reasons, handoff: h.result ? { ...h.result, solver: h.spec.name } : null, finalPatch: patch });
          appendFileSync(RECEIPTS, JSON.stringify({ ...rec, hop: i + 1, hop_of: hops.length, hop_accepted: !!(h.result && acceptHop(h.result)), ...(h.skipped ? { handoff_skipped_reason: h.skipped } : {}) }) + '\n');
        });
      }
    }

    // ADR-195 #3: reviewer refines the chosen patch (post-solve; off → no-op).
    if (REVIEWER && patch.trim()) {
      const rv = await runReviewer(inst, patch, ESCALATE ? llmEsc : llm, localizeHint);
      patch = rv.patch; row.reviewed = true; row.reviewApproved = rv.approved; row.reviewRevisions = rv.revisions;
    }
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  // ADR-196 (§60): record the trace-localize fire-rate IN the preds themselves so a future re-run
  // can audit fire-rate from the predictions file alone (no separate report needed). Only emitted
  // when --trace-localize is on, so the preds stay byte-identical for every other caller/config.
  const predRow = { instance_id: inst.instance_id, model_name_or_path: 'darwin-agentic', model_patch: patch };
  if (TRACE_LOCALIZE) predRow.traceLocalized = !!row.traceLocalized;
  appendFileSync(OUT, JSON.stringify(predRow) + '\n');
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
writeFileSync(REPORT, JSON.stringify({ model: MODEL, escalateModel: ESCALATE, cascade: !!ESCALATE, maxSteps: MAX_STEPS, n: report.length, resolvedInLoop: inloop, escalated, byTier, noTestOracle: NO_ORACLE, leaderboardConformant: conformant,
  // ADR-195 Phase-2 capability flags active for this run (all false → pre-Phase-2 behaviour).
  phase2: { localize: LOCALIZE, gnnRerank: GNN_RERANK, reproGate: REPRO_GATE, reviewer: REVIEWER, traceLocalize: TRACE_LOCALIZE },
  // ADR-197 — native tool-calling flag active for this run (false → pre-existing text-JSON protocol).
  nativeTools: NATIVE_TOOLS,
  // ADR-205 — escalation chain active for this run (null → no handoff, pre-ADR-205 behaviour).
  escalateTo: HANDOFF_CHAIN ? HANDOFF_CHAIN.map((s) => s.name) : null,
  escalatePolicy: HANDOFF_CHAIN ? ESCALATE_POLICY : null,
  escalationRate: HANDOFF_CHAIN ? +(report.filter((r) => r.handoffChain).length / (report.length || 1)).toFixed(3) : null,
  cappedAtInstance: cappedAt, maxCost: MAX_COST===Infinity?null:MAX_COST, totalCost_usd: Math.round(totalCost * 10000) / 10000, blendedCostPerInst_usd: report.length ? Math.round(totalCost / report.length * 1e5) / 1e5 : 0, instances: report }, null, 2));
console.error(`\nDONE ${report.length} | in-loop ${inloop}/${report.length} | cascade=${!!ESCALATE} escalated=${escalated} tiers=${JSON.stringify(byTier)} | native-tools=${NATIVE_TOOLS} | $${Math.round(totalCost * 10000) / 10000} (${report.length?(totalCost/report.length).toFixed(4):0}/inst) | preds → ${OUT}`);
