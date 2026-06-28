// SPDX-License-Identifier: MIT
//
// h1-pilot.mjs — ADR-201 H1 "knowledge-flattening" pilot (dense-RAG only).
//
// QUESTION: does dense retrieval lift CHEAP models *disproportionately* over CURRENT frontier?
//   H1 holds iff Retrieval Lift Δ_cheap > Δ_frontier, where
//   Δ_model = resolve(model, +dense-RAG) − resolve(model, base no-RAG).
//
// DESIGN (per ADR-201 §H1, recalibrated):
//   • FRAMES (google/frames-benchmark) subset, n=40, seed 42 — SAME questions per model.
//   • 2 conditions × 3 models × 40 = 240 cells.
//       (0) base no-RAG  : parametric only — the model answers from its own knowledge.
//       (1) +dense-RAG   : DenseMemory cosine retrieval of a per-question Wikipedia corpus,
//                          k=8, ≤12k context tokens. (memory-layer.mjs DenseMemory + embedder.mjs.)
//   • Models: cheap deepseek/deepseek-v4-pro ; frontier openai/gpt-5.5 + anthropic/claude-opus-4.8.
//   • Metrics: per-cell resolve (Wilson 95% CI), Δ per model (paired bootstrap 95% CI),
//     disproportionality verdict (Δ_cheap − Δ_frontier, bootstrap CI), and the base no-RAG row
//     (the live cheap-vs-CURRENT-frontier parametric gap).
//
// CONFORMANCE FIREWALL (no gold leakage):
//   • The Wikipedia corpus is built from a search keyed on the QUESTION ONLY — the gold `answer`
//     is NEVER used to search, fetch, chunk, embed, retrieve, or prompt.
//   • The gold `answer` is read in exactly ONE place: the offline scorer (scoreAnswer), after the
//     model has already produced its prediction. (Asserted by construction below.)
//   • Corpus = public English Wikipedia plaintext (keyless MediaWiki API).
//
// H3/H4 (ruvector GraphRAG + GNN epoch self-learning) are DEFERRED: ruvector@0.2.32 ships neither a
// working GraphRAG/Cypher path (@ruvector/graph-node not bundled) nor a multi-vector RVF query
// (rvfStatus().totalVectors===1) — so "ruvector retrieval" ≡ the dense baseline at this version
// (ADR-201 §ruvector-reality). Only the dense arm is meaningful today; this pilot runs it.
//
// $0 DRY-RUN (mock LLM, offline, proves wiring + math):
//   node h1-pilot.mjs --mock --models deepseek/deepseek-v4-pro,openai/gpt-5.5,anthropic/claude-opus-4.8
//
// PAID RUN (budget-gated):
//   node h1-pilot.mjs --manifest data/manifest-frames-n40.json \
//     --models deepseek/deepseek-v4-pro,openai/gpt-5.5,anthropic/claude-opus-4.8 \
//     --k 8 --max-context-tokens 12000 --concurrency 3 \
//     --meter --max-cost 15 --abort-usage 2620 \
//     --out data/h1-preds.jsonl --report data/h1-report.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DenseMemory } from './memory-layer.mjs';
import { buildRagPrompt, extractFinal } from './ruvector-eval.mjs';

