// SPDX-License-Identifier: MIT
//
// cognition-harness.mjs — the "memory-as-cognition" substrate library.
//
// Tests, empirically, whether harness-evolve + agenticow branchable memory yields a
// MEASURABLE cognitive lift for a cheap model on the FRAMES (GAIA-class) multi-hop QA
// benchmark — or is null. It wires three existing pieces together:
//   - the FRAMES agentic ReAct episode (../gaia/scaffolds.mjs runEpisode + wiki tools)
//   - agenticow@0.2 branch/fork/checkpoint/query (Git-for-agent-memory, native ANN)
//   - a Darwin evolve loop over memory/context-shaping GENOMES (run-cognition.mjs)
//
// CONFORMANCE FIREWALL: the gold `answer` is NEVER read in any solve path. It is used
// ONLY by score()/fitness AFTER the episode finishes. The episodic memory holds the
// model's OWN prior attempts (gold-free), recalled leave-one-out by question similarity.
//
// This file is the PURE substrate (no fs of its own except the episode cache + .rvf
// memory files it is told to write). The runner injects the live llm()/tools.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgenticMemory } from 'agenticow';
import { runEpisode } from '../gaia/scaffolds.mjs';

export const EMB_DIM = 256;

// ── Deterministic, $0, dependency-free text embedder ──────────────────────────────
// Hashing TF embedding (FNV-1a token hash → bucket, L2-normalized). This is a LEXICAL
// embedding: it gives agenticow real cosine-recallable vectors with zero API cost and
// full reproducibility. We are testing the BRANCHING SUBSTRATE + experience-replay, not
// embedding quality (real-embedding RAG already came back null — see the results doc).
export function embedText(text, dim = EMB_DIM) {
  const v = new Float64Array(dim);
  const toks = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  for (const t of toks) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    v[h % dim] += 1;
  }
  let n = 0; for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Array(dim); for (let i = 0; i < dim; i++) out[i] = v[i] / n;
  return out;
}

// ── Wilson 95% score interval (binomial proportion) — same formula as score-gaia.mjs ──
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ── GAIA-style normalized exact-match scorer (ported from score-gaia.mjs) ──────────
function normNum(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normStr(s) { return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
export function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normNum(gold);
  if (gn !== null) { const pn = normNum(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) {
    const pl = splitList(pred);
    if (pl.length !== gl.length) return false;
    return gl.every((g, i) => { const gnum = normNum(g); if (gnum !== null) { const pnum = normNum(pl[i]); return pnum !== null && pnum === gnum; } return normStr(g) === normStr(pl[i]); });
  }
  return normStr(pred) === normStr(gold);
}

// ── Episode cache ─────────────────────────────────────────────────────────────────
// Cache key = (model, maxSteps, question, branch-shaping-signature). Because the
// episodic memory is PRE-BUILT and STATIC during B/C (leave-one-out), every episode is
// a deterministic function of its key → the Darwin search reuses building blocks across
// generations (cold selves are shared with Condition A; later gens are mostly cache
// hits). This is what keeps Condition C affordable and fully reproducible/resumable.
export class EpisodeCache {
  constructor(path) { this.path = path; this.map = {}; this.hits = 0; this.misses = 0;
    if (path && existsSync(path)) { try { this.map = JSON.parse(readFileSync(path, 'utf8')); } catch { this.map = {}; } } }
  static key({ model, maxSteps, question, sig }) {
    return createHash('sha1').update([model, maxSteps, question, sig].join('')).digest('hex').slice(0, 20);
  }
  get(k) { const v = this.map[k]; if (v) this.hits++; else this.misses++; return v; }
  set(k, v) { this.map[k] = v; }
  flush() { if (!this.path) return; mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.map)); }
}

// ── Branch shaping ─────────────────────────────────────────────────────────────────
// A "self" (memory branch) is fully described by its shaping spec. The signature is the
// cache identity. KINDS:
//   cold        no memory, plan-free base ReAct (identical to Condition A's episode)
//   mem         inject K recalled prior attempts on SIMILAR questions (episodic replay)
//   decomp      inject a sub-goal decomposition memo (within-question planning prior)
//   memdecomp   both
export const KINDS = ['cold', 'mem', 'decomp', 'memdecomp'];

export function shapingSig({ kind, episodicK, temp, seed }) {
  return `${kind}|k${kind === 'cold' || kind === 'decomp' ? 0 : episodicK}|t${temp}|s${seed}`;
}

