// SPDX-License-Identifier: MIT
//
// ADR-226 (Advisor-loop) — the AGENTIC solver in ADVISOR mode. Wires the real fetchRepo / llm /
// evalOne / git to the unit-tested advisor loop in advisor-loop.mjs. Per instance: clone → run the
// cheap loop with a READ-ONLY strong advisor (voluntary advise tool + involuntary checkpoint gate +
// mandatory pre-submit review with bounded veto) → write the resulting patch. Mirrors
// solve-fusion.mjs's setup, flags, concurrency, fetch-retry, per-instance cleanup, conformant mode,
// and Docker oracle verbatim; the ONLY differences are the loop (advisorSolve) and the advisor knobs.
//
// `--advisor-model none` runs the D0 (pure-cheap, no-advisor) control through the SAME wiring file
// and code path (ADR-226 §4.1 — no separate-harness drift).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//   bench/swebench/solve-advisor.mjs --manifest advisor-medium-25.json --model deepseek/deepseek-chat \
//   --advisor-model anthropic/claude-sonnet-5 --max-steps 12 --concurrency 2 --max-cost 15 \
//   --no-test-oracle --out predictions-advisor.jsonl --report advisor-report.json
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advisorSolve, makeAdvisorGate, buildAdvisedSystem, buildAdvisorSystem } from './advisor-loop.mjs';
import { chebTemp, buildAgenticSystem } from './agentic-loop.mjs';
import { loadGenome, buildSystemFromGenome, buildAdvisorSystemFromGenome } from './gepa/genome.mjs';
import { runConformantTests } from './conformant-tests.mjs';
import { langProfile } from './lang-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const onlyInstance = argv('--instance', null);
const MAX_STEPS = +argv('--max-steps', 20);
const MODEL = argv('--model', 'deepseek/deepseek-chat');                 // the cheap LOOP model
const ADVISOR_MODEL = argv('--advisor-model', 'anthropic/claude-sonnet-5'); // 'none' = D0 mode
const D0 = ADVISOR_MODEL === 'none';
const OUT = rel(argv('--out', 'predictions-advisor.jsonl'));
const REPORT = rel(argv('--report', 'solve-advisor-report.json'));
const VENV = '/tmp/swebench-venv';
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const CONCURRENCY = Math.max(1, +argv('--concurrency', 1));
const MAX_COST = +argv('--max-cost', Infinity);      // HARD budget cap: stop pulling new instances at this cumulative $
const MAX_TOKENS = +argv('--max-tokens', 4096);
const TEMP = +argv('--temperature', 0);
const CHEB_TEMP = args.includes('--cheb-temp');
const NO_ORACLE = args.includes('--no-test-oracle'); // conformant mode: repo tests in-loop, gold harness only for final scoring
// Advisor knobs (ADR-226 §3.7) — documented, non-ML.
const ADVISE_AFTER_FAILS = +argv('--advise-after-fails', 2);
const ADVISOR_COOLDOWN = +argv('--advisor-cooldown', 4);
const MAX_ADVISORIES = +argv('--max-advisories', 4);
const MAX_VETOES = +argv('--max-vetoes', 2);
const ADVISOR_MAX_CHARS = +argv('--advisor-max-chars', 24000);
// ADR-228 (GEPA) — additive knobs. `--genome <file>` renders the executor system prompt (and, in
// advisor mode, the verifier prompt) from a genome JSON instead of the hard-coded builders; the
// seed genome is byte-equivalent to the builders (gepa/genome.test.mjs), so no-mutation runs are
// identical. `--transcripts-dir <dir>` persists per-instance transcripts for ASI feedback
// generation (gepa/evaluate-genome.mjs). No behavior change without the flags.
const GENOME_PATH = argv('--genome', null);
const GENOME = GENOME_PATH ? loadGenome((p) => readFileSync(p, 'utf8'), rel(GENOME_PATH)) : null;
const TRANSCRIPTS_DIR = argv('--transcripts-dir', null) ? rel(argv('--transcripts-dir', null)) : null;
if (TRANSCRIPTS_DIR) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'advisor-medium-25.json')), 'utf8')).instances;
if (onlyInstance) manifest = manifest.filter((i) => i.instance_id === onlyInstance);

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

