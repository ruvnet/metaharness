// SPDX-License-Identifier: MIT
//
// warmup-epoch.mjs — the ADR-201 §"GNN warm-up protocol" (H4: self-learning) skeleton.
//
//   Epoch 0 (explore) : run the subset on a fresh store; record trajectories (retrieved ids + outcome).
//   Feedback          : reinforce via memory.feedback({retrievedIds, resolved}) — SOLVE OUTCOMES ONLY.
//                       *** CONFORMANCE FIREWALL: never gold patches/answers. ***
//   Branch (COW)      : memory.branch() → derived .rvf carrying the reinforced weights (RVF rvfDerive).
//   Epoch 1 (exploit) : re-run the SAME instances on the weighted store.
//   Verdict           : H4 holds iff resolve(E1) > resolve(E0) + Wilson CI.
//
// At $0: run with --mock --synthetic to exercise the full Epoch0→feedback→branch→Epoch1 loop and
// the H4 verdict math without any network/GCP. The reward-rerank feedback path is shipped today;
// the graph-edge-reweight path is a TODO seam (see memory-layer.mjs feedback()).
//
//   $0:  node warmup-epoch.mjs --synthetic 40 --mock --kind ruvector --run-id wu-test
//   paid: OPENROUTER_API_KEY=$KEY node warmup-epoch.mjs --manifest m.json --model ... --kind ruvector

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMemory } from './memory-layer.mjs';
import { summarizeArm, wilson, retrievalLift } from './telemetry.mjs';
import { makeSyntheticManifest, mockLlm, normalizeAnswer } from './synthetic.mjs';
import { runTask } from './ruvector-eval.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const SYNTH = +argv('--synthetic', 0);
const MOCK = has('--mock');
const KIND = argv('--kind', 'ruvector');           // ruvector | dense (dense feedback also works)
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');
const ESCALATE = argv('--escalate', 'anthropic/claude-opus-4');
const K = +argv('--k', 3);  // smaller k → retrieval misses leave room for feedback to lift Epoch1
const MAX_CTX_TOK = +argv('--max-context-tokens', 12000);
const WEIGHT = +argv('--feedback-weight', 0.08);
const SEED = +argv('--seed', 42);
const REPORT = rel(argv('--report', 'warmup-report.json'));
const RUN_ID = argv('--run-id', `wu-${Date.now()}`);

// PER-INSTANCE model (matches ADR-201: each SWE instance has its OWN repo index/.rvf). Each task
// gets an isolated memory; cross-epoch learning lives in a persistent `rewardMap` (doc-id → bias)
// that survives into Epoch 1 — the shipped reward-rerank approximation of GNN edge-reweighting.
// (Doc ids are namespaced per task, so the map can't leak retrieval signal across instances.)
//
// runEpoch returns { records, lastMem } — lastMem is left OPEN so the caller can exercise the RVF
// COW branch (rvfDerive) on a real, populated store.
async function runEpoch(tasks, { baseLlm, rewardMap, keepLast = false }) {
  const records = [];
  let lastMem = null;
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const mem = makeMemory(KIND, { allowFallback: MOCK });
    await mem.index(task.corpus || []);
    if (rewardMap) for (const [id, w] of rewardMap) if (mem.docs.has(id)) mem.rewards.set(id, w); // carry weights
    const { hits, tokens } = await mem.query(task.question || task.problem, { k: K, maxTokens: MAX_CTX_TOK });
    const r = await baseLlm(buildPrompt(task.question || task.problem, hits));
    const answer = extractFinal(r.raw);
    const resolved = scoreAnswer(answer, task.answer);
    records.push({ id: task.id, resolved, escalated: false, contextTokens: tokens, cost: r.cost, retrievedIds: hits.map((h) => h.id), confidence: hits.length ? hits[0].score : 0 });
    if (keepLast && i === tasks.length - 1) lastMem = mem; else await mem.close();
  }
  return { records, lastMem };
}

// SOLVE-OUTCOME feedback → persistent reward map (NO gold). resolved → +w on retrieved docs (they
// helped); failed → −w/2 (demote the distractors that crowded out the answer).
function applyFeedback(rewardMap, records, weight) {
  let applied = 0;
  for (const r of records) {
    const delta = r.resolved ? weight : -weight * 0.5;
    for (const id of r.retrievedIds) { rewardMap.set(id, (rewardMap.get(id) || 0) + delta); applied++; }
  }
  return applied;
}