// ── GAIA scorer.py normalization, ported (faithful to score-gaia.mjs / the published FRAMES run).
// STRICT exact-match via numeric → list → string pathways. Used in EXACTLY one place (after the
// model has produced its prediction) — never in retrieval/prompting → conformance firewall holds.
// (Replaces the loose substring-containment scorer, which false-positived e.g. "$25" vs "$1,225".)
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normalizeNumberStr(gold);
  if (gn !== null) { const pn = normalizeNumberStr(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) {
    const pl = splitList(pred);
    if (pl.length !== gl.length) return false;
    return gl.every((g, i) => { const gnum = normalizeNumberStr(g); if (gnum !== null) { const pnum = normalizeNumberStr(pl[i]); return pnum !== null && pnum === gnum; } return normalizeStr(g) === normalizeStr(pl[i]); });
  }
  return normalizeStr(pred) === normalizeStr(gold);
}
function relaxedMatch(pred, gold) {
  const g = normalizeStr(gold), p = normalizeStr(pred);
  if (!g) return false;
  if (p.includes(g)) return true;
  const gt = g.split(' ').filter((t) => t.length > 1);
  return gt.length > 0 && gt.every((t) => p.includes(t));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MANIFEST = rel(argv('--manifest', 'data/manifest-frames-n40.json'));
const MODELS = argv('--models', 'deepseek/deepseek-v4-pro,openai/gpt-5.5,anthropic/claude-opus-4.8').split(',').map((s) => s.trim()).filter(Boolean);
const CHEAP = argv('--cheap', 'deepseek/deepseek-v4-pro');     // which model is "cheap" for the verdict
const K = +argv('--k', 8);
const MAX_CTX_TOK = +argv('--max-context-tokens', 12000);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 3));
const MOCK = has('--mock');
const SEED = +argv('--seed', 42);
const MAX_COST = +argv('--max-cost', Infinity);              // soft per-PROCESS USD cap (this run's spend)
const METER = has('--meter');
const ABORT_USAGE = +argv('--abort-usage', Infinity);        // ABSOLUTE account-usage ceiling (USD)
const MAX_TOKENS = +argv('--max-tokens', 1024);
const EMBEDDER = argv('--embedder', 'hashed');               // 'hashed' (scaffold default) | 'onnx' (all-MiniLM-L6-v2 semantic)
const RUVECTOR_PATH = argv('--ruvector', '/home/ruvultra/projects/ruvector/node_modules/ruvector');
const CORPUS_DIR = rel(argv('--corpus-cache', 'data/corpus-cache'));
const OUT = rel(argv('--out', 'data/h1-preds.jsonl'));
const REPORT = rel(argv('--report', 'data/h1-report.json'));
const BOOT = +argv('--bootstrap', 10000);

const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
function apiKey() {
  return (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
}

// ── Wikipedia corpus builder (keyless MediaWiki; QUESTION-ONLY; no gold) ───────────────────────
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const UA = 'darwin-adr201-h1/1.0 (https://github.com/ruvnet/agent-harness-generator; research)';
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();

let _wikiGate = Promise.resolve();
function wikiThrottle() { // serialize a polite ≥250ms gap between ALL wiki requests
  const prev = _wikiGate;
  let release;
  _wikiGate = new Promise((r) => { release = r; });
  return prev.then(() => new Promise((r) => setTimeout(() => { r(); setTimeout(release, 250); }, 0)));
}
async function wikiJson(params, attempts = 7) {
  const url = `${WIKI_API}?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`;
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    await wikiThrottle();
    if (a) await new Promise((r) => setTimeout(r, 1200 * 2 ** (a - 1)));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) { if (res.status === 429 || res.status >= 500) { lastErr = new Error(`http ${res.status}`); continue; } throw new Error(`http ${res.status}`); }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('wiki fetch failed');
}

async function searchTitles(query, limit = 6) {
  try {
    const j = await wikiJson({ action: 'query', list: 'search', srsearch: String(query).slice(0, 300), srlimit: String(limit), srprop: '' });
    return (j?.query?.search ?? []).map((h) => h.title);
  } catch { return []; }
}