// Build the memo string injected into runEpisode's header for a given shaping.
// `hints` = recalled prior-attempt strings (already leave-one-out filtered). `decomp` =
// a precomputed sub-goal decomposition (or '' to skip). Memory text is clearly framed as
// FALLIBLE prior experience so it shapes context without being treated as ground truth.
export function buildMemo({ kind, episodicK }, hints, decomp) {
  const parts = [];
  if ((kind === 'mem' || kind === 'memdecomp') && hints.length) {
    const hs = hints.slice(0, episodicK).map((h, i) => `  (${i + 1}) ${h}`).join('\n');
    if (hs) parts.push('PRIOR EXPERIENCE — your own past attempts on SIMILAR questions (may be WRONG; use only as a starting heuristic and verify independently):\n' + hs);
  }
  if ((kind === 'decomp' || kind === 'memdecomp') && decomp) {
    parts.push('DECOMPOSITION (sub-goals to chain; revise if a step proves wrong):\n' + decomp);
  }
  return parts.join('\n\n');
}

// ── Episodic store (agenticow) ─────────────────────────────────────────────────────
// One base memory file holding one vector per FRAMES task (the question embedding). The
// payload (the model's own prior attempt text) is kept in a parallel JSON array, since
// agenticow stores vectors+ids only. Recall is leave-one-out (a task never recalls
// itself). Branches FORK this base so each self has an isolated, COW-cheap view (the
// experiment exercises agenticow's fork/query even when payloads are read-side).
export function buildEpisodicStore(rvfPath, entries, dim = EMB_DIM) {
  mkdirSync(dirname(rvfPath), { recursive: true });
  const mem = AgenticMemory.open(rvfPath, { dimension: dim, metric: 'cosine' });
  const records = entries.map((e, i) => ({ id: i, vector: embedText(e.question, dim) }));
  if (records.length) mem.ingest(records);
  return { mem, payloads: entries.map((e) => e.payload), questions: entries.map((e) => e.question) };
}

// Recall up to k prior attempts for `task`, excluding its own index (leave-one-out).
// Genuinely FORKS the base memory (agenticow COW branch) and queries the fork — this is
// the "each self gets its own branched memory view" substrate the experiment tests. The
// fork's backing file goes to a unique temp path and is removed after close (no litter).
export function recallHints(store, taskIdx, qVec, k) {
  if (!k || !store || !store.payloads.length) return [];
  const fpath = join(tmpdir(), `cow-fork-${process.pid}-${randomBytes(6).toString('hex')}.rvf`);
  let hits = [], fork = null;
  try { fork = store.mem.fork(`q${taskIdx}`, fpath); hits = fork.query(qVec, k + 1) || []; }
  catch { hits = store.mem.query(qVec, k + 1) || []; }   // fallback: read base directly
  finally { try { fork && fork.close(); } catch { /**/ } try { rmSync(fpath, { force: true }); } catch { /**/ } }
  return hits.filter((h) => h.id !== taskIdx).slice(0, k).map((h) => store.payloads[h.id]).filter(Boolean);
}

// ── Solve one self (one memory branch) ──────────────────────────────────────────────
// Cache-backed. Returns { answer, notes, cost, steps, submitted, cached }.
export async function solveSelf(task, deps, shaping, store, opts, cache) {
  const { kind, episodicK, temp, seed } = shaping;
  const sig = shapingSig(shaping);
  const ckey = EpisodeCache.key({ model: opts.model, maxSteps: opts.maxSteps, question: task.question, sig });
  const cached = cache && cache.get(ckey);
  if (cached) return { ...cached, cost: 0, cached: true };

  let memo = '', decompCost = 0;
  if (kind !== 'cold') {
    const qVec = embedText(task.question);
    const hints = (kind === 'mem' || kind === 'memdecomp') ? recallHints(store, task._idx, qVec, episodicK) : [];
    let decomp = '';
    if (kind === 'decomp' || kind === 'memdecomp') { const d = await makeDecomp(task, deps); decomp = d.decomp; decompCost = d.cost; }
    memo = buildMemo(shaping, hints, decomp);
  }
  // seed only perturbs temperature deterministically (OpenRouter has no seed param here);
  // a non-zero seed nudges temp so branches diverge even at the same nominal temp.
  const effTemp = temp + (seed ? ((seed * 0.13) % 0.3) : 0);
  const ep = await runEpisode(task, deps, { maxSteps: opts.maxSteps, maxOut: opts.maxOut, temp: effTemp, memo });
  const notes = ep.transcript.map((t) => t.obs).join('\n').slice(-1200);
  const out = { answer: ep.answer, notes, steps: ep.steps, submitted: ep.submitted };
  if (cache) cache.set(ckey, out);
  return { ...out, cost: ep.cost + decompCost, cached: false };
}

