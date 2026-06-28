// SPDX-License-Identifier: MIT
//
// memory-layer.mjs — the removable memory seam for the ADR-201 ablation (ADR-150 constraint).
//
// ONE interface, TWO implementations. The A/B/C runner depends ONLY on this interface, so
// ruvector is a drop-in/drop-out augmentation; the base cascade still runs on DenseMemory alone.
//
//   interface MemoryLayer {
//     async index(docs)        docs:[{id,text,metadata?}]            -> {count, ms}
//     async query(q, opts)     q:string, opts:{k, maxTokens?}        -> {hits:[{id,text,score,metadata}], tokens, ms}
//     async mutate(diff)       diff:{upsert?:[{id,text,metadata}], delete?:[id]} -> {applied, ms}
//     async feedback(outcome)  outcome:{retrievedIds:[], resolved:bool, weight?} -> {applied}
//     async branch(childId)    -> a NEW MemoryLayer sharing parent data (COW snapshot)
//     async snapshot()         alias of branch() with an auto id
//     async close()
//     get kind()               'dense' | 'ruvector'
//   }
//
// CONFORMANCE FIREWALL: feedback() consumes SOLVE OUTCOMES (resolved:boolean derived from the
// harness's own test signal) — NEVER gold patches/answers. There is no parameter for gold here.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// REAL ruvector@0.2.32 capability map (ground-truthed at runtime 2026-06-28; see README.md):
//   ✅ RVF persistent store + COW lineage : createRvfStore/openRvfStore/rvfIngest/rvfQuery/
//                                            rvfDerive(=COW child)/rvfDelete/rvfStatus/rvfClose
//   ✅ GNN module present                 : isGnnAvailable() === true
//   ❌ GraphRAG / Cypher retrieval        : CodeGraph.cypher() throws — needs @ruvector/graph-node
//                                            (NOT bundled). isGraphAvailable() === false. → STUBBED.
//   ⚠️ GNN edge-reweight "memory_feedback": no such call. Self-learning is exposed as RL episode
//                                            recording (IntelligenceEngine.recordEpisode/forceLearn,
//                                            LearningEngine.qLearningUpdate…), NOT graph edge-weight
//                                            reinforcement. We implement feedback as a reward-weighted
//                                            re-rank persisted into a derived RVF (a faithful, shipped
//                                            approximation) and leave a TODO seam for the graph path.
// ────────────────────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embedText, cosine, estimateTokens, DEFAULT_DIM } from './embedder.mjs';

const require = createRequire(import.meta.url);

// ── ruvector loader (mirrors swebench/ruvector-localize.mjs resolution) ──────────────────────
// Prefers an explicit RUVECTOR_PATH, then the repo/global 'ruvector', then known local installs.
// We REQUIRE >=0.2.x for the RVF surface; 0.1.x lacks rvf* exports.
const RUVECTOR_CANDIDATES = [
  process.env.RUVECTOR_PATH,
  'ruvector',
  '/home/ruvultra/projects/ruvector/node_modules/ruvector',
].filter(Boolean);

let _rvCache;
export function loadRuvector() {
  if (_rvCache !== undefined) return _rvCache;
  for (const cand of RUVECTOR_CANDIDATES) {
    try {
      const rv = require(cand);
      const ver = rv.getVersion ? rv.getVersion().version : '?';
      _rvCache = { rv, path: cand, version: ver, rvfAvailable: !!(rv.isRvfAvailable && rv.isRvfAvailable()) };
      return _rvCache;
    } catch { /* try next */ }
  }
  _rvCache = null;
  return null;
}

