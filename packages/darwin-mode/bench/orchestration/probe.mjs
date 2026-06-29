// SPDX-License-Identifier: MIT
//
// probe.mjs — the PRE-SOLVE context probe for the learned-router experiment.
//
// Produces, per FRAMES task, a cheap set of CONTEXT FEATURES the router buckets on.
// CONFORMANCE: the probe NEVER sees the gold answer. It only sees task.question.
// Features are all available BEFORE committing to any arm (so routing is by context
// only, no gold). The probe is the routing TAX: its cost is added to the learned
// policy's bill (static baselines pay no probe — they need no routing decision).
//
// Features (gold-free):
//   q_chars, q_words        — length / multi-hop length proxy
//   multihop_score          — cheap textual proxy: #commas + "and"/"of the"/numerics + entity spans
//   probe_consistency       — max normalized-answer agreement across K cheap direct samples (temp>0)
//   probe_confidence        — mean self-rated confidence across the K samples
//   probe_answers           — the K raw short answers (audit)
//
// The probe = K direct (NO-TOOL) one-shot answers from the cheap model. Cheap models
// that "know" an easy fact agree + are confident; hard multi-hop questions scatter.
//
// Run:
//   OPENROUTER_API_KEY=$KEY node --experimental-strip-types probe.mjs \
//     --manifest ../gaia/manifest-frames-n100.json --model deepseek/deepseek-v4-pro \
//     --samples 3 --concurrency 6 --meter --abort-usage 2722 --out runs/probe.jsonl

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const MANIFEST = rel(argv('--manifest', '../gaia/manifest-frames-n100.json'));
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const SAMPLES = +argv('--samples', 3);
const CONCURRENCY = Math.max(1, +argv('--concurrency', 6));
const SAMPLE = +argv('--sample', 0);
const MOCK = has('--mock');
const METER = has('--meter');
const ABORT_USAGE = +argv('--abort-usage', Infinity);
const OUT = rel(argv('--out', 'runs/probe.jsonl'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key && !MOCK) { console.error('FATAL: no API key'); process.exit(1); }

let tasks = JSON.parse(readFileSync(MANIFEST, 'utf8')).tasks;
if (SAMPLE > 0) tasks = tasks.slice(0, SAMPLE);

// ── cheap direct-answer LLM (no tools), returns { answer, confidence, cost } ─────
const normAns = (s) => String(s ?? '').toLowerCase().replace(/[$%,]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
function mkLlm(model) {
  return async function (messages, temp) {
    let lastErr;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
      try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'darwin-orch-probe' },
          body: JSON.stringify({ model, messages, max_tokens: 120, temperature: temp, usage: { include: true } }),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
        const j = await res.json();
        return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error('llm failed');
  };
}
const PROBE_SYS = 'You are answering a hard general-knowledge question from MEMORY ONLY (no tools). Output EXACTLY two lines:\nANSWER: <a short final answer — a name, number, date, or short phrase; best guess if unsure>\nCONFIDENCE: <your calibrated probability 0.0-1.0 that the answer is exactly correct>';
const mockLlm = async () => ({ raw: `ANSWER: Mock Answer\nCONFIDENCE: ${(0.5 + Math.random() * 0.4).toFixed(2)}`, cost: 0.0001 });
const llm = MOCK ? mockLlm : mkLlm(MODEL);

function parseProbe(raw) {
  const a = (raw.match(/ANSWER:\s*(.+)/i)?.[1] || raw.split('\n')[0] || '').trim().slice(0, 200);
  const c = Number(raw.match(/CONFIDENCE:\s*([0-9.]+)/i)?.[1]);
  return { answer: a, conf: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5 };
}
function multihopScore(q) {
  const commas = (q.match(/,/g) || []).length;
  const conj = (q.match(/\b(and|of the|which|whose|who|that|than|both)\b/gi) || []).length;
  const nums = (q.match(/\b\d[\d,.]*\b/g) || []).length;
  const caps = (q.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || []).length; // capitalized entity spans
  return commas + conj + nums + Math.min(caps, 8);
}

async function probeOne(task) {
  const samples = [];
  let cost = 0;
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const r = await llm([{ role: 'system', content: PROBE_SYS }, { role: 'user', content: `QUESTION:\n${task.question}` }], 0.7);
      cost += r.cost || 0; samples.push(parseProbe(r.raw));
    } catch (e) { samples.push({ answer: '', conf: 0 }); }
  }
  // self-consistency = max vote fraction over normalized non-empty answers
  const tally = new Map();
  for (const s of samples) { const k = normAns(s.answer); if (!k) continue; tally.set(k, (tally.get(k) || 0) + 1); }
  let top = 0; for (const v of tally.values()) top = Math.max(top, v);
  const consistency = samples.length ? top / samples.length : 0;
  const confidence = samples.reduce((a, s) => a + s.conf, 0) / (samples.length || 1);
  return {
    task_id: task.task_id, q_chars: task.question.length, q_words: task.question.split(/\s+/).length,
    multihop_score: multihopScore(task.question), probe_consistency: Math.round(consistency * 1000) / 1000,
    probe_confidence: Math.round(confidence * 1000) / 1000, probe_answers: samples.map((s) => s.answer),
    probe_cost_usd: Math.round(cost * 1e6) / 1e6,
  };
}

writeFileSync(OUT, '');
let cursor = 0, done = 0, meterStopped = false, totalCost = 0;
async function accountUsage() { try { const r = await fetch(`${BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` } }); const j = await r.json(); return Number(j?.data?.usage); } catch { return NaN; } }
async function meterLoop() {
  if (!METER || !Number.isFinite(ABORT_USAGE)) return;
  while (cursor < tasks.length && !meterStopped) {
    const u = await accountUsage();
    if (Number.isFinite(u)) { console.error(`[meter] usage $${u.toFixed(2)} / abort $${ABORT_USAGE}`); if (u >= ABORT_USAGE) { meterStopped = true; console.error('[meter] ABORT'); break; } }
    await new Promise((r) => setTimeout(r, 20000));
  }
}
async function worker() {
  while (cursor < tasks.length && !meterStopped) {
    const task = tasks[cursor++];
    const row = await probeOne(task); totalCost += row.probe_cost_usd;
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    console.error(`[${++done}/${tasks.length}] ${row.task_id} cons=${row.probe_consistency} conf=${row.probe_confidence} mh=${row.multihop_score} $${row.probe_cost_usd.toFixed(5)}`);
  }
}
await Promise.all([meterLoop(), ...Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker())]);
meterStopped = true;
console.error(`\nDONE probe ${MODEL} ${done}/${tasks.length} | $${totalCost.toFixed(4)} → ${OUT}`);