// minimal prompt/scoring (mirrors ruvector-eval; kept local to avoid circular surface).
function buildPrompt(q, hits) {
  const ctx = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n');
  return [{ role: 'system', content: 'Answer ONLY from CONTEXT. Reply "FINAL_ANSWER: <short answer>".' },
    { role: 'user', content: `CONTEXT:\n${ctx}\n\nQUESTION: ${q}\n\nFINAL_ANSWER:` }];
}
function extractFinal(raw) { const m = String(raw).match(/FINAL_ANSWER:\s*(.+)/i); return (m ? m[1] : raw).trim().split('\n')[0].trim(); }
function scoreAnswer(pred, gold) { if (gold == null) return false; const p = normalizeAnswer(pred); const g = normalizeAnswer(gold); return !!p && !!g && (p === g || p.includes(g) || g.includes(p)); }

async function main() {
  let tasks;
  if (SYNTH > 0) tasks = makeSyntheticManifest(SYNTH, SEED);
  else tasks = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest.json')), 'utf8')).tasks;

  const mkLlm = (model, tier) => {
    if (MOCK) return mockLlm({ tier });
    // lazy import of the OpenRouter client to keep $0 path dependency-light
    const key = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
    if (!key) { console.error('FATAL: no OPENROUTER_API_KEY (or pass --mock)'); process.exit(1); }
    const URL = 'https://openrouter.ai/api/v1/chat/completions';
    return async (messages, temp = 0.2) => {
      const res = await fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: 800, temperature: temp, usage: { include: true } }) });
      const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    };
  };
  const baseLlm = mkLlm(MODEL, 'base');
  const escLlm = mkLlm(ESCALATE, 'escalate');

  console.error(`[warmup] kind=${KIND} mock=${MOCK} tasks=${tasks.length} k=${K} run=${RUN_ID}`);
  const rewardMap = new Map();   // persistent cross-epoch weights (doc-id → bias)

  // ── Epoch 0 (explore) — per-instance, no learned weights yet ──
  const { records: e0, lastMem } = await runEpoch(tasks, { baseLlm, rewardMap: null, keepLast: KIND === 'ruvector' });
  const s0 = summarizeArm(e0);
  console.error(`Epoch0: resolve=${(s0.resolve * 100).toFixed(1)}% [${(s0.resolveCI.lo * 100).toFixed(1)},${(s0.resolveCI.hi * 100).toFixed(1)}]`);

  // ── Feedback (SOLVE OUTCOMES ONLY — no gold) → persistent reward map ──
  const fbApplied = applyFeedback(rewardMap, e0, WEIGHT);
  console.error(`Feedback: reinforced ${fbApplied} retrieval signals across ${rewardMap.size} docs (resolved→+w, failed→−w/2), mode=${KIND === 'ruvector' ? 'reward-rerank (graph-reweight=TODO)' : 'reward-rerank'}`);

  // ── Branch (REAL .rvf COW snapshot via rvfDerive) — exercise the lineage capability ──
  if (lastMem) {
    const child = await lastMem.branch(`epoch1-${RUN_ID}`);
    const probe = await child.query(tasks[tasks.length - 1].question, { k: K });
    console.error(`Branch: rvfDerive COW child OK (probe returned ${probe.hits.length} hits${probe.rvfDegraded ? ', rvf-degraded→inproc-fallback' : ''})`);
    await child.close(); await lastMem.close();
  } else {
    console.error('Branch: (dense kind) — COW = in-memory clone (RVF rvfDerive demonstrated when --kind ruvector)');
  }

  // ── Epoch 1 (exploit) — SAME instances, now carrying the reinforced reward map ──
  const { records: e1 } = await runEpoch(tasks, { baseLlm, rewardMap, keepLast: false });
  const s1 = summarizeArm(e1);
  console.error(`Epoch1: resolve=${(s1.resolve * 100).toFixed(1)}% [${(s1.resolveCI.lo * 100).toFixed(1)},${(s1.resolveCI.hi * 100).toFixed(1)}]`);

  // ── H4 verdict ──
  const delta = retrievalLift(s1.resolve, s0.resolve);
  const ci0 = wilson(s0.resolved, s0.n); const ci1 = wilson(s1.resolved, s1.n);
  const significant = ci1.lo > ci0.hi;                 // non-overlapping CIs = robust improvement
  const verdict = significant && delta > 0 ? 'H4 SUPPORTED' : (delta <= 0 ? 'H4 FALSIFIED (no lift)' : 'H4 INCONCLUSIVE (CI overlap)');
  console.error(`\nH4: Epoch1 − Epoch0 = ${(delta * 100).toFixed(1)}pt → ${verdict}`);

  const report = { runId: RUN_ID, kind: KIND, mock: MOCK, ts: Date.now(), k: K, feedbackWeight: WEIGHT, epoch0: s0, epoch1: s1, h4: { delta, ci0, ci1, significant, verdict } };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.error(`report → ${REPORT}`);
}

if (process.argv[1] && process.argv[1].endsWith('warmup-epoch.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

export { runEpoch, applyFeedback };