// ── shared embed hook ────────────────────────────────────────────────────────────────────────
// Both arms share ONE embedder so A/B isolates the index, not the embedding model. Override by
// passing { embed: async (text)=>number[] } to use OnnxEmbedder / an API embedder in a paid run.
function defaultEmbed(dim) { return (text) => embedText(text, dim); }

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (a) DENSE BASELINE — in-process cosine. Keyless, $0, dependency-free. The Control A arm.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export class DenseMemory {
  constructor({ dim = DEFAULT_DIM, embed } = {}) {
    this.dim = dim;
    this._embed = embed || defaultEmbed(dim);
    this.docs = new Map();        // id -> { id, text, metadata, vector }
    this.rewards = new Map();     // id -> additive score bias (from feedback)
    this.kind = 'dense';
  }

  async index(docs) {
    const t0 = Date.now();
    for (const d of docs) {
      const vector = await this._embed(d.text);
      this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
    }
    return { count: this.docs.size, ms: Date.now() - t0 };
  }

  async query(q, { k = 8, maxTokens = Infinity } = {}) {
    const t0 = Date.now();
    const qv = await this._embed(q);
    const scored = [];
    for (const d of this.docs.values()) {
      const base = cosine(qv, d.vector);
      const bias = this.rewards.get(d.id) || 0;
      scored.push({ id: d.id, text: d.text, metadata: d.metadata, score: base + bias });
    }
    scored.sort((a, b) => b.score - a.score);
    // top-k, then trim to a token budget (so context-length telemetry is meaningful)
    const hits = [];
    let tokens = 0;
    for (const h of scored.slice(0, k)) {
      const t = estimateTokens(h.text);
      if (tokens + t > maxTokens && hits.length) break;
      hits.push(h); tokens += t;
    }
    return { hits, tokens, ms: Date.now() - t0 };
  }

  async mutate(diff = {}) {
    const t0 = Date.now();
    let applied = 0;
    for (const d of diff.upsert || []) { await this.index([d]); applied++; }
    for (const id of diff.delete || []) { if (this.docs.delete(id)) { this.rewards.delete(id); applied++; } }
    return { applied, ms: Date.now() - t0 };
  }

  // feedback: SOLVE-OUTCOME-driven reward shaping. Resolved → boost the docs that were retrieved
  // (they likely helped); failed → mild penalty. No gold ever enters here.
  async feedback({ retrievedIds = [], resolved = false, weight = 0.05 } = {}) {
    const delta = resolved ? weight : -weight * 0.5;
    for (const id of retrievedIds) this.rewards.set(id, (this.rewards.get(id) || 0) + delta);
    return { applied: retrievedIds.length, delta };
  }

  async branch(childId = `dense-${Date.now()}`) {
    const child = new DenseMemory({ dim: this.dim, embed: this._embed });
    for (const [id, d] of this.docs) child.docs.set(id, { ...d, vector: d.vector.slice ? d.vector.slice() : d.vector });
    for (const [id, r] of this.rewards) child.rewards.set(id, r);
    child._branchId = childId;
    return child;
  }

  async snapshot() { return this.branch(); }
  async close() { /* in-memory; nothing to release */ }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// (b) RUVECTOR — wired to the REAL RVF native surface. Test B / Test C arm.
//   • index/query/mutate  → RVF (createRvfStore/rvfIngest/rvfQuery/rvfDelete) — REAL, shipped.
//   • branch/snapshot     → rvfDerive() COW child store — REAL, shipped.
//   • feedback            → reward-weighted re-rank persisted via a derived store (shipped path);
//                            graph-edge-reweight left as a TODO seam (capability not in 0.2.32).
//   • GraphRAG retrieval  → STUB: falls back to vector kNN with a [GRAPHRAG-STUB] marker.
// NOTE on the v0.2.32 id quirk: rvfQuery returns positional/remapped ids (observed "0","1"…),
//   not the canonical id we ingested. We keep an authoritative JS doc table + an ingest-order
//   array and resolve payloads through it. Documented; revisit when the native id round-trips.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export class RuvectorMemory {
  constructor({ dim = DEFAULT_DIM, embed, storePath, metric = 'cosine', graphrag = false } = {}) {
    const loaded = loadRuvector();
    if (!loaded) throw new Error('ruvector not resolvable. Set RUVECTOR_PATH to a ruvector@0.2.x install (RVF surface required).');
    if (!loaded.rvfAvailable) throw new Error(`ruvector@${loaded.version} has no RVF surface (need @ruvector/rvf). RVF is required for the ADR-201 .rvf COW protocol.`);
    this.rv = loaded.rv;
    this.version = loaded.version;
    this.dim = dim;
    this.metric = metric;
    this.graphrag = graphrag;           // when true, attempts GraphRAG → currently STUBBED to kNN
    this._embed = embed || defaultEmbed(dim);
    // collision-free path (concurrency-safe): UUID, not a same-ms timestamp. Base dir overridable
    // via opts.rvfDir or $RVF_DIR (some sandboxed /tmp mounts reject fsync; point it at a real fs).
    this.storePath = storePath || join(process.env.RVF_DIR || tmpdir(), `adr201-rvf-${process.pid}-${randomUUID()}.rvf`);
    this.docs = new Map();              // canonical id -> { id, text, metadata, vector }
    this.order = [];                   // ingest order; index i ↔ canonical id
    this.rewards = new Map();
    this.store = null;
    this.kind = 'ruvector';
    this._graphragWarned = false;
  }

  async _ensureStore() {
    if (this.store) return this.store;
    const fs = await import('node:fs');
    try { fs.rmSync(this.storePath, { recursive: true, force: true }); } catch { /* ignore */ }
    this.store = await this.rv.createRvfStore(this.storePath, { dimensions: this.dim, metric: this.metric });
    return this.store;
  }

  async index(docs) {
    const t0 = Date.now();
    const store = await this._ensureStore();
    const entries = [];
    for (const d of docs) {
      const vector = await this._embed(d.text);
      this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
      this.order.push(d.id);
      entries.push({ id: d.id, vector: Array.from(vector), metadata: { origId: d.id } });
    }
    if (entries.length) await this.rv.rvfIngest(store, entries);
    return { count: this.docs.size, ms: Date.now() - t0 };
  }

  // Resolve an rvfQuery result handle back to our canonical doc (works around the id-remap quirk).
  _resolveHit(resultId, score) {
    let doc = this.docs.get(resultId);                       // path 1: canonical id round-tripped
    if (!doc) {
      const n = Number(resultId);                            // path 2: positional id into ingest order
      if (Number.isInteger(n) && n >= 0 && n < this.order.length) doc = this.docs.get(this.order[n]);
    }
    if (!doc) return null;
    const bias = this.rewards.get(doc.id) || 0;
    return { id: doc.id, text: doc.text, metadata: doc.metadata, score: score + bias };
  }

  async query(q, { k = 8, maxTokens = Infinity } = {}) {
    const t0 = Date.now();
    const store = await this._ensureStore();
    const qv = await this._embed(q);

    if (this.graphrag && !this._graphragWarned) {
      // [GRAPHRAG-STUB] ruvector@0.2.32 CodeGraph.cypher requires @ruvector/graph-node (not shipped).
      // When that lands, route multi-hop retrieval through CodeGraph here. For now → vector kNN.
      this._graphragWarned = true;
    }

    // 1) Exercise the REAL RVF query path (diagnostics / lineage). Over-fetch.
    const wantN = Math.min(this.docs.size, Math.max(k * 3, k));
    const raw = await this.rv.rvfQuery(store, Array.from(qv), wantN);
    let resolved = raw.map((r) => this._resolveHit(r.id, distanceToScore(r.distance, this.metric))).filter(Boolean);

    // 2) DEGRADED-RVF FALLBACK: @ruvector/rvf at this dep version persists/queries only ONE vector
    //    per store (verified 2026-06-28: ingest reports accepted=N but totalVectors=1, query
    //    returns ≤1 hit). Until native multi-vector RVF query is fixed, rank over the authoritative
    //    in-JS doc table (same embedder) so the arm is functional. RVF still provides persistence +
    //    COW lineage (rvfDerive). TODO[rvf-query]: drop this fallback when rvfQuery returns k hits.
    const degraded = resolved.length < Math.min(k, this.docs.size);
    if (degraded) {
      resolved = [];
      for (const d of this.docs.values()) {
        const bias = this.rewards.get(d.id) || 0;
        resolved.push({ id: d.id, text: d.text, metadata: d.metadata, score: cosine(qv, d.vector) + bias });
      }
    }
    resolved.sort((a, b) => b.score - a.score);

    const hits = [];
    let tokens = 0;
    for (const h of resolved.slice(0, k)) {
      const t = estimateTokens(h.text);
      if (tokens + t > maxTokens && hits.length) break;
      hits.push(h); tokens += t;
    }
    return { hits, tokens, ms: Date.now() - t0, graphragStubbed: this.graphrag, rvfDegraded: degraded };
  }

  async mutate(diff = {}) {
    const t0 = Date.now();
    const store = await this._ensureStore();
    let applied = 0;
    const ups = [];
    for (const d of diff.upsert || []) {
      const vector = await this._embed(d.text);
      this.docs.set(d.id, { id: d.id, text: d.text, metadata: d.metadata || {}, vector });
      if (!this.order.includes(d.id)) this.order.push(d.id);
      ups.push({ id: d.id, vector: Array.from(vector), metadata: { origId: d.id } });
      applied++;
    }
    if (ups.length) await this.rv.rvfIngest(store, ups);
    if ((diff.delete || []).length) { await this.rv.rvfDelete(store, diff.delete); for (const id of diff.delete) { this.docs.delete(id); this.rewards.delete(id); applied++; } }
    return { applied, ms: Date.now() - t0 };
  }

  // feedback: SOLVE-OUTCOME reward shaping (no gold). Shipped approximation of GNN self-learning:
  // reward map biases the re-rank; persists across the COW branch used for Epoch 1.
  // TODO[gnn-feedback]: when ruvector exposes graph edge-reweight, reinforce retrieval-path edges
  // (+w on resolved, −w on failed) instead of node-level reward bias.
  async feedback({ retrievedIds = [], resolved = false, weight = 0.05 } = {}) {
    const delta = resolved ? weight : -weight * 0.5;
    for (const id of retrievedIds) this.rewards.set(id, (this.rewards.get(id) || 0) + delta);
    return { applied: retrievedIds.length, delta, mode: 'reward-rerank' };
  }

  // branch: REAL COW via rvfDerive — the ADR-201 ".rvf snapshot/branch" for Epoch0→Epoch1.
  async branch(childId = `child-${Date.now()}`) {
    const store = await this._ensureStore();
    const childPath = `${this.storePath}.${childId}`;
    const childStore = await this.rv.rvfDerive(store, childPath);
    const child = Object.create(RuvectorMemory.prototype);
    Object.assign(child, {
      rv: this.rv, version: this.version, dim: this.dim, metric: this.metric, graphrag: this.graphrag,
      _embed: this._embed, storePath: childPath, store: childStore,
      docs: new Map([...this.docs].map(([id, d]) => [id, { ...d }])),
      order: this.order.slice(), rewards: new Map(this.rewards), kind: 'ruvector', _graphragWarned: this._graphragWarned,
    });
    return child;
  }

  async snapshot() { return this.branch(`snap-${Date.now()}`); }

  async close() { if (this.store) { try { await this.rv.rvfClose(this.store); } catch { /* ignore */ } this.store = null; } }
}

/** RVF returns a distance; convert to a "higher-is-better" score for uniform re-ranking. */
function distanceToScore(distance, metric) {
  if (metric === 'cosine') return 1 - distance;     // cosine distance ∈ [0,2] → score ∈ [-1,1]
  return -distance;                                 // l2/dot: smaller distance = higher score
}

/**
 * Factory used by the runner. kind: 'dense' (Control A) | 'ruvector' (Test B/C).
 * Falls back to DenseMemory with a logged warning if ruvector can't load and allowFallback=true.
 */
export function makeMemory(kind, opts = {}) {
  if (kind === 'dense') return new DenseMemory(opts);
  if (kind === 'ruvector') {
    try { return new RuvectorMemory(opts); }
    catch (e) {
      if (opts.allowFallback) { console.error(`[memory-layer] ruvector unavailable (${e.message}) — falling back to DenseMemory`); return new DenseMemory(opts); }
      throw e;
    }
  }
  throw new Error(`unknown memory kind: ${kind}`);
}
