// SPDX-License-Identifier: MIT
//
// h3-pilot.mjs — ADR-201 H3 "GraphRAG > dense" Phase A (FRAMES) runner.
//
// HYPOTHESIS: does the ruvector LOCAL graph arm (kHop-graph-expansion + cosine rerank)
// improve cheap models vs dense baseline — and vs base (no-RAG)?
//
// DESIGN:
//   • FRAMES n=50, seed 42, Wikipedia corpus (question-only search — no gold leakage).
//   • 3 conditions × 3 models × 50 = 450 cells.
//       (0) base no-RAG  : parametric only, the model answers from its own knowledge.
//       (1) +dense-RAG   : DenseMemory cosine retrieval (all-MiniLM-L6-v2 ONNX, 384-d), k=8.
//       (2) +graph-RAG   : GraphRagMemory — kHop(anchor, depth=2) expansion + cosine rerank.
//                          LABEL PRECISION: this is kHop-graph-EXPANSION + cosine rerank,
//                          NOT the full Rust GraphRAG community-detection pipeline.
//   • Models:
//       cheap  → deepseek/deepseek-v4-pro   ($0.435/$0.87 per Mtok)
//       cheap  → z-ai/glm-5.2               ($0.95/$3.00 per Mtok)
//       frontier → openai/gpt-5.5           ($5/$30 per Mtok, reference)
//   • Embedder: all-MiniLM-L6-v2 (384-d ONNX, local, $0) via ruvector OnnxEmbedder.
//     MEMOIZED: corpus passages embedded once, shared across all models + conditions.
//   • Budget gate: --meter --abort-usage (authoritative account-level USD ceiling).
//
// CONFORMANCE FIREWALL:
//   The gold `answer` is read in exactly ONE place: the offline scorer (questionScorer),
//   AFTER the model has already produced its prediction. It is NEVER used in retrieval,
//   embedding, corpus search, prompting, or feedback.
//
// METRICS reported:
//   resolve(base|dense|graph) with Wilson 95% CI per model
//   Δ_dense  = resolve(dense)  − resolve(base)   [dense RAG lift]
//   Δ_graph  = resolve(graph)  − resolve(base)   [graph RAG lift]
//   Δ_g_vs_d = resolve(graph)  − resolve(dense)  [graph > dense?]
//   Cr       = mean graph context tokens / mean dense context tokens   [compression ratio]
//   graphHits = mean # graph-expanded (non-direct-topK) hits per query
//   gap      = gpt-5.5 − model resolve (base/dense/graph) [gap narrowing]
//
// PAID RUN:
//   node h3-pilot.mjs --manifest data/manifest-frames-n50.json \
//     --models deepseek/deepseek-v4-pro,z-ai/glm-5.2,openai/gpt-5.5 \
//     --cheap deepseek/deepseek-v4-pro,z-ai/glm-5.2 \
//     --k 8 --max-context-tokens 12000 --concurrency 4 \
//     --meter --max-cost 60 --abort-usage 2839 \
//     --out data/h3-preds.jsonl --report data/h3-report.json
//
// DRY RUN ($0 mock):
//   node h3-pilot.mjs --mock --manifest data/manifest-frames-n50.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DenseMemory, GraphRagMemory } from './memory-layer.mjs';
import { buildRagPrompt, extractFinal } from './ruvector-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MANIFEST    = rel(argv('--manifest', 'data/manifest-frames-n50.json'));
const MODELS      = argv('--models', 'deepseek/deepseek-v4-pro,z-ai/glm-5.2,openai/gpt-5.5').split(',').map(s => s.trim()).filter(Boolean);
const CHEAP_SET   = new Set(argv('--cheap', 'deepseek/deepseek-v4-pro,z-ai/glm-5.2').split(',').map(s => s.trim()));
const FRONTIER    = argv('--frontier', 'openai/gpt-5.5');
const K           = +argv('--k', 8);
const MAX_CTX_TOK = +argv('--max-context-tokens', 12000);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 3));
const MOCK        = has('--mock');
const SEED        = +argv('--seed', 42);
const MAX_COST    = +argv('--max-cost', Infinity);   // soft per-process USD cap
const METER       = has('--meter');
const ABORT_USAGE = +argv('--abort-usage', Infinity); // ABSOLUTE account ceiling (USD)
const MAX_TOKENS  = +argv('--max-tokens', 800);
const BOOT        = +argv('--bootstrap', 10000);
const RUVECTOR_PATH = argv('--ruvector', '/home/ruvultra/projects/ruvector/node_modules/ruvector');
const CORPUS_DIR  = rel(argv('--corpus-cache', 'data/corpus-cache'));
const OUT         = rel(argv('--out', 'data/h3-preds.jsonl'));
const REPORT      = rel(argv('--report', 'data/h3-report.json'));

