// SPDX-License-Identifier: MIT
//
// solve-bfcl.mjs — BFCL function-calling solver (single-turn, native tool-calling).
//
// For each task: send the user message(s) + the function schema(s) as OpenRouter
// `tools` with tool_choice:'auto' (the faithful test — the model must DECIDE to
// call and emit correct arguments). Records the emitted tool_calls for offline
// AST grading by score-bfcl.mjs. One API call per task (single-turn) → cheap.
//
// Reuses the swebench/FRAMES cost+budget plumbing: OpenRouter client with
// per-call usage.cost, --max-cost gate in a worker pool, JSONL streaming.
// LEAK-FREE: the gold `ground_truth` is never sent to the model.
//
// Run: OPENROUTER_API_KEY=$KEY node --experimental-strip-types --no-warnings \
//   solve-bfcl.mjs --manifest manifest-bfcl.json --model deepseek/deepseek-v4-pro \
//   --concurrency 4 --max-cost 2 --out preds.jsonl --report report.json

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const CONCURRENCY = Math.max(1, +argv('--concurrency', 4));
const MAX_COST = +argv('--max-cost', Infinity);
const SAMPLE = +argv('--sample', 0);
const OUT = rel(argv('--out', 'preds-bfcl.jsonl'));
const REPORT = rel(argv('--report', 'solve-bfcl-report.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key) { console.error('FATAL: no API key'); process.exit(1); }

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest-bfcl.json')), 'utf8')).tasks;
if (SAMPLE > 0) manifest = manifest.slice(0, SAMPLE);

async function callModel(messages, tools) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator', 'X-Title': 'darwin-bfcl-bench' },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: 1024, usage: { include: true } }),
      });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json();
      const msg = j.choices?.[0]?.message ?? {};
      const calls = (msg.tool_calls || []).map((tc) => {
        let argsObj = {};
        try { argsObj = JSON.parse(tc.function?.arguments || '{}'); } catch { argsObj = { __unparseable: tc.function?.arguments || '' }; }
        return { name: tc.function?.name, args: argsObj };
      });
      return { calls, cost: j.usage?.cost ?? 0, text: msg.content || '' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('llm failed');
}

writeFileSync(OUT, '');
const report = [];
let totalCost = 0, cursor = 0, cappedAt = null;

async function runTask(task) {
  const t0 = Date.now();
  const row = { task_id: task.task_id, category: task.category };
  try {
    const r = await callModel(task.messages, task.tools);
    row.calls = r.calls; row.n_calls = r.calls.length; row.cost_usd = Math.round(r.cost * 1e6) / 1e6; row.no_call = r.calls.length === 0;
    totalCost += r.cost;
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); row.calls = []; row.cost_usd = 0; }
  row.sec = Math.round((Date.now() - t0) / 1000);
  appendFileSync(OUT, JSON.stringify({ task_id: row.task_id, model: MODEL, category: row.category, calls: row.calls, cost_usd: row.cost_usd }) + '\n');
  report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${row.task_id} (${row.category}) calls=${row.n_calls ?? 0} $${(row.cost_usd ?? 0).toFixed(5)}${row.error ? ' ERR:' + row.error : ''}`);
}

async function worker() {
  while (cursor < manifest.length) {
    if (totalCost >= MAX_COST) { if (cappedAt === null) { cappedAt = report.length; console.error(`[max-cost] $${totalCost.toFixed(2)} ≥ cap $${MAX_COST} — stopping (${report.length}/${manifest.length})`); } return; }
    await runTask(manifest[cursor++]);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, manifest.length) }, () => worker()));

writeFileSync(REPORT, JSON.stringify({
  model: MODEL, dataset: 'bfcl_v3', n: report.length, cappedAtTask: cappedAt,
  maxCost: MAX_COST === Infinity ? null : MAX_COST,
  totalCost_usd: Math.round(totalCost * 1e4) / 1e4,
  costPerTask_usd: report.length ? Math.round(totalCost / report.length * 1e6) / 1e6 : 0,
  tasks: report,
}, null, 2));
console.error(`\nDONE ${report.length} | $${(Math.round(totalCost * 1e4) / 1e4)} (${report.length ? (totalCost / report.length).toFixed(5) : 0}/task) | preds → ${OUT}`);
