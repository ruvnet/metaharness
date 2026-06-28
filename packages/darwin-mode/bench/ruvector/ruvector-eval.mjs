// SPDX-License-Identifier: MIT
//
// ruvector-eval.mjs — the ADR-201 A/B/C ablation runner skeleton.
//
//   Control A : dense in-process RAG, hard bail → Opus @ step budget
//   Test B    : ruvector (RVF) RAG, static hard bail @ budget
//   Test C    : ruvector (RVF) RAG, DYNAMIC bail (confidence < τ → escalate early)
//
// It plugs the memory-layer seam (memory-layer.mjs) into a retrieval-augmented ReAct/QA loop and
// emits the full ADR-201 telemetry (Retrieval Lift Δ, Compression Cr, Turn-Budget Survival S_T,
// Cost-Adjusted Lift L_C, context-length-vs-resolve). Per-task preds exfil via exfil.mjs.
//
// CONFORMANCE: the gold `answer` is used ONLY by the offline scorer — never placed in any prompt
// and never passed to memory.feedback(). (Asserted: the prompt builder reads task.question/problem
// and retrieved corpus text only.)
//
// RUN ($0 dry-run, fully mocked — proves A/B wiring + Cr/Δ math, no network, no GCP):
//   RUVECTOR_PATH=/path/to/ruvector@0.2.x node ruvector-eval.mjs --arm all --synthetic 40 --mock
//
// RUN (paid, budget-gated — see README "Budget gate"):
//   OPENROUTER_API_KEY=$KEY node ruvector-eval.mjs --arm all \
//     --manifest manifest-frames.json --model deepseek/deepseek-v4-pro \
//     --escalate anthropic/claude-opus-4 --k 8 --max-context-tokens 12000 \
//     --concurrency 4 --max-cost 5 --tau 0.35 --out preds.jsonl --report report.json --exfil

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMemory } from './memory-layer.mjs';
import { compareArms, summarizeArm } from './telemetry.mjs';
import { makeExfil } from './exfil.mjs';
import { makeSyntheticManifest, normalizeAnswer, mockLlm } from './synthetic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const ARM = argv('--arm', 'all');                 // A | B | C | all
const SYNTH = +argv('--synthetic', 0);            // >0 → self-generate N tasks (no external data)
const MOCK = has('--mock');                        // deterministic mock LLM ($0, offline)
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const ESCALATE = argv('--escalate', 'anthropic/claude-opus-4');
const K = +argv('--k', 8);
const MAX_CTX_TOK = +argv('--max-context-tokens', 12000);
const MAX_STEPS = +argv('--max-steps', 1);        // 1-step RAG-QA in the skeleton; raise for ReAct
const TAU = +argv('--tau', 0.35);                  // arm-C dynamic-bail confidence threshold
const CONCURRENCY = Math.max(1, +argv('--concurrency', 4));
const MAX_COST = +argv('--max-cost', Infinity);
const OUT = rel(argv('--out', 'preds-ruvector.jsonl'));
const REPORT = rel(argv('--report', 'report-ruvector.json'));
const EXFIL = has('--exfil');
const SEED = +argv('--seed', 42);
const RUN_ID = argv('--run-id', `adr201-${Date.now()}`);

// ── LLM client ────────────────────────────────────────────────────────────────────────────────
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');