// One short planning call → a sub-goal decomposition (gold-free). Cheap; ~1 call.
export async function makeDecomp(task, deps) {
  try {
    const r = await deps.llm([
      { role: 'system', content: 'You are a planner. Given a hard multi-hop question, write a SHORT numbered plan (3-6 steps) decomposing it into sub-questions / entities to look up on Wikipedia and the order to chain them. Output ONLY the plan, no answer.' },
      { role: 'user', content: `QUESTION:\n${task.question}\n\nPlan:` }], 0.3);
    return { decomp: (r.raw || '').trim().slice(0, 1000), cost: r.cost || 0 };
  } catch { return { decomp: '', cost: 0 }; }
}

// ── Selectors over K self answers ────────────────────────────────────────────────────
const normVote = (s) => String(s ?? '').toLowerCase().replace(/[$%,]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
export function majoritySelect(cands) {
  const tally = new Map();
  for (const c of cands) { const k = normVote(c.answer); if (!k) continue; tally.set(k, (tally.get(k) || 0) + 1); }
  let key = '', best = 0; for (const [k, n] of tally) if (n > best) { best = n; key = k; }
  return (cands.find((c) => normVote(c.answer) === key) || cands.find((c) => c.answer) || cands[0] || {}).answer || '';
}
const cap = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '\n…[truncated]' : String(s ?? ''));
export async function verifierSelect(task, cands, deps) {
  const nonEmpty = cands.filter((c) => c.answer);
  if (nonEmpty.length <= 1) return { answer: nonEmpty[0]?.answer || '', cost: 0, pick: nonEmpty[0]?.i ?? -1 };
  try {
    const list = cands.map((c, i) => `[#${i}] answer="${c.answer || '(none)'}"\n notes: ${cap(c.notes, 800)}`).join('\n\n');
    const r = await deps.llm([
      { role: 'system', content: 'You are a verifier. Given a question and several candidate answers each with the research notes that produced them, choose the candidate whose answer is BEST SUPPORTED by its notes (most likely correct). Output ONLY a JSON object {"best":<index>,"answer":"<that candidate\'s short answer, cleaned>"}.' },
      { role: 'user', content: `QUESTION:\n${task.question}\n\nCANDIDATES:\n${list}\n\nJSON:` }], 0);
    const m = (r.raw || '').match(/\{[\s\S]*\}/);
    if (m) { const j = JSON.parse(m[0]); const idx = Number(j.best); const picked = cands[idx]; return { answer: (j.answer && String(j.answer).trim()) || picked?.answer || majoritySelect(cands), cost: r.cost || 0, pick: idx }; }
  } catch { /* fall back */ }
  return { answer: majoritySelect(cands), cost: 0, pick: -1 };
}

// ── Parallel-selves solve (Condition B core; also the per-genome solve in C) ──────────
// Given a GENOME describing the branch palette + selector, fork K memory branches, solve
// each, and select. Returns the primary (selector) answer + the majority answer + cost.
export function genomeBranches(genome) {
  // Map the genome to K concrete shaping specs (one per self). Branch kinds rotate over
  // the genome's palette; each self gets a distinct seed so the branches diverge.
  const palette = genome.palette && genome.palette.length ? genome.palette : ['cold'];
  const out = [];
  for (let i = 0; i < genome.selves; i++) {
    const kind = palette[i % palette.length];
    out.push({ kind, episodicK: genome.episodicK, temp: genome.temp, seed: genome.seedSpread ? i + 1 : 0 });
  }
  return out;
}

export async function solveParallel(task, deps, genome, store, opts, cache) {
  const branches = genomeBranches(genome);
  const cands = [];
  let cost = 0;
  for (let i = 0; i < branches.length; i++) {
    const r = await solveSelf(task, deps, branches[i], store, opts, cache);
    cost += r.cost; cands.push({ i, answer: r.answer, notes: r.notes, submitted: r.submitted });
  }
  const majority = majoritySelect(cands);
  let primary = majority, pick = -1;
  if (genome.selector === 'verifier') { const v = await verifierSelect(task, cands, deps); primary = v.answer; cost += v.cost; pick = v.pick; }
  return { answer: primary, majority_answer: majority, candidate_answers: cands.map((c) => c.answer), cost, pick, selves: branches.length };
}
