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

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAction, stateHash } from '../swebench/agentic-loop.mjs';
import { searchWiki, openWiki } from './wiki-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const MAX_STEPS = +argv('--max-steps', 12);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 4));
const MAX_COST = +argv('--max-cost', Infinity);
const TEMP = +argv('--temperature', 0);
const SAMPLE = +argv('--sample', 0);
const MAX_OUT = +argv('--max-out', 6000);
const OUT = rel(argv('--out', 'preds-gaia.jsonl'));
const REPORT = rel(argv('--report', 'solve-gaia-report.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key) { console.error('FATAL: no API key (set OPENROUTER_API_KEY or /tmp/.orkey)'); process.exit(1); }

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
const llm = mkLlm(MODEL);

const SYSTEM = 'You are a meticulous research assistant answering a hard, multi-step question by '
  + 'searching and reading Wikipedia. Each turn, output EXACTLY ONE JSON object on a single line — a '
  + 'tool call — and NOTHING else (no prose, no markdown). Tools:\n'
  + '{"tool":"search","query":"..."}                 full-text Wikipedia search → top titles + snippets\n'
  + '{"tool":"open","title":"Exact Page Title","query":"what you are looking for"}  read a page as plaintext (query focuses a long article)\n'
  + '{"tool":"submit","answer":"..."}                give your FINAL short answer and stop\n'
  + 'Strategy: decompose the question, search for each entity, open the relevant pages, chain the facts '
  + 'across pages (multi-hop), then submit. Keep the final answer SHORT and exact (a name, number, date, '
  + 'or short phrase) — no explanation, no units unless asked, no trailing punctuation. Output ONE JSON action per turn.';

// One bounded ReAct episode for a single question. Returns { answer, steps, cost, submitted }.
async function solveOne(task) {
  const transcript = [];
  let submitted = false, answer = '', cost = 0;
  const seen = new Set();
  const header = `QUESTION:\n${task.question}\n\nBegin. Output ONE JSON action.`;
  for (let step = 1; step <= MAX_STEPS && !submitted; step++) {
    const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-14000);
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: convo }];
    let raw = '';
    try { const r = await llm(messages); raw = r.raw; cost += r.cost || 0; }
    catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
    const action = parseAction(raw);
    let obs;
    if (action.tool === 'submit') { submitted = true; answer = String(action.answer ?? '').trim(); obs = 'submitted.'; }
    else if (action.tool === 'search') obs = await searchWiki(action.query, { limit: 6 });
    else if (action.tool === 'open') obs = await openWiki(action.title, action.query, { MAX_OUT });
    else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
    else obs = `error: unknown tool "${action.tool}". Valid: search, open, submit.`;
    // Anti-thrash (reuses the swebench stateHash): warn on exact repeated read-only action.
    if (action.tool === 'search' || action.tool === 'open') {
      const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
      if (seen.has(h)) obs += '\n⚠️ You already ran this exact action with this result. Change strategy or submit.';
      else seen.add(h);
    }
    transcript.push({ actionRaw: JSON.stringify(action).slice(0, 300), obs });
  }
  // If the model never submitted, salvage: ask once for a final answer from its transcript.
  if (!submitted) {
    try {
      const r = await llm([{ role: 'system', content: 'Give ONLY the final short answer to the question, no explanation.' },
        { role: 'user', content: `QUESTION:\n${task.question}\n\nYour research notes:\n${transcript.map((t) => t.obs).join('\n').slice(-8000)}\n\nFinal short answer:` }]);
      cost += r.cost || 0; answer = r.raw.trim().split('\n')[0].slice(0, 300);
    } catch { /* leave empty */ }
  }
  return { answer, steps: transcript.length, cost, submitted };
}

writeFileSync(OUT, '');
const report = [];
let totalCost = 0, cursor = 0, cappedAt = null;

async function runTask(task) {
  const t0 = Date.now();
  const row = { task_id: task.task_id, reasoning_types: task.reasoning_types || '' };
  try {
    const r = await solveOne(task);
    row.model_answer = r.answer; row.steps = r.steps; row.submitted = r.submitted; row.cost_usd = Math.round(r.cost * 1e6) / 1e6;
    totalCost += r.cost;
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); row.model_answer = ''; row.cost_usd = 0; }
  row.sec = Math.round((Date.now() - t0) / 1000);
  // Prediction row consumed by score-gaia.mjs (model_answer + cost; gold stays in manifest).
  appendFileSync(OUT, JSON.stringify({ task_id: row.task_id, model: MODEL, model_answer: row.model_answer, cost_usd: row.cost_usd, steps: row.steps, reasoning_types: row.reasoning_types }) + '\n');
  report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${row.task_id} steps=${row.steps ?? '-'} $${(row.cost_usd ?? 0).toFixed(4)} ${row.sec}s ans="${String(row.model_answer).slice(0, 50)}"${row.error ? ' ERR:' + row.error : ''}`);
}

async function worker() {
  while (cursor < manifest.length) {
    if (totalCost >= MAX_COST) { if (cappedAt === null) { cappedAt = report.length; console.error(`[max-cost] $${totalCost.toFixed(2)} ≥ cap $${MAX_COST} — stopping after in-flight (${report.length}/${manifest.length})`); } return; }
    await runTask(manifest[cursor++]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

writeFileSync(REPORT, JSON.stringify({
  model: MODEL, dataset: 'frames', maxSteps: MAX_STEPS, n: report.length,
  cappedAtTask: cappedAt, maxCost: MAX_COST === Infinity ? null : MAX_COST,
  totalCost_usd: Math.round(totalCost * 1e4) / 1e4,
  costPerTask_usd: report.length ? Math.round(totalCost / report.length * 1e6) / 1e6 : 0,
  tasks: report,
}, null, 2));
console.error(`\nDONE ${report.length} | $${(Math.round(totalCost * 1e4) / 1e4)} (${report.length ? (totalCost / report.length).toFixed(5) : 0}/task) | preds → ${OUT}`);