function mkOpenRouterLlm(model) {
  const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
  if (!key) { console.error(`FATAL: no API key (set ${KEY_ENV} or /tmp/.orkey), or pass --mock`); process.exit(1); }
  return async function (messages, temp = 0.2) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      try {
        const res = await fetch(CHAT_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator', 'X-Title': 'adr201-ruvector-ablation' },
          body: JSON.stringify({ model, messages, max_tokens: 800, temperature: temp, usage: { include: true } }),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}

const RAG_SYSTEM = 'You are a precise assistant. Use ONLY the provided CONTEXT passages to answer the '
  + 'QUESTION. Reply with exactly one line: "FINAL_ANSWER: <short exact answer>". No explanation.';

function buildRagPrompt(question, hits) {
  const ctx = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n');
  // CONFORMANCE: only question + retrieved corpus text — no gold.
  return [
    { role: 'system', content: RAG_SYSTEM },
    { role: 'user', content: `CONTEXT:\n${ctx}\n\nQUESTION: ${question}\n\nFINAL_ANSWER:` },
  ];
}

function extractFinal(raw) {
  const m = String(raw).match(/FINAL_ANSWER:\s*(.+)/i);
  return (m ? m[1] : raw).trim().split('\n')[0].trim();
}

// ── one task on one arm ─────────────────────────────────────────────────────────────────────
async function runTask(task, { memory, baseLlm, escLlm, dynamicBail }) {
  const corpus = task.corpus || [];
  // fresh per-task index keeps tasks independent (mirrors per-instance localization).
  await memory.index(corpus);
  const { hits, tokens } = await memory.query(task.question || task.problem, { k: K, maxTokens: MAX_CTX_TOK });
  const confidence = hits.length ? hits[0].score : 0;

  let escalated = false; let cost = 0; let raw = '';
  const useEsc = dynamicBail && confidence < TAU;          // arm C: bail early when retrieval is weak
  if (useEsc) { escalated = true; const r = await escLlm(buildRagPrompt(task.question || task.problem, hits)); raw = r.raw; cost += r.cost; }
  else {
    const r = await baseLlm(buildRagPrompt(task.question || task.problem, hits)); raw = r.raw; cost += r.cost;
    // static hard bail (arms A/B): if base produced nothing usable, escalate at the budget edge.
    if (!dynamicBail && !extractFinal(raw)) { escalated = true; const e = await escLlm(buildRagPrompt(task.question || task.problem, hits)); raw = e.raw; cost += e.cost; }
  }

  const answer = extractFinal(raw);
  const resolved = scoreAnswer(answer, task.answer);
  const retrievedIds = hits.map((h) => h.id);
  return { id: task.id, resolved, escalated, answer, contextTokens: tokens, cost, confidence, retrievedIds, nHits: hits.length };
}

// offline scorer (GAIA/FRAMES-style normalized exact / containment). Gold used ONLY here.
function scoreAnswer(pred, gold) {
  if (gold == null) return false;
  const p = normalizeAnswer(pred); const g = normalizeAnswer(gold);
  if (!p || !g) return false;
  return p === g || p.includes(g) || g.includes(p);
}

// simple bounded worker pool with a shared cost budget gate.
async function runArm(armName, tasks, opts) {
  const records = [];
  let spent = 0; let stopped = false;
  let idx = 0;
  async function worker() {
    while (idx < tasks.length && !stopped) {
      const my = idx++;
      const task = tasks[my];
      // each arm gets its OWN memory instance (independent index); same embedder → fair A/B.
      const memory = makeMemory(opts.kind, { ...opts.memOpts });
      try {
        const rec = await runTask(task, { ...opts, memory });
        spent += rec.cost;
        records[my] = { arm: armName, ...rec };
        opts.exfil.write({ arm: armName, ...rec });
        if (opts.onRec) opts.onRec(records[my]);
        if (spent > MAX_COST) { stopped = true; console.error(`[${armName}] budget cap $${MAX_COST} hit at $${spent.toFixed(4)} — stopping`); }
      } finally { await memory.close(); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return records.filter(Boolean);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  let tasks;
  if (SYNTH > 0) { tasks = makeSyntheticManifest(SYNTH, SEED); console.error(`[synthetic] generated ${tasks.length} tasks (seed ${SEED})`); }
  else { tasks = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest.json')), 'utf8')).tasks; }

  const baseLlm = MOCK ? mockLlm({ tier: 'base' }) : mkOpenRouterLlm(MODEL);
  const escLlm = MOCK ? mockLlm({ tier: 'escalate' }) : mkOpenRouterLlm(ESCALATE);
  const exfil = makeExfil({ outPath: OUT, enabled: EXFIL, runId: RUN_ID });
  if (EXFIL) console.error(`[exfil] firestore=${exfil.enabled} collection=ruvector_ablation run=${RUN_ID}`);

  const arms = ARM === 'all' ? ['A', 'B', 'C'] : [ARM.toUpperCase()];
  const armCfg = {
    A: { kind: 'dense', dynamicBail: false, memOpts: { allowFallback: false } },
    B: { kind: 'ruvector', dynamicBail: false, memOpts: { graphrag: true, allowFallback: !EXFIL } },
    C: { kind: 'ruvector', dynamicBail: true, memOpts: { graphrag: true, allowFallback: !EXFIL } },
  };

  const results = {};
  for (const a of arms) {
    const cfg = armCfg[a];
    if (!cfg) { console.error(`unknown arm ${a}`); continue; }
    console.error(`\n=== ARM ${a} (${cfg.kind}${cfg.dynamicBail ? ', dynamic-bail τ=' + TAU : ''}) ===`);
    const recs = await runArm(a, tasks, { ...cfg, baseLlm, escLlm, exfil });
    results[a] = recs;
    const s = summarizeArm(recs);
    console.error(`  resolve=${(s.resolve * 100).toFixed(1)}% [${(s.resolveCI.lo * 100).toFixed(1)},${(s.resolveCI.hi * 100).toFixed(1)}]  S_T=${(s.survival_S_T * 100).toFixed(1)}%  ctxTok=${s.meanContextTokens.toFixed(0)}  $${s.totalCost.toFixed(4)}`);
  }

  // telemetry: compare each test arm to Control A (if present).
  const report = { runId: RUN_ID, ts: Date.now(), config: { ARM, SYNTH, MOCK, MODEL, ESCALATE, K, MAX_CTX_TOK, TAU, SEED }, arms: {}, comparisons: {} };
  for (const a of Object.keys(results)) report.arms[a] = summarizeArm(results[a]);
  if (results.A && results.B) report.comparisons['B_vs_A'] = compareArms(results.A, results.B);
  if (results.A && results.C) report.comparisons['C_vs_A'] = compareArms(results.A, results.C);

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error(`\nreport → ${REPORT}\npreds  → ${OUT}`);
  // headline
  for (const [name, cmp] of Object.entries(report.comparisons)) {
    console.error(`${name}: Δ=${(cmp.retrievalLift_delta * 100).toFixed(1)}pt  Cr=${(cmp.compression_Cr * 100).toFixed(1)}%  L_C=${cmp.costAdjustedLift_L_C}`);
  }
}

// only run when invoked directly (so tests can import the helpers above if needed)
if (process.argv[1] && process.argv[1].endsWith('ruvector-eval.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { runTask, runArm, scoreAnswer, buildRagPrompt, extractFinal };