// Derive search sub-queries from the QUESTION ONLY (no gold): the full question + quoted phrases
// + capitalized proper-noun spans. Multi-hop questions rarely match Wikipedia search verbatim, so
// entity spans recover the relevant pages. Leak-free by construction.
function deriveQueries(question) {
  const qs = [question];
  for (const m of question.match(/"([^"]{2,60})"|'([^']{2,60})'/g) || []) qs.push(m.replace(/['"]/g, ''));
  // capitalized spans (e.g. "Andrew Fluegelman", "Light Yagami", "Shonen Jump"); skip leading sentence-cap words
  const spans = question.match(/\b([A-Z][a-zA-Z0-9.'’-]+(?:\s+(?:of|the|de|and|&)?\s*[A-Z][a-zA-Z0-9.'’-]+)*)\b/g) || [];
  const stop = new Set(['As', 'If', 'What', 'Which', 'Who', 'How', 'When', 'Where', 'The', 'A', 'In', 'On', 'For', 'Is', 'Are', 'Was', 'Were', 'Of', 'At', 'July', 'June', 'January']);
  for (const s of spans) { const t = s.trim(); if (t.length > 3 && !stop.has(t)) qs.push(t); }
  for (const code of question.match(/\b[A-Z]{1,3}\d{1,4}\b/g) || []) qs.push(code);  // codes e.g. G40
  // content-keyword fallback (helps no-proper-noun questions like postcodes)
  const STOPW = new Set('the a an of to in on for is are was were be by with as at and or i you it this that what which who how when where my am moving nearby area as'.split(' '));
  const kw = (question.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 3 && !STOPW.has(w));
  if (kw.length) qs.push(kw.slice(0, 6).join(' '));
  // dedupe, keep order, cap
  return [...new Set(qs)].slice(0, 9);
}

async function fetchExtract(title, maxChars = 14000) {
  const j = await wikiJson({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: String(title) });
  const page = Object.values(j?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  const text = String(page.extract || '').slice(0, maxChars);
  return text.trim() ? { title: page.title, text } : null;
}

// Chunk a page extract into ~120-word passages on paragraph boundaries.
function chunkText(title, text, words = 120) {
  const paras = text.split(/\n{1,}/).map((p) => p.trim()).filter((p) => p.length > 40);
  const chunks = [];
  let buf = [];
  let n = 0;
  const flush = () => { if (buf.length) { chunks.push(`${title}: ${buf.join(' ')}`); buf = []; n = 0; } };
  for (const p of paras) {
    const w = p.split(/\s+/);
    if (n + w.length > words && buf.length) flush();
    buf.push(p); n += w.length;
    if (n >= words) flush();
  }
  flush();
  return chunks;
}

// Build (and disk-cache) the per-question corpus. QUESTION-ONLY search → leak-free.
async function buildCorpus(task) {
  const cacheFile = join(CORPUS_DIR, `${task.task_id}.json`);
  if (existsSync(cacheFile)) {
    try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* rebuild */ }
  }
  const queries = deriveQueries(task.question);
  const titleSet = new Set();
  for (const q of queries) {
    const n = q === task.question ? 6 : 3;
    for (const t of await searchTitles(q, n)) titleSet.add(t);
    if (titleSet.size >= 10) break;
  }
  const titles = [...titleSet].slice(0, 10);
  const passages = [];
  let pid = 0;
  for (const title of titles) {
    let page = null;
    try { page = await fetchExtract(title); } catch { page = null; }
    if (!page) continue;
    for (const ch of chunkText(page.title, page.text)) passages.push({ id: `${task.task_id}-p${pid++}`, text: ch });
  }
  const corpus = { task_id: task.task_id, titles, nPassages: passages.length, passages };
  mkdirSync(CORPUS_DIR, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(corpus));
  return corpus;
}

// ── embedder selection ───────────────────────────────────────────────────────────────────────
// 'hashed' = the scaffold's keyless lexical bag-of-bigrams embedder (embedder.mjs default).
// 'onnx'   = ruvector's real all-MiniLM-L6-v2 (384-d semantic, local, $0) — a ROBUSTNESS arm to
//            rule out "the null is just a weak lexical retriever". Calls are serialized (the ONNX
//            session is not reentrant) and answered through the DenseMemory `embed` hook.
let _denseOpts = {};
async function initEmbedder() {
  if (EMBEDDER === 'hashed') { _denseOpts = {}; return; }
  if (EMBEDDER !== 'onnx') throw new Error(`unknown --embedder ${EMBEDDER}`);
  const require = createRequire(import.meta.url);
  const rv = require(RUVECTOR_PATH);
  if (!(rv.OnnxEmbedder && (!rv.isOnnxAvailable || rv.isOnnxAvailable()))) throw new Error('ruvector OnnxEmbedder not available');
  const e = new rv.OnnxEmbedder();
  if (e.init) await e.init();
  const toArr = (v) => (Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : (v?.data ? Array.from(v.data) : Array.from(v || [])));
  // serialize embed calls (ONNX session.run not safe under concurrency)
  let gate = Promise.resolve();
  const embed = (text) => { const p = gate.then(() => e.embed(String(text)).then(toArr)); gate = p.catch(() => {}); return p; };
  // probe dim
  const probe = await embed('dimension probe');
  _denseOpts = { embed, dim: probe.length };
  console.error(`[embedder] onnx all-MiniLM-L6-v2 ready: ${probe.length}-d`);
}
const makeDense = () => new DenseMemory(_denseOpts);