// The validated search/replace primitive (identical shape to solve-fusion.mjs / solve-agentic.mjs).
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
  const work = mkdtempSync(join(tmpdir(), 'sbadvisor-'));
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
// Per-call provider/model-id ledger (ADR-226 §3.7 / §4.4): OpenRouter's response carries the
// ACTUAL model id and upstream provider served — logged so cross-run model-snapshot drift is
// flagged rather than assumed away.
const observedModels = {}; // requested -> { "<served-model>@<provider>": callCount }
function recordServed(requested, j) {
  const servedKey = `${j.model || '(unknown)'}@${j.provider || '(unknown)'}`;
  (observedModels[requested] ||= {})[servedKey] = (observedModels[requested][servedKey] || 0) + 1;
}
// OpenAI-compatible chat completion (OpenRouter). Returns { raw, cost }. Retries 429/5xx.
function mkLlm(model) {
  return async function (prompt, system, temp) {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const body = { model, messages, max_tokens: MAX_TOKENS, temperature: (temp ?? TEMP) };
        const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json(); recordServed(model, j); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
const llmLow = mkLlm(MODEL);
const llmAdvisor = D0 ? null : mkLlm(ADVISOR_MODEL);

let usedOracleDuringSolve = false;
function evalOne(instanceId, patch, runId) {
  const preds = `/tmp/advisor-${runId}.jsonl`;
  writeFileSync(preds, JSON.stringify({ instance_id: instanceId, model_name_or_path: 'darwin-advisor', model_patch: patch }) + '\n');
  try { execSync(`. ${VENV}/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${preds} --instance_ids ${instanceId} --run_id ${runId} --max_workers 1 --cache_level instance --timeout 1200`, { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1500000, maxBuffer: 1 << 28 }); } catch { /**/ }
  let resolved = false; try { const rep = JSON.parse(readFileSync(`/tmp/darwin-advisor.${runId}.json`, 'utf8')); resolved = (rep.resolved_ids || []).includes(instanceId); } catch { /**/ }
  let logTail = ''; try { const lp = `/tmp/logs/run_evaluation/${runId}/darwin-advisor/${instanceId}/test_output.txt`; if (existsSync(lp)) { const t = readFileSync(lp, 'utf8'); logTail = t.split('\n').filter((l) => /FAIL|Error|assert|Traceback|^E |raise |\.py:[0-9]/.test(l)).slice(-40).join('\n').slice(-2500); } } catch { /**/ }
  return { resolved, logTail };
}
const PY_PROFILE = langProfile({ lang: 'py' });
function existingTestTargets(diff, prof = PY_PROFILE) {
  const extAlt = prof.srcGlobs.map((g2) => g2.replace(/^\*\./, '').replace(/\./g, '\\.')).join('|');
  const re = new RegExp(`^\\+\\+\\+ b/(.+\\.(?:${extAlt}))$`, 'gm');
  const files = [...diff.matchAll(re)].map((m) => m[1]).filter((f) => !prof.testPathRegex(f));
  const targets = new Set();
  for (const f of files) for (const t of prof.testTargets(f)) targets.add(t);
  return [...targets].slice(0, 4);
}
function runRepoTests(instanceId, diff, prof = PY_PROFILE) {
  const targets = existingTestTargets(diff, prof);
  if (targets.length === 0) return { resolved: false, logTail: 'no source files changed yet — write a fix, then tests run' };
  const r = runConformantTests(instanceId, diff, prof.testRunnerCmd(targets), { timeoutMs: 420000 });
  return { resolved: r.ran && r.passed, logTail: (r.ran ? '' : '[tests could not run] ') + r.logTail };
}

writeFileSync(OUT, ''); const report = []; let totalCost = 0;
const allVetoedPatches = []; // { instance_id, step, diff } — gold-scored per §4.7's counterfactual

async function runInstance(inst) {
  const t0 = Date.now();
  const row = { instance_id: inst.instance_id, repo: inst.repo, resolved: false };
  let patch = '';
  try {
    const work = fetchRepo(inst.repo, inst.base_commit); let evalCount = 0;
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
        if (NO_ORACLE) return runRepoTests(inst.instance_id, g(work, 'git diff').toString(), prof);
        usedOracleDuringSolve = true;
        return evalOne(inst.instance_id, g(work, 'git diff').toString(), `adv_${inst.instance_id}_${++evalCount}`.replace(/[^a-zA-Z0-9_]/g, '_'));
      },
      MAX_OUT: 4000,
    };
    const res = await advisorSolve({
      problem: inst.problem_statement, io, llmLow, llmAdvisor,
      gate: makeAdvisorGate({ adviseAfterFails: ADVISE_AFTER_FAILS, cooldown: ADVISOR_COOLDOWN }),
      maxSteps: MAX_STEPS,
      system: GENOME
        ? buildSystemFromGenome(GENOME, prof.exampleExt, defGlob, { advised: !D0 })
        : (D0 ? buildAgenticSystem(prof.exampleExt, defGlob) : buildAdvisedSystem(prof.exampleExt, defGlob)),
      advisorSystem: (GENOME && !D0 && buildAdvisorSystemFromGenome(GENOME, prof.exampleExt)) || buildAdvisorSystem(prof.exampleExt),
      maxAdvisories: MAX_ADVISORIES, maxVetoes: MAX_VETOES, advisorMaxChars: ADVISOR_MAX_CHARS,
      tempSchedule: CHEB_TEMP ? ((s, n) => chebTemp(s, n)) : undefined,
    });
    patch = res.patch; totalCost += res.cost;
    row.steps = res.steps; row.submitted = res.submitted; row.resolvedInLoop = res.resolvedInLoop; row.resolved = !!res.resolvedInLoop;
    row.loopCost = Math.round(res.loopCost * 1e5) / 1e5; row.advisorCost = Math.round(res.advisorCost * 1e5) / 1e5;
    row.cost = Math.round(res.cost * 1e5) / 1e5;
    row.advisories = res.advisories.length;
    row.advisoriesByTrigger = res.advisories.reduce((m, a) => { m[a.trigger] = (m[a.trigger] || 0) + 1; return m; }, {});
    row.advisoryLog = res.advisories; // full records incl. capped advice excerpts (§4.8 contamination scan)
    row.vetoes = res.vetoes; row.executorActions = res.executorActions; row.thrash = res.thrash;
    for (const v of res.vetoedPatches) allVetoedPatches.push({ instance_id: inst.instance_id, step: v.step, diff: v.diff });
    if (TRANSCRIPTS_DIR) { try { writeFileSync(join(TRANSCRIPTS_DIR, inst.instance_id.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.json'), JSON.stringify({ instance_id: inst.instance_id, resolvedInLoop: res.resolvedInLoop, steps: res.steps, thrash: res.thrash, cost: res.cost, transcript: res.transcript })); } catch { /**/ } }
    try { rmSync(work, { recursive: true, force: true }); } catch { /**/ }
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); }
  appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: 'darwin-advisor', model_patch: patch }) + '\n');
  row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} inloop=${row.resolvedInLoop} adv=${row.advisories} vetoes=${row.vetoes} exec=${row.executorActions}/${row.steps} $${row.cost} (loop $${row.loopCost}+advisor $${row.advisorCost}) ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
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
const totLoop = report.reduce((s, r) => s + (r.loopCost || 0), 0);
const totAdvisor = report.reduce((s, r) => s + (r.advisorCost || 0), 0);
const totAdvisories = report.reduce((s, r) => s + (r.advisories || 0), 0);
const advisoriesByTrigger = report.reduce((m, r) => { for (const [k, v] of Object.entries(r.advisoriesByTrigger || {})) m[k] = (m[k] || 0) + v; return m; }, {});
const totVetoes = report.reduce((s, r) => s + (r.vetoes || 0), 0);
const conformant = NO_ORACLE && !usedOracleDuringSolve;
if (NO_ORACLE && usedOracleDuringSolve) console.error('⚠️ LEAKAGE: gold harness was called during solve despite --no-test-oracle.');
writeFileSync(REPORT, JSON.stringify({
  mode: 'advisor', model: MODEL, advisorModel: ADVISOR_MODEL, d0: D0, maxSteps: MAX_STEPS,
  genome: GENOME ? (GENOME.meta?.id ?? GENOME_PATH) : null,
  gate: { adviseAfterFails: ADVISE_AFTER_FAILS, cooldown: ADVISOR_COOLDOWN },
  maxAdvisories: MAX_ADVISORIES, maxVetoes: MAX_VETOES, advisorMaxChars: ADVISOR_MAX_CHARS,
  modelParams: { temperature: TEMP, chebTemp: CHEB_TEMP, maxTokens: MAX_TOKENS },
  n: report.length, resolvedInLoop: inloop, noTestOracle: NO_ORACLE, leaderboardConformant: conformant,
  cappedAtInstance: cappedAt, maxCost: MAX_COST === Infinity ? null : MAX_COST,
  totalCost_usd: Math.round(totalCost * 1e4) / 1e4,
  loopCost_usd: Math.round(totLoop * 1e4) / 1e4, advisorCost_usd: Math.round(totAdvisor * 1e4) / 1e4,
  advisorCostFraction: totalCost ? Math.round(totAdvisor / totalCost * 1000) / 1000 : 0,
  totalAdvisories: totAdvisories, advisoriesByTrigger, totalVetoes: totVetoes,
  avgAdvisorCallsPerInst: report.length ? Math.round((totAdvisories) / report.length * 100) / 100 : 0,
  executorActionsPerInst: report.map((r) => r.executorActions ?? null),
  costPerInst_usd: report.length ? Math.round(totalCost / report.length * 1e5) / 1e5 : 0,
  costPerResolved_usd: inloop ? Math.round(totalCost / inloop * 1e5) / 1e5 : null,
  observedModels,
  vetoedPatches: allVetoedPatches,
  instances: report,
}, null, 2));
console.error(`\nDONE ${report.length} | in-loop ${inloop}/${report.length} | advisories=${totAdvisories} ${JSON.stringify(advisoriesByTrigger)} vetoes=${totVetoes} | $${Math.round(totalCost * 1e4) / 1e4} (loop $${Math.round(totLoop * 1e4) / 1e4} + advisor $${Math.round(totAdvisor * 1e4) / 1e4}) | preds → ${OUT}`);