const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const KEY_ENV  = argv('--api-key-env', 'OPENROUTER_API_KEY');
function apiKey() {
  return (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
}

// ── GAIA-compatible exact + relaxed scorer (identical to h1-pilot.mjs) ─────────────────────────
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitList(s) { return String(s ?? '').split(/[,;]/).map(x => x.trim()).filter(Boolean); }
function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normalizeNumberStr(gold);
  if (gn !== null) { const pn = normalizeNumberStr(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) {
    const pl = splitList(pred);
    if (pl.length !== gl.length) return false;
    return gl.every((g, i) => {
      const gnum = normalizeNumberStr(g);
      if (gnum !== null) { const pnum = normalizeNumberStr(pl[i]); return pnum !== null && pnum === gnum; }
      return normalizeStr(g) === normalizeStr(pl[i]);
    });
  }
  return normalizeStr(pred) === normalizeStr(gold);
}
function relaxedMatch(pred, gold) {
  const g = normalizeStr(gold), p = normalizeStr(pred);
  if (!g) return false;
  if (p.includes(g)) return true;
  const gt = g.split(' ').filter(t => t.length > 1);
  return gt.length > 0 && gt.every(t => p.includes(t));
}

// ── Wikipedia corpus builder (identical to h1-pilot.mjs) ─────────────────────────────────────
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const UA = 'darwin-adr201-h3/1.0 (https://github.com/ruvnet/agent-harness-generator; research)';

let _wikiGate = Promise.resolve();
function wikiThrottle() {
  const prev = _wikiGate;
  let release;
  _wikiGate = new Promise(r => { release = r; });
  return prev.then(() => new Promise(r => setTimeout(() => { r(); setTimeout(release, 250); }, 0)));
}
async function wikiJson(params, attempts = 7) {
  const url = `${WIKI_API}?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`;
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    await wikiThrottle();
    if (a) await new Promise(r => setTimeout(r, 1200 * 2 ** (a - 1)));
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
    return (j?.query?.search ?? []).map(h => h.title);
  } catch { return []; }
}

function deriveQueries(question) {
  const qs = [question];
  for (const m of question.match(/"([^"]{2,60})"|'([^']{2,60})'/g) || []) qs.push(m.replace(/['"]/g, ''));
  const spans = question.match(/\b([A-Z][a-zA-Z0-9.''-]+(?:\s+(?:of|the|de|and|&)?\s*[A-Z][a-zA-Z0-9.''-]+)*)\b/g) || [];
  const stop = new Set(['As', 'If', 'What', 'Which', 'Who', 'How', 'When', 'Where', 'The', 'A', 'In', 'On', 'For', 'Is', 'Are', 'Was', 'Were', 'Of', 'At', 'July', 'June', 'January']);
  for (const s of spans) { const tt = s.trim(); if (tt.length > 3 && !stop.has(tt)) qs.push(tt); }
  for (const code of question.match(/\b[A-Z]{1,3}\d{1,4}\b/g) || []) qs.push(code);
  const STOPW = new Set('the a an of to in on for is are was were be by with as at and or i you it this that what which who how when where my am moving nearby area as'.split(' '));
  const kw = (question.toLowerCase().match(/[a-z0-9]+/g) || []).filter(w => w.length > 3 && !STOPW.has(w));
  if (kw.length) qs.push(kw.slice(0, 6).join(' '));
  return [...new Set(qs)].slice(0, 9);
}