// ── LLM client ─────────────────────────────────────────────────────────────────────────────────
const NORAG_SYSTEM = 'You are a precise assistant. Answer the QUESTION using your own knowledge. '
  + 'Reply with exactly one line: "FINAL_ANSWER: <short exact answer>". No explanation. '
  + 'If you do not know, give your single best guess.';
function buildNoRagPrompt(question) {
  return [
    { role: 'system', content: NORAG_SYSTEM },
    { role: 'user', content: `QUESTION: ${question}\n\nFINAL_ANSWER:` },
  ];
}

function mkLlm(model) {
  if (MOCK) {
    // deterministic mock: dense-RAG "knows" more than parametric, and the cheap model gains more.
    return async (messages) => {
      const isRag = messages.some((m) => /CONTEXT:/.test(m.content));
      const q = messages[messages.length - 1].content;
      const base = model.includes('deepseek') ? 0.25 : 0.45;     // cheap weaker parametric
      const lift = model.includes('deepseek') ? 0.30 : 0.10;     // cheap gains more from RAG
      const p = isRag ? base + lift : base;
      const h = [...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) / 2 ** 32;
      return { raw: `FINAL_ANSWER: ${h < p ? '__CORRECT__' : 'wrong'}`, cost: 0, usage: {} };
    };
  }
  const key = apiKey();
  if (!key) { console.error(`FATAL: no API key (set ${KEY_ENV} or /tmp/.orkey), or pass --mock`); process.exit(1); }
  return async (messages, temp = 0.1) => {
    let lastErr;
    for (let a = 0; a < 5; a++) {
      if (a) await new Promise((r) => setTimeout(r, 2000 * 2 ** (a - 1)));
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator', 'X-Title': 'adr201-h1-pilot' },
          // reasoning DISABLED (uniform across all 3 models, both conditions): the reasoning models
          // (deepseek-v4-pro, gpt-5.5) otherwise consume the ENTIRE max_tokens budget on hidden
          // reasoning and emit EMPTY content (verified: ct=1024, content=""), which both voids the
          // answer and costs ~40× more. Disabling makes this a fair, cost-bounded single-shot RAG-QA
          // and keeps the no-RAG-vs-+RAG Δ comparison clean within and across models.
          body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: temp, reasoning: { enabled: false }, usage: { include: true } }),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        if (j.error) { lastErr = new Error(j.error.message || 'api error'); continue; }
        return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0, usage: j.usage ?? {} };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}

async function orUsage() {
  try {
    const key = apiKey();
    if (!key) return null;
    const res = await fetch(`${BASE_URL}/auth/key`, { headers: { Authorization: `Bearer ${key}` } });
    const j = await res.json();
    return typeof j?.data?.usage === 'number' ? j.data.usage : null;
  } catch { return null; }
}

