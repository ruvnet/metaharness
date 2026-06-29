// SPDX-License-Identifier: MIT
//
// solve-gaia.mjs — the GAIA-class AGENTIC solver (realizes ADAPTER.md §3b).
//
// A bounded ReAct loop over a keyless Wikipedia tool surface (search/open/submit)
// for multi-hop general-assistant QA. Dataset-agnostic: consumes a manifest of
// { task_id, question, answer, ... } and produces, per task, a single short
// FINAL_ANSWER string scored offline by score-gaia.mjs (exact-match, GAIA-style).
//
// It REUSES the battle-tested swebench pieces verbatim in spirit:
//   - the OpenRouter llm() client with per-call usage.cost capture
//   - the --max-cost budget gate inside the worker pool
//   - JSONL streaming + per-task report + concurrency
//   - parseAction / stateHash (anti-thrash) from agentic-loop.mjs
// The ONLY differences vs. solve-agentic.mjs are the tool surface (web/wiki, not
// code edits) and the terminal action (submit an ANSWER string, not a patch).
//
// LEAK-FREE: the gold `answer` field is never placed in any prompt. The solver
// only ever sees `question`. (Asserted by the absence of `.answer` reads below.)
//
// Run:
//   OPENROUTER_API_KEY=$KEY node --experimental-strip-types --no-warnings \
//     solve-gaia.mjs --manifest manifest-frames.json --model deepseek/deepseek-v4-pro \
//     --max-steps 12 --concurrency 4 --max-cost 3 --out preds.jsonl --report report.json

