// SPDX-License-Identifier: MIT
//
// BFCL loader — Berkeley Function-Calling Leaderboard (Patil et al.), the
// gold-standard open TOOL-USE / function-calling benchmark. This covers the
// "tool-use / office work" axis of the cheap-vs-frontier thesis (FRAMES covers
// the general-assistant QA axis).
//
// Why BFCL over tau-bench for THIS batch: tau-bench needs a full stateful env
// (tools + DB + a user-simulator LLM) — multi-day + extra cost + nondeterminism.
// BFCL is single-turn, gold-graded by AST match (no user-sim, no execution for
// the simple/multiple/parallel categories), so it stands up cleanly in budget and
// is leak-free (the gold `ground_truth` is never shown to the graded model).
// Source: https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard
//
// Categories used (single-turn, AST-graded): simple (1 fn, 1 call), multiple
// (several fns, pick 1), parallel (1 fn, several calls). Seeded sample → SAME
// tasks for every graded model. Emits manifest:
//   { dataset, n, tasks: [{ task_id, category, messages, tools, ground_truth }] }
//
// Run: node --experimental-strip-types bfcl-loader.mjs --per-cat 50 --out manifest-bfcl.json

import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const PER_CAT = +argv('--per-cat', 50);
const SEED = +argv('--seed', 42);
const OUT = rel(argv('--out', 'manifest-bfcl.json'));
const CATS = (argv('--cats', 'simple,multiple,parallel')).split(',');
const BASE = 'https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/resolve/main';

function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, seed) { const r = rng(seed); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function fetchJsonl(url) {
  for (let a = 0; a < 4; a++) {
    if (a) await new Promise((r) => setTimeout(r, 1000 * 2 ** (a - 1)));
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) { if (res.status === 429 || res.status >= 500) continue; throw new Error(`http ${res.status} ${url}`); }
      const txt = await res.text();
      return txt.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { if (a === 3) throw e; }
  }
  throw new Error('fetch failed ' + url);
}

// BFCL parameter types aren't all valid JSON-schema. Coerce so OpenRouter/models
// accept the `tools` schema. (float/double→number, tuple→array, dict→object, …)
const TYPE_MAP = { integer: 'integer', float: 'number', double: 'number', number: 'number', string: 'string', boolean: 'boolean', bool: 'boolean', array: 'array', tuple: 'array', list: 'array', object: 'object', dict: 'object', hashmap: 'object', any: 'string' };
function sanitizeSchema(s) {
  if (!s || typeof s !== 'object') return { type: 'string' };
  const out = { ...s };
  if (typeof out.type === 'string') out.type = TYPE_MAP[out.type.toLowerCase()] || 'string';
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, sanitizeSchema(v)]));
  }
  if (out.items) out.items = sanitizeSchema(out.items);
  // JSON-schema doesn't allow these BFCL-isms at the property level; drop quietly.
  delete out.default;
  return out;
}
function toTool(fn) {
  return { type: 'function', function: { name: fn.name, description: (fn.description || '').slice(0, 1024), parameters: sanitizeSchema(fn.parameters || { type: 'object', properties: {} }) } };
}

async function main() {
  const gold = new Map();
  const allTasks = [];
  for (const cat of CATS) {
    const [rows, golds] = await Promise.all([
      fetchJsonl(`${BASE}/BFCL_v3_${cat}.json`),
      fetchJsonl(`${BASE}/possible_answer/BFCL_v3_${cat}.json`),
    ]);
    for (const g of golds) gold.set(g.id, g.ground_truth);
    let tasks = rows.map((o) => ({
      task_id: o.id,
      category: cat,
      messages: o.question?.[0] || [],          // single-turn: question[0] is the messages list
      tools: (o.function || []).map(toTool),
      ground_truth: gold.get(o.id) || [],
    })).filter((t) => t.messages.length && t.tools.length && t.ground_truth.length);
    tasks = shuffle(tasks, SEED + cat.length).slice(0, PER_CAT);
    allTasks.push(...tasks);
    process.stderr.write(`  ${cat}: ${tasks.length} tasks\n`);
  }
  writeFileSync(OUT, JSON.stringify({ dataset: 'bfcl_v3', categories: CATS, seed: SEED, n: allTasks.length, tasks: allTasks }, null, 2));
  console.error(`wrote ${allTasks.length} tasks → ${OUT}`);
}
main().catch((e) => { console.error('loader failed:', e); process.exit(1); });