// ── stats ────────────────────────────────────────────────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}
function mulberry32(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pctl = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

// ── main ────────────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const tasks = manifest.tasks;
  console.error(`[h1] ${tasks.length} FRAMES tasks (seed ${manifest.seed}); models=${MODELS.join(', ')}; embedder=${EMBEDDER}`);
  await initEmbedder();

  // 1) Build corpora (cached). QUESTION-ONLY → no gold leak.
  console.error('[corpus] building/loading per-question Wikipedia corpora …');
  const corpora = {};
  let cIdx = 0;
  async function cWorker() {
    while (cIdx < tasks.length) { const t = tasks[cIdx++]; corpora[t.task_id] = await buildCorpus(t); }
  }
  await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, cWorker));
  const corpStats = Object.values(corpora).map((c) => c.nPassages);
  console.error(`[corpus] ready: ${corpStats.length} corpora, mean ${(corpStats.reduce((a, b) => a + b, 0) / corpStats.length).toFixed(1)} passages/q (min ${Math.min(...corpStats)}, max ${Math.max(...corpStats)})`);

  // 2) Run conditions per model (SEQUENTIAL across models → meter-gate between each).
  const preds = [];
  const out = [];
  const cells = {};          // model -> { base:[bool×40], rag:[bool×40], cost, ragTokens:[] }
  let spent = 0;
  const skipped = {};
  for (const model of MODELS) {
    cells[model] = { base: new Array(tasks.length).fill(null), rag: new Array(tasks.length).fill(null), cost: 0, ragTokens: [] };
    if (METER && Number.isFinite(ABORT_USAGE)) {
      const u = await orUsage();
      if (u != null && u > ABORT_USAGE) { skipped[model] = `meter $${u.toFixed(2)} > cap $${ABORT_USAGE}`; console.error(`[${model}] ABORT before start: ${skipped[model]} — skip+LOG`); continue; }
      if (u != null) console.error(`[${model}] meter ok: account usage $${u.toFixed(2)} (cap $${ABORT_USAGE})`);
    }
    if (spent > MAX_COST) { skipped[model] = `process spend $${spent.toFixed(2)} > cap $${MAX_COST}`; console.error(`[${model}] ABORT: ${skipped[model]} — skip+LOG`); continue; }

    const llm = mkLlm(model);
    let idx = 0; let stop = false;
    async function worker() {
      while (idx < tasks.length && !stop) {
        const my = idx++;
        const task = tasks[my];
        // periodic meter re-check (concurrent cliff sweep may be spending too)
        if (METER && Number.isFinite(ABORT_USAGE) && my % 12 === 0) {
          const u = await orUsage();
          if (u != null && u > ABORT_USAGE) { stop = true; skipped[model] = `meter $${u.toFixed(2)} > cap $${ABORT_USAGE} mid-run`; console.error(`[${model}] ABORT mid-run: ${skipped[model]}`); break; }
        }
        if (spent > MAX_COST) { stop = true; skipped[model] = `process spend $${spent.toFixed(2)} > cap $${MAX_COST}`; console.error(`[${model}] ABORT mid-run: ${skipped[model]}`); break; }

        // ── condition 0: base no-RAG (parametric) ──
        const r0 = await llm(buildNoRagPrompt(task.question));
        const a0 = extractFinal(r0.raw);
        const ok0 = MOCK ? /__CORRECT__/.test(r0.raw) : questionScorer(a0, task.answer);    // gold read ONLY here (strict EM)
        const rx0 = MOCK ? ok0 : relaxedMatch(a0, task.answer);
        spent += r0.cost; cells[model].cost += r0.cost;

        // ── condition 1: +dense-RAG ──
        const mem = makeDense();
        await mem.index(corpora[task.task_id].passages);
        const { hits, tokens } = await mem.query(task.question, { k: K, maxTokens: MAX_CTX_TOK });
        await mem.close();
        const r1 = await llm(buildRagPrompt(task.question, hits));
        const a1 = extractFinal(r1.raw);
        const ok1 = MOCK ? /__CORRECT__/.test(r1.raw) : questionScorer(a1, task.answer);    // gold read ONLY here (strict EM)
        const rx1 = MOCK ? ok1 : relaxedMatch(a1, task.answer);
        spent += r1.cost; cells[model].cost += r1.cost;

        cells[model].base[my] = ok0;
        cells[model].rag[my] = ok1;
        cells[model].ragTokens.push(tokens);
        const rec = { model, task_id: task.task_id, base: { answer: a0, resolved: ok0, relaxed: rx0, cost: r0.cost }, rag: { answer: a1, resolved: ok1, relaxed: rx1, cost: r1.cost, contextTokens: tokens, nHits: hits.length }, gold: task.answer };
        preds.push(rec); out.push(JSON.stringify(rec));
        if ((my + 1) % 10 === 0) console.error(`  [${model}] ${my + 1}/${tasks.length}  spend $${spent.toFixed(3)}`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const done = cells[model].base.filter((x) => x !== null).length;
    const b = cells[model].base.filter((x) => x !== null);
    const r = cells[model].rag.filter((x) => x !== null);
    const sb = wilson(b.filter(Boolean).length, b.length);
    const sr = wilson(r.filter(Boolean).length, r.length);
    console.error(`[${model}] n=${done}  base=${(sb.p * 100).toFixed(1)}%  +dense=${(sr.p * 100).toFixed(1)}%  Δ=${((sr.p - sb.p) * 100).toFixed(1)}pp  $${cells[model].cost.toFixed(3)}  (run spend $${spent.toFixed(3)})`);
  }
  writeFileSync(OUT, out.join('\n') + (out.length ? '\n' : ''));

  // 3) Per-model summary + Δ with paired bootstrap CI.
  const summary = {};
  for (const model of MODELS) {
    const c = cells[model];
    const idxDone = c.base.map((v, i) => (v !== null && c.rag[i] !== null ? i : -1)).filter((i) => i >= 0);
    const n = idxDone.length;
    const baseK = idxDone.filter((i) => c.base[i]).length;
    const ragK = idxDone.filter((i) => c.rag[i]).length;
    const baseCI = wilson(baseK, n);
    const ragCI = wilson(ragK, n);
    // paired bootstrap over the SAME questions for Δ
    const rng = mulberry32(SEED);
    const deltas = [];
    for (let it = 0; it < BOOT && n > 0; it++) {
      let bs = 0; let rs = 0;
      for (let j = 0; j < n; j++) { const i = idxDone[Math.floor(rng() * n)]; if (c.base[i]) bs++; if (c.rag[i]) rs++; }
      deltas.push((rs - bs) / n);
    }
    deltas.sort((a, b) => a - b);
    summary[model] = {
      n, base: { k: baseK, p: baseCI.p, ci: [baseCI.lo, baseCI.hi] },
      rag: { k: ragK, p: ragCI.p, ci: [ragCI.lo, ragCI.hi] },
      delta: n ? (ragK - baseK) / n : null,
      deltaCI: n ? [pctl(deltas, 0.025), pctl(deltas, 0.975)] : null,
      meanRagTokens: c.ragTokens.length ? c.ragTokens.reduce((a, b) => a + b, 0) / c.ragTokens.length : 0,
      cost: c.cost,
      skipped: skipped[model] || null,
    };
  }

  // 4) Disproportionality verdict: Δ_cheap − Δ_frontier (paired bootstrap over shared questions).
  const frontierModels = MODELS.filter((m) => m !== CHEAP);
  const verdict = { cheap: CHEAP, frontier: frontierModels, comparisons: {} };
  const cCheap = cells[CHEAP];
  for (const fm of frontierModels) {
    const cF = cells[fm];
    if (!cCheap || !cF) continue;
    const idxShared = cCheap.base.map((v, i) => (v !== null && cCheap.rag[i] !== null && cF.base[i] !== null && cF.rag[i] !== null ? i : -1)).filter((i) => i >= 0);
    const n = idxShared.length;
    if (!n) { verdict.comparisons[fm] = { n: 0, note: 'no shared completed cells' }; continue; }
    const dCheap = (idxShared.filter((i) => cCheap.rag[i]).length - idxShared.filter((i) => cCheap.base[i]).length) / n;
    const dF = (idxShared.filter((i) => cF.rag[i]).length - idxShared.filter((i) => cF.base[i]).length) / n;
    const rng = mulberry32(SEED + 1);
    const diffs = [];
    for (let it = 0; it < BOOT; it++) {
      let cb = 0; let cr = 0; let fb = 0; let fr = 0;
      for (let j = 0; j < n; j++) {
        const i = idxShared[Math.floor(rng() * n)];
        if (cCheap.base[i]) cb++; if (cCheap.rag[i]) cr++;
        if (cF.base[i]) fb++; if (cF.rag[i]) fr++;
      }
      diffs.push(((cr - cb) - (fr - fb)) / n);
    }
    diffs.sort((a, b) => a - b);
    const pGreater = diffs.filter((d) => d > 0).length / diffs.length;
    verdict.comparisons[fm] = {
      n, deltaCheap: dCheap, deltaFrontier: dF, deltaDiff: dCheap - dF,
      deltaDiffCI: [pctl(diffs, 0.025), pctl(diffs, 0.975)],
      probDeltaCheapGreater: pGreater,
      h1Supported: dCheap > dF,
      h1SignificantAt95: pctl(diffs, 0.025) > 0,
    };
  }

  const report = {
    adr: 'ADR-201', hypothesis: 'H1 knowledge-flattening (dense-RAG)', ts: new Date().toISOString(),
    config: { manifest: MANIFEST, n: tasks.length, seed: SEED, models: MODELS, cheap: CHEAP, k: K, maxContextTokens: MAX_CTX_TOK, maxTokens: MAX_TOKENS, embedder: EMBEDDER, reasoning: 'disabled', bootstrap: BOOT, mock: MOCK },
    corpus: { meanPassages: corpStats.reduce((a, b) => a + b, 0) / corpStats.length, minPassages: Math.min(...corpStats), maxPassages: Math.max(...corpStats), source: 'en.wikipedia.org (keyless MediaWiki), question-only search — no gold leakage' },
    budget: { processSpendUSD: spent, maxCostUSD: MAX_COST, abortUsageUSD: ABORT_USAGE, skipped },
    summary, verdict,
    deferred: { H3: 'GraphRAG>dense — ruvector@0.2.32 has no @ruvector/graph-node (CodeGraph.cypher throws)', H4: 'GNN epoch self-learning — RVF query degraded (totalVectors===1); no graph edge-reweight API' },
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  // headline
  console.error('\n================ H1 PILOT RESULT ================');
  console.error('model                              n   base%   +dense%   Δpp   Δ95%CI            $');
  for (const m of MODELS) {
    const s = summary[m];
    if (!s || s.skipped) { console.error(`${m.padEnd(34)} SKIPPED (${s?.skipped || 'n/a'})`); continue; }
    const ci = s.deltaCI ? `[${(s.deltaCI[0] * 100).toFixed(1)},${(s.deltaCI[1] * 100).toFixed(1)}]` : 'n/a';
    console.error(`${m.padEnd(34)} ${String(s.n).padStart(2)}  ${(s.base.p * 100).toFixed(1).padStart(5)}  ${(s.rag.p * 100).toFixed(1).padStart(7)}  ${((s.delta) * 100).toFixed(1).padStart(5)}  ${ci.padEnd(16)}  ${s.cost.toFixed(3)}`);
  }
  for (const [fm, cmp] of Object.entries(verdict.comparisons)) {
    if (cmp.n === 0) continue;
    console.error(`\nDISPROPORTIONALITY vs ${fm}: Δcheap=${(cmp.deltaCheap * 100).toFixed(1)}pp  Δfrontier=${(cmp.deltaFrontier * 100).toFixed(1)}pp  ΔΔ=${(cmp.deltaDiff * 100).toFixed(1)}pp  CI[${(cmp.deltaDiffCI[0] * 100).toFixed(1)},${(cmp.deltaDiffCI[1] * 100).toFixed(1)}]  H1 ${cmp.h1Supported ? 'SUPPORTED' : 'NOT supported'}${cmp.h1SignificantAt95 ? ' (sig@95%)' : ''}`);
  }
  console.error(`\nprocess spend: $${spent.toFixed(4)}   report → ${REPORT}   preds → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