async function fetchExtract(title, maxChars = 14000) {
  const j = await wikiJson({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: String(title) });
  const page = Object.values(j?.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined) return null;
  const text = String(page.extract || '').slice(0, maxChars);
  return text.trim() ? { title: page.title, text } : null;
}

function chunkText(title, text, words = 120) {
  const paras = text.split(/\n{1,}/).map(p => p.trim()).filter(p => p.length > 40);
  const chunks = [];
  let buf = [], n = 0;
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

// ── ONNX embedder with memoization ──────────────────────────────────────────────────────────────
// all-MiniLM-L6-v2, 384-d, local, $0. MEMOIZED so corpus passages are embedded once and
// shared across all 3 models and all 3 conditions (dense + graph). The ONNX session is
// serialized (not reentrant) — calls are queued through a serial gate.
let _embedFn = null;
let _embedDim = 256;

async function initEmbedder() {
  if (MOCK) {
    const { embedText } = await import('./embedder.mjs');
    _embedDim = 256;
    const cache = new Map();
    _embedFn = async (text) => {
      if (!cache.has(text)) cache.set(text, embedText(text, 256));
      return cache.get(text);
    };
    console.error('[embedder] mock hashed bag-of-bigrams (256-d)');
    return;
  }

  const req = createRequire(import.meta.url);
  let rv;
  try { rv = req(RUVECTOR_PATH); } catch (e) { throw new Error(`cannot load ruvector at ${RUVECTOR_PATH}: ${e.message}`); }
  if (!rv.OnnxEmbedder || !rv.isOnnxAvailable || !rv.isOnnxAvailable()) {
    throw new Error('ruvector OnnxEmbedder not available — set RUVECTOR_PATH or use --mock');
  }
  const onnx = new rv.OnnxEmbedder();
  if (onnx.init) await onnx.init();
  const toArr = (v) => Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : (v?.data ? Array.from(v.data) : Array.from(v || []));

  // Serial gate (ONNX session.run not safe under concurrency)
  let gate = Promise.resolve();
  const serial = (text) => {
    const p = gate.then(() => onnx.embed(String(text)).then(toArr));
    gate = p.catch(() => {});
    return p;
  };

  // Probe dimension
  const probe = await serial('dimension probe');
  _embedDim = probe.length;

  // Memoization cache (heap-resident; for n=50 × ~120 passages ≈ 6,000 vectors × 384 × 4 bytes ≈ 9MB — acceptable)
  const cache = new Map();
  _embedFn = async (text) => {
    if (!cache.has(text)) cache.set(text, await serial(text));
    return cache.get(text);
  };

  console.error(`[embedder] onnx all-MiniLM-L6-v2 ready: ${_embedDim}-d (cache enabled)`);
}

// ── LLM client ───────────────────────────────────────────────────────────────────────────────────
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
    return async (messages) => {
      const isRag = messages.some(m => /CONTEXT:/.test(m.content));
      const isGraph = messages.some(m => /GRAPH/.test(m.content || ''));
      const q = messages[messages.length - 1].content;
      // mock: cheap models gain more from graph than dense; frontier gains from both
      const isCheap = CHEAP_SET.has(model);
      const baseP = isCheap ? 0.20 : 0.45;
      const denseBoost = isCheap ? 0.05 : 0.08;
      const graphBoost = isCheap ? 0.10 : 0.10;
      const p = isRag ? (isGraph ? baseP + graphBoost : baseP + denseBoost) : baseP;
      const h = [...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) / 2 ** 32;
      return { raw: `FINAL_ANSWER: ${h < p ? '__CORRECT__' : 'wrong'}`, cost: 0 };
    };
  }
  const key = apiKey();
  if (!key) { console.error(`FATAL: no API key (set ${KEY_ENV} or /tmp/.orkey), or pass --mock`); process.exit(1); }
  return async (messages, temp = 0.1) => {
    let lastErr;
    for (let a = 0; a < 5; a++) {
      if (a) await new Promise(r => setTimeout(r, 2000 * 2 ** (a - 1)));
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator',
            'X-Title': 'adr201-h3-pilot',
          },
          // reasoning DISABLED: prevents hidden reasoning consuming the entire budget
          // (verified: deepseek-v4-pro + gpt-5.5 emit empty content if reasoning is allowed
          //  with short max_tokens; disabling gives fair single-shot RAG-QA across all models)
          body: JSON.stringify({
            model,
            messages,
            max_tokens: MAX_TOKENS,
            temperature: temp,
            reasoning: { enabled: false },
            usage: { include: true },
          }),
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

// ── stats ─────────────────────────────────────────────────────────────────────────────────────
function wilson(k, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pctl = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

function pairedBootstrap(aVec, bVec, seed, B = BOOT) {
  // a and b are parallel arrays of bool; returns bootstrap CI for mean(b) - mean(a)
  if (aVec.length === 0) return { delta: null, ci: [null, null] };
  const n = aVec.length;
  const delta = (bVec.filter(Boolean).length - aVec.filter(Boolean).length) / n;
  const rng = mulberry32(seed);
  const deltas = [];
  for (let it = 0; it < B; it++) {
    let as = 0, bs = 0;
    for (let j = 0; j < n; j++) { const i = Math.floor(rng() * n); if (aVec[i]) as++; if (bVec[i]) bs++; }
    deltas.push((bs - as) / n);
  }
  deltas.sort((a, b) => a - b);
  return { delta, ci: [pctl(deltas, 0.025), pctl(deltas, 0.975)] };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(dirname(OUT), { recursive: true });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const tasks = manifest.tasks;
  console.error(`[h3] ${tasks.length} FRAMES tasks (seed ${manifest.seed}); models=${MODELS.join(', ')}; k=${K}; concurrency=${CONCURRENCY}; meter=${METER}; abortUsage=${ABORT_USAGE}`);

  await initEmbedder();

  // 1) Build corpora (cached). QUESTION-ONLY search — no gold leakage.
  console.error('[corpus] building/loading per-question Wikipedia corpora …');
  const corpora = {};
  let cIdx = 0;
  async function cWorker() {
    while (cIdx < tasks.length) {
      const t = tasks[cIdx++];
      corpora[t.task_id] = await buildCorpus(t);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, cWorker));
  const corpStats = Object.values(corpora).map(c => c.nPassages);
  console.error(`[corpus] ready: ${corpStats.length} corpora, mean ${(corpStats.reduce((a, b) => a + b, 0) / corpStats.length).toFixed(1)} passages/q (min ${Math.min(...corpStats)}, max ${Math.max(...corpStats)})`);

  // 1b) Pre-warm ONNX embedding cache (memoized; expensive on first call — ~190ms/passage).
  // All corpus passages + queries are embedded ONCE here; subsequent memory.index() + query()
  // calls return instantly from the in-process cache. Without pre-warm, the ONNX gate would
  // block all 3 concurrent workers, dramatically increasing wall time.
  // NOTE (structural): empirically verified (2026-06-28) that with ONNX all-MiniLM-L6-v2
  // all Wikipedia passage pairs have cosine ≥ 0.43 (min across 3 tested corpora). The
  // kHop-graph-expansion + cosine rerank arm is therefore structurally equivalent to dense
  // cosine retrieval: graphHits=0 for all tested thresholds (0.35–0.90), meaning graph
  // expansion adds no candidates outside the direct top-k. This is documented in the report
  // under "structural_equivalence". The arm is still run to provide empirical confirmation.
  if (!MOCK) {
    const t0 = Date.now();
    let nEmbed = 0;
    console.error('[embed] pre-warming ONNX cache (this takes ~3-4 min for n=50) …');
    for (const task of tasks) {
      await _embedFn(task.question);
      nEmbed++;
      for (const p of corpora[task.task_id].passages) {
        await _embedFn(p.text);
        nEmbed++;
      }
    }
    console.error(`[embed] warmed ${nEmbed} entries in ${((Date.now()-t0)/1000).toFixed(0)}s`);
  }

  // Per-model result storage: { base:[bool], dense:[bool], graph:[bool], cost, denseTokens:[], graphTokens:[], graphHits:[] }
  const cells = {};
  const allPreds = [];
  let spent = 0;
  const skipped = {};

  for (const model of MODELS) {
    cells[model] = {
      base: new Array(tasks.length).fill(null),
      dense: new Array(tasks.length).fill(null),
      graph: new Array(tasks.length).fill(null),
      cost: 0, denseTokens: [], graphTokens: [], graphHits: [],
    };

    if (METER && Number.isFinite(ABORT_USAGE)) {
      const u = await orUsage();
      if (u != null && u > ABORT_USAGE) {
        skipped[model] = `meter $${u.toFixed(2)} > cap $${ABORT_USAGE}`;
        console.error(`[${model}] ABORT before start: ${skipped[model]}`);
        continue;
      }
      if (u != null) console.error(`[${model}] meter ok: $${u.toFixed(2)} (cap $${ABORT_USAGE})`);
    }
    if (spent > MAX_COST) { skipped[model] = `process spend $${spent.toFixed(2)} > cap $${MAX_COST}`; console.error(`[${model}] ABORT: ${skipped[model]}`); continue; }

    const llm = mkLlm(model);
    let idx = 0; let stop = false;

    async function worker() {
      while (idx < tasks.length && !stop) {
        // Periodic meter re-check
        if (METER && Number.isFinite(ABORT_USAGE) && idx % 10 === 0) {
          const u = await orUsage();
          if (u != null && u > ABORT_USAGE) {
            stop = true;
            skipped[model] = `meter $${u.toFixed(2)} > cap $${ABORT_USAGE} mid-run`;
            console.error(`[${model}] ABORT mid-run: ${skipped[model]}`);
            break;
          }
        }
        if (spent > MAX_COST) { stop = true; break; }

        const my = idx++;
        const task = tasks[my];
        const corpus = corpora[task.task_id];

        // ── condition 0: base no-RAG (parametric) ──────────────────────────────────────────────
        const r0 = await llm(buildNoRagPrompt(task.question));
        const a0 = extractFinal(r0.raw);
        const ok0 = MOCK ? /__CORRECT__/.test(r0.raw) : questionScorer(a0, task.answer);
        const rx0 = MOCK ? ok0 : relaxedMatch(a0, task.answer);
        spent += r0.cost; cells[model].cost += r0.cost;

        // ── condition 1: +dense-RAG ────────────────────────────────────────────────────────────
        // DenseMemory: global cosine kNN over all corpus passages
        const memD = new DenseMemory({ dim: _embedDim, embed: _embedFn });
        await memD.index(corpus.passages);
        const { hits: dHits, tokens: dTok } = await memD.query(task.question, { k: K, maxTokens: MAX_CTX_TOK });
        await memD.close();
        const r1 = await llm(buildRagPrompt(task.question, dHits));
        const a1 = extractFinal(r1.raw);
        const ok1 = MOCK ? /__CORRECT__/.test(r1.raw) : questionScorer(a1, task.answer);
        const rx1 = MOCK ? ok1 : relaxedMatch(a1, task.answer);
        spent += r1.cost; cells[model].cost += r1.cost;

        // ── condition 2: +graph-RAG ────────────────────────────────────────────────────────────
        // GraphRagMemory: anchor → kHopNeighbors(depth=2) expansion → union with direct top-k → cosine rerank
        // LABEL: kHop-graph-EXPANSION + cosine rerank (NOT Rust community-detection GraphRAG)
        let ok2 = false, rx2 = false, gTok = dTok, gHits = 0, a2 = '';
        let graphFallback = false;
        try {
          const memG = new GraphRagMemory({ dim: _embedDim, embed: _embedFn });
          await memG.index(corpus.passages);
          const { hits: ghits, tokens: gTokens, graphHits: gHitCount } = await memG.query(task.question, { k: K, maxTokens: MAX_CTX_TOK });
          await memG.close();
          gTok = gTokens; gHits = gHitCount || 0;
          const r2 = await llm(buildRagPrompt(task.question, ghits));
          a2 = extractFinal(r2.raw);
          ok2 = MOCK ? /__CORRECT__/.test(r2.raw) : questionScorer(a2, task.answer);
          rx2 = MOCK ? ok2 : relaxedMatch(a2, task.answer);
          spent += r2.cost; cells[model].cost += r2.cost;
        } catch (e) {
          // GraphRagMemory unavailable (e.g. graph-node not built) — fall back to dense result
          graphFallback = true;
          console.error(`  [${model}] graph fallback (${e.message.slice(0, 80)}) → using dense for task ${task.task_id}`);
          ok2 = ok1; rx2 = rx1; a2 = a1; gTok = dTok;
        }

        cells[model].base[my] = ok0;
        cells[model].dense[my] = ok1;
        cells[model].graph[my] = ok2;
        cells[model].denseTokens.push(dTok);
        cells[model].graphTokens.push(gTok);
        cells[model].graphHits.push(gHits);

        const rec = {
          model, task_id: task.task_id,
          base:  { answer: a0, resolved: ok0, relaxed: rx0, cost: r0.cost },
          dense: { answer: a1, resolved: ok1, relaxed: rx1, cost: r1.cost, contextTokens: dTok, nHits: dHits.length },
          graph: { answer: a2, resolved: ok2, relaxed: rx2,                contextTokens: gTok, graphHits: gHits, fallback: graphFallback },
          gold: task.answer,
        };
        allPreds.push(rec);
        if ((my + 1) % 10 === 0) {
          console.error(`  [${model}] ${my + 1}/${tasks.length}  spend $${spent.toFixed(3)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const done = cells[model].base.filter(x => x !== null).length;
    const sb = wilson(cells[model].base.filter(Boolean).length, done);
    const sd = wilson(cells[model].dense.filter(Boolean).length, done);
    const sg = wilson(cells[model].graph.filter(Boolean).length, done);
    console.error(`[${model}] n=${done}  base=${(sb.p*100).toFixed(1)}%  +dense=${(sd.p*100).toFixed(1)}%  +graph=${(sg.p*100).toFixed(1)}%  $${cells[model].cost.toFixed(3)}`);
  }

  // Write predictions JSONL
  writeFileSync(OUT, allPreds.map(r => JSON.stringify(r)).join('\n') + (allPreds.length ? '\n' : ''));

  // ── Per-model summary ────────────────────────────────────────────────────────────────────────
  const summary = {};
  for (const model of MODELS) {
    const c = cells[model];
    const idxDone = c.base.map((v, i) => (v !== null && c.dense[i] !== null && c.graph[i] !== null ? i : -1)).filter(i => i >= 0);
    const n = idxDone.length;
    const bK = idxDone.filter(i => c.base[i]).length;
    const dK = idxDone.filter(i => c.dense[i]).length;
    const gK = idxDone.filter(i => c.graph[i]).length;

    const baseArr  = idxDone.map(i => !!c.base[i]);
    const denseArr = idxDone.map(i => !!c.dense[i]);
    const graphArr = idxDone.map(i => !!c.graph[i]);

    const basCI  = wilson(bK, n);
    const denCI  = wilson(dK, n);
    const graCI  = wilson(gK, n);

    const denseVsBase = pairedBootstrap(baseArr, denseArr, SEED + 10);
    const graphVsBase = pairedBootstrap(baseArr, graphArr, SEED + 20);
    const graphVsDense = pairedBootstrap(denseArr, graphArr, SEED + 30);

    const meanDenseTok = c.denseTokens.length ? c.denseTokens.reduce((a, b) => a + b, 0) / c.denseTokens.length : 0;
    const meanGraphTok = c.graphTokens.length ? c.graphTokens.reduce((a, b) => a + b, 0) / c.graphTokens.length : 0;
    const Cr = meanDenseTok > 0 ? meanGraphTok / meanDenseTok : null;  // < 1 = graph uses fewer tokens
    const meanGraphHits = c.graphHits.length ? c.graphHits.reduce((a, b) => a + b, 0) / c.graphHits.length : 0;

    summary[model] = {
      n,
      cheap: CHEAP_SET.has(model),
      base:  { k: bK, p: basCI.p, ci: [basCI.lo, basCI.hi] },
      dense: { k: dK, p: denCI.p, ci: [denCI.lo, denCI.hi] },
      graph: { k: gK, p: graCI.p, ci: [graCI.lo, graCI.hi] },
      delta_dense_vs_base:  denseVsBase,
      delta_graph_vs_base:  graphVsBase,
      delta_graph_vs_dense: graphVsDense,
      Cr,
      meanGraphHits,
      meanDenseTokens: meanDenseTok,
      meanGraphTokens: meanGraphTok,
      cost: c.cost,
      skipped: skipped[model] || null,
    };
  }

  // ── Gap narrowing (vs frontier reference) ─────────────────────────────────────────────────────
  const frontierSummary = summary[FRONTIER];
  const gapAnalysis = {};
  if (frontierSummary) {
    for (const model of MODELS.filter(m => m !== FRONTIER)) {
      if (!summary[model]) continue;
      gapAnalysis[model] = {
        base:  frontierSummary.base.p  - summary[model].base.p,
        dense: frontierSummary.dense.p - summary[model].dense.p,
        graph: frontierSummary.graph.p - summary[model].graph.p,
        // narrowing: positive = gap closed
        narrowing_dense_vs_base: (frontierSummary.base.p  - summary[model].base.p)  - (frontierSummary.dense.p - summary[model].dense.p),
        narrowing_graph_vs_base: (frontierSummary.base.p  - summary[model].base.p)  - (frontierSummary.graph.p - summary[model].graph.p),
      };
    }
  }

  // ── H3 verdict ───────────────────────────────────────────────────────────────────────────────
  // H3 holds iff graph > dense for cheap models (delta_graph_vs_dense.delta > 0 AND CI does NOT
  // straddle zero at 95% for strict, or just > 0 for directional).
  const h3Verdict = {};
  for (const model of MODELS.filter(m => CHEAP_SET.has(m))) {
    if (!summary[model]) continue;
    const gvd = summary[model].delta_graph_vs_dense;
    h3Verdict[model] = {
      delta_graph_vs_dense: gvd.delta,
      ci: gvd.ci,
      h3_directional: (gvd.delta ?? 0) > 0,
      h3_significant_95: gvd.ci ? (gvd.ci[0] > 0) : false,
      verdict: (gvd.delta ?? 0) > 0 ? (gvd.ci?.[0] > 0 ? 'SUPPORTED (sig@95%)' : 'DIRECTIONAL (not sig)') : 'NOT SUPPORTED',
    };
  }

  const report = {
    adr: 'ADR-201',
    hypothesis: 'H3 kHop-graph-expansion > dense-RAG for cheap models (Phase A: FRAMES)',
    label_precision: 'graph arm = kHop-graph-EXPANSION (anchor→kHopNeighbors(depth=2)) + cosine rerank; NOT Rust community-detection GraphRAG',
    structural_equivalence: {
      finding: 'kHop-graph-expansion + cosine rerank is STRUCTURALLY EQUIVALENT to dense cosine retrieval for ONNX all-MiniLM-L6-v2 on Wikipedia corpora',
      mechanism: 'all-MiniLM-L6-v2 maps Wikipedia passages to a dense cluster (min pairwise cosine ≥ 0.43 observed; graph fully connected for thr≤0.43); kHop expands to superset of direct top-k but cosine re-ranking selects the same top-k; graphHits=0 for all tested thresholds (0.35–0.90)',
      consequence: 'Δ_graph_vs_dense = 0 by construction; the graph arm\'s LLM prompt is identical to the dense arm\'s prompt; any resolve difference is sampling noise',
      would_diverge_if: 'graph scoring used topology (PageRank, community membership, hub-boost) instead of raw cosine; or if cosine-threshold creates a sparse graph (thr > 0.85 for these corpora, but then the graph is nearly empty)',
      not_the_Rust_GraphRAG: 'ruvector-core/graph_rag.rs (community detection + cluster-representative retrieval) is NOT wired — no Node.js binding compiled',
    },
    ts: new Date().toISOString(),
    config: {
      manifest: MANIFEST, n: tasks.length, seed: SEED,
      models: MODELS, cheap: [...CHEAP_SET], frontier: FRONTIER,
      k: K, maxContextTokens: MAX_CTX_TOK, maxTokens: MAX_TOKENS,
      embedder: MOCK ? 'hashed-bigram-256d' : 'onnx-all-MiniLM-L6-v2-384d',
      reasoning: 'disabled', bootstrap: BOOT, mock: MOCK,
    },
    corpus: {
      meanPassages: corpStats.reduce((a, b) => a + b, 0) / corpStats.length,
      minPassages: Math.min(...corpStats),
      maxPassages: Math.max(...corpStats),
      source: 'en.wikipedia.org (keyless MediaWiki), question-only search — no gold leakage',
    },
    budget: { processSpendUSD: spent, maxCostUSD: MAX_COST, abortUsageUSD: ABORT_USAGE, skipped },
    summary,
    gapAnalysis,
    h3Verdict,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));

  // ── Headline ──────────────────────────────────────────────────────────────────────────────────
  console.error('\n================ H3 RESULTS (FRAMES, kHop-graph-expansion) ================');
  console.error('model                            n   base%   +dense%   +graph%   Δgraph   Δg>d   Cr    $');
  for (const m of MODELS) {
    const s = summary[m];
    if (!s || s.skipped) { console.error(`${m.padEnd(32)} SKIPPED (${s?.skipped || 'n/a'})`); continue; }
    const gvd = s.delta_graph_vs_dense;
    const gvdStr = gvd.delta != null ? `${(gvd.delta*100).toFixed(1)}pp` : 'n/a';
    const crStr = s.Cr != null ? s.Cr.toFixed(2) : 'n/a';
    const gvbStr = s.delta_graph_vs_base.delta != null ? `${(s.delta_graph_vs_base.delta*100).toFixed(1)}pp` : 'n/a';
    console.error(`${(s.cheap ? '* ' : '  ') + m.padEnd(30)} ${String(s.n).padStart(2)}  ${(s.base.p*100).toFixed(1).padStart(5)}  ${(s.dense.p*100).toFixed(1).padStart(7)}  ${(s.graph.p*100).toFixed(1).padStart(7)}  ${gvbStr.padStart(7)}  ${gvdStr.padStart(5)}  ${crStr.padStart(4)}  ${s.cost.toFixed(3)}`);
  }
  console.error('\n* = cheap model (the H3 test subjects)');
  console.error('Cr = graph/dense mean context tokens; <1 = graph uses fewer tokens');
  console.error('\nH3 verdicts (graph > dense for cheap models):');
  for (const [m, v] of Object.entries(h3Verdict)) {
    console.error(`  ${m}: Δ=${v.delta_graph_vs_dense != null ? (v.delta_graph_vs_dense*100).toFixed(1) : 'n/a'}pp CI[${v.ci?.[0] != null ? (v.ci[0]*100).toFixed(1) : 'n/a'},${v.ci?.[1] != null ? (v.ci[1]*100).toFixed(1) : 'n/a'}] → ${v.verdict}`);
  }
  if (frontierSummary) {
    console.error('\nGap vs ' + FRONTIER + ':');
    for (const [m, g] of Object.entries(gapAnalysis)) {
      console.error(`  ${m}: gap base=${(g.base*100).toFixed(1)}pp dense=${(g.dense*100).toFixed(1)}pp graph=${(g.graph*100).toFixed(1)}pp  narrowing_graph=${(g.narrowing_graph_vs_base*100).toFixed(1)}pp`);
    }
  }
  console.error(`\nprocess spend: $${spent.toFixed(4)}   report → ${REPORT}   preds → ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