// SCAFFOLDING UPGRADES (ADR — intelligence-via-scaffolding ablation):
//   --scaffold none|reflexion|plan|verifier-bon  toggles an intelligence upgrade on the
//   SAME base ReAct episode. All are prompt/orchestration-level (no `reasoning` API param,
//   so consistent with the reasoning-OFF prior FRAMES runs). See scaffolds.mjs.

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAction, stateHash } from '../swebench/agentic-loop.mjs';
import { searchWiki, openWiki } from './wiki-tools.mjs';
import { solveWithScaffold, mockDeps } from './scaffolds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const MAX_STEPS = +argv('--max-steps', 12);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 4));
const MAX_COST = +argv('--max-cost', Infinity);
const TEMP = +argv('--temperature', 0);
const SAMPLE = +argv('--sample', 0);
const MAX_OUT = +argv('--max-out', 6000);
// Scaffold toggles.
const SCAFFOLD = argv('--scaffold', 'none');           // none | reflexion | plan | verifier-bon
const SAMPLES = +argv('--samples', 3);                  // verifier-bon: N candidate episodes
const SAMPLE_TEMP = +argv('--sample-temp', 0.7);        // verifier-bon: diversity temperature
const REFLEXION_ROUNDS = +argv('--reflexion-rounds', 2);// reflexion: max extra retries
const TAU = +argv('--tau', 0.7);                        // reflexion: confidence threshold to stop
const RESPAWNS = +argv('--respawns', 2);                // failfast: max drop+respawn rounds
const SHORT_STEPS = +argv('--short-steps', 2);          // failfast: per-episode step cap
const MOCK = has('--mock');                             // $0 offline wiring test
// Account-meter guard (mirrors ruvector-eval.mjs): --abort-usage is the ABSOLUTE USD ceiling on
// the OpenRouter key at which we stop launching new tasks (the authoritative budget gate).
const METER = has('--meter');
const ABORT_USAGE = +argv('--abort-usage', Infinity);
const OUT = rel(argv('--out', 'preds-gaia.jsonl'));
const REPORT = rel(argv('--report', 'solve-gaia-report.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key && !MOCK) { console.error('FATAL: no API key (set OPENROUTER_API_KEY or /tmp/.orkey), or pass --mock'); process.exit(1); }

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest-frames.json')), 'utf8')).tasks;
if (SAMPLE > 0) manifest = manifest.slice(0, SAMPLE);

// OpenRouter chat client — mirrors solve-agentic.mjs mkLlm: retry on 429/5xx,
// returns { raw, cost }. `usage:{include:true}` forces OpenRouter to return cost.
function mkLlm(model) {
  return async function (messages, temp) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator', 'X-Title': 'darwin-frames-bench' },
          body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: (temp ?? TEMP), usage: { include: true } }),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
// Dependency bundle for the scaffolds. --mock swaps in a deterministic offline LLM+tools ($0).
const deps = MOCK ? { ...mockDeps(), parseAction, stateHash } : { llm: mkLlm(MODEL), searchWiki, openWiki, parseAction, stateHash };
const scaffoldOpts = { scaffold: SCAFFOLD, maxSteps: MAX_STEPS, maxOut: MAX_OUT, temp: TEMP,
  samples: SAMPLES, sampleTemp: SAMPLE_TEMP, reflexionRounds: REFLEXION_ROUNDS, tau: TAU,
  respawns: RESPAWNS, shortSteps: SHORT_STEPS };

// One task → the chosen scaffold's solve (base ReAct when --scaffold none).
async function solveOne(task) { return solveWithScaffold(task, deps, scaffoldOpts); }

// Account-meter gate (authoritative budget guard): poll the OpenRouter key's absolute USD usage.
async function accountUsage() {
  try {
    const r = await fetch(`${BASE_URL.replace(/\/api\/v1$/, '/api/v1')}/key`, { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json(); return Number(j?.data?.usage);
  } catch { return NaN; }
}

writeFileSync(OUT, '');
const report = [];
let totalCost = 0, cursor = 0, cappedAt = null, meterStopped = false;

async function runTask(task) {
  const t0 = Date.now();
  const row = { task_id: task.task_id, reasoning_types: task.reasoning_types || '' };
  let extra = {};
  try {
    const r = await solveOne(task);
    row.model_answer = r.answer; row.steps = r.steps; row.submitted = r.submitted; row.cost_usd = Math.round(r.cost * 1e6) / 1e6;
    row.episodes = r.episodes ?? 1; extra = r.extra || {};
    totalCost += r.cost;
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); row.model_answer = ''; row.cost_usd = 0; }
  row.sec = Math.round((Date.now() - t0) / 1000);
  // Prediction row consumed by score-gaia.mjs. model_answer = the scaffold's PRIMARY answer
  // (verifier pick for *-bon). majority_answer = the naive self-consistency vote (scored via
  // score-gaia --answer-field majority_answer) so SC vs verifier is an EQUAL-COST comparison off
  // the SAME samples. candidate_answers enables the offline SC cost-curve (N=3,5,…). Gold stays in manifest.
  appendFileSync(OUT, JSON.stringify({
    task_id: row.task_id, model: MODEL, scaffold: SCAFFOLD, model_answer: row.model_answer,
    majority_answer: extra.majority_answer, candidate_answers: extra.candidate_answers,
    cost_usd: row.cost_usd, steps: row.steps, episodes: row.episodes, reasoning_types: row.reasoning_types,
  }) + '\n');
  report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${row.task_id} steps=${row.steps ?? '-'} $${(row.cost_usd ?? 0).toFixed(4)} ${row.sec}s ans="${String(row.model_answer).slice(0, 50)}"${row.error ? ' ERR:' + row.error : ''}`);
}

// Periodic account-meter poll (one poller, not per-task) so --abort-usage halts new launches
// the moment the ABSOLUTE OpenRouter usage crosses the ceiling.
async function meterLoop() {
  if (!METER || !Number.isFinite(ABORT_USAGE)) return;
  while (cursor < manifest.length && !meterStopped) {
    const u = await accountUsage();
    if (Number.isFinite(u)) { console.error(`[meter] account usage $${u.toFixed(2)} / abort $${ABORT_USAGE}`); if (u >= ABORT_USAGE) { meterStopped = true; console.error(`[meter] ABORT — usage ≥ ceiling; no new tasks launched.`); break; } }
    await new Promise((r) => setTimeout(r, 20000));
  }
}

async function worker() {
  while (cursor < manifest.length) {
    if (meterStopped) { if (cappedAt === null) cappedAt = report.length; return; }
    if (totalCost >= MAX_COST) { if (cappedAt === null) { cappedAt = report.length; console.error(`[max-cost] $${totalCost.toFixed(2)} ≥ cap $${MAX_COST} — stopping after in-flight (${report.length}/${manifest.length})`); } return; }
    await runTask(manifest[cursor++]);
  }
}
await Promise.all([meterLoop(), ...Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker())]);
meterStopped = true;

writeFileSync(REPORT, JSON.stringify({
  model: MODEL, dataset: 'frames', scaffold: SCAFFOLD, maxSteps: MAX_STEPS,
  samples: (SCAFFOLD === 'verifier-bon' || SCAFFOLD === 'ps-bon') ? SAMPLES : undefined,
  reasoning: 'off (no reasoning API param; scaffolds are prompt/orchestration-level only)',
  n: report.length,
  cappedAtTask: cappedAt, maxCost: MAX_COST === Infinity ? null : MAX_COST,
  totalCost_usd: Math.round(totalCost * 1e4) / 1e4,
  costPerTask_usd: report.length ? Math.round(totalCost / report.length * 1e6) / 1e6 : 0,
  tasks: report,
}, null, 2));
console.error(`\nDONE ${SCAFFOLD} ${MODEL} ${report.length} | $${(Math.round(totalCost * 1e4) / 1e4)} (${report.length ? (totalCost / report.length).toFixed(5) : 0}/task) | preds → ${OUT}`);
