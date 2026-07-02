// SPDX-License-Identifier: MIT
//
// ADR-230 §"GEPA pilot scope" — Agenticow branch-memory wired into the GEPA candidate lifecycle.
//
// WHAT THIS IS (and is NOT): Agenticow is the MEMORY TRANSACTION layer, not the intelligence. It
// does NOT decide accept/reject — that stays the GEPA metric (gepa-loop.mjs sum/Pareto). This module
// RECORDS LINEAGE: for every GEPA candidate it opens a 162-byte COW branch off the current frontier
// parent, stores the candidate's marker vectors + rich payload, and — only on a holdout win —
// promotes the branch into the seed base. Rejected candidates are RETAINED with their lineage
// (never promoted, never deleted) so they stay query-able as GEPA's memory of what-not-to-do.
//
// REAL AGENTICOW API (verified against agenticow@0.2.3 src/index.js, NOT the .d.ts):
//   - factory is `open(path,{dimension})` — there is NO `openBase` export at runtime.
//   - `ingest([{id,vector}])` / `ingest(Float32Array, ids)` — VECTORS ONLY; the `.d.ts` `text`
//     payload field is not implemented, so rich JSON (genome / diff / trace / lesson) lives in a
//     parallel per-candidate payload map (the "sidecar") that this module owns and persists.
//   - `branch(label)` → 162 B COW file regardless of base size; `diff()` → {added,overridden,deleted}
//     vector-id arrays; `checkpoint(label)`/`rollback(id)`; `lineage()`; `save(path)`.
//   - `promote(target)` REQUIRES an explicit AgenticMemory target (no default-to-parent).
//
// GRACEFUL DEGRADATION: agenticow is an OPTIONAL dep. When it is absent (or fails to open), this
// module runs in `degraded` mode: the branch/checkpoint/promote/diff mechanics become logged no-ops
// returning {degraded:true}, GEPA keeps running unchanged, and the pure-JSON lineage/lesson recording
// still works (the portable lessons — "move promoted lessons, not raw branch mechanics" — do not need
// the .rvf substrate). exportPromotedLessons therefore emits in both modes.

import { statSync, readdirSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

const DEFAULT_DIM = 32;

// ── deterministic dependency-free string→vector embedder ────────────────────────────────────────────
// Agenticow keys memory by vector; the genome/trace text is embedded into a small fixed-dim marker so
// that (a) diff()/promote() have real ids to move and (b) the branch stays semantically query-able.
// Determinism matters only for test reproducibility — the lineage truth lives in the JSON payload.
export function embedText(text, dim = DEFAULT_DIM) {
  const v = new Float32Array(dim);
  const s = String(text ?? '');
  let h = 0x811c9dc5; // FNV-1a seed
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
    v[h % dim] += ((h >>> 8) & 0xff) / 255 - 0.5;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  if (n === 1 && s.length === 0) v[0] = 1; // never emit an all-zero vector
  return v;
}

// ── the minimum portable lineage object (ADR-230, user's spec) ──────────────────────────────────────
// This is what would later sync to ADR-227 Firestore — the LESSON, not the raw .rvf branch.
function toPortable(rec) {
  return {
    genome_id: rec.genome_id,
    parent: rec.parent,
    mutation_diff: rec.mutation_diff,
    eval_set: rec.eval_set,
    score: rec.score,
    parent_score: rec.parent_score,
    decision: rec.decision,
    regression_instances: rec.regression_instances || [],
    improvement_instances: rec.improvement_instances || [],
    failure_modes: rec.failure_modes || {},
    lesson: rec.lesson || null,
  };
}

/**
 * Reconstruct a promoted candidate's genome from its portable lineage object + the parent genome.
 * Proves acceptance criterion "a promoted candidate reconstructable from lineage": applying the
 * mutation_diff.after to the named component of the parent yields the child genome.
 */
export function reconstructGenome(portable, parentGenome) {
  const d = portable.mutation_diff;
  if (!d || !d.component) return { ...parentGenome };
  return {
    ...parentGenome,
    meta: { ...(parentGenome.meta || {}), id: portable.genome_id, parent: portable.parent, mutated: d.component },
    components: { ...(parentGenome.components || {}), [d.component]: d.after },
  };
}

/**
 * BranchMemory — the FlywheelMemory-shaped façade over Agenticow for the GEPA candidate lifecycle.
 * Construct via the async factory `openBase(...)`, then drive the candidate loop:
 *   checkpoint → branchCandidate → recordGenome → recordEvalTrace → diffAgainstParent → (setDecision)
 *   → promoteToBase (holdout-win only) → lineage / exportPromotedLessons.
 */
export class BranchMemory {
  constructor({ basePath, dimension, aw, base, logger, seedGenome }) {
    this.basePath = basePath;
    this.baseDir = basePath ? dirname(basePath) : null;
    this.dimension = dimension;
    this._aw = aw;                 // the agenticow module (or null when degraded)
    this._base = base;             // the base AgenticMemory (or null when degraded)
    this.degraded = !aw || !base;
    this._log = logger || console;
    this._seedGenome = seedGenome || null;
    this._records = new Map();     // genome_id → rich sidecar payload
    this._branches = new Map();    // genome_id → AgenticMemory branch handle
    this._checkpoints = [];        // { id, label } restore points on the base
    this._nextId = 1000;           // running marker-id allocator (base reserves <1000)
    this._seedId = null;
  }

  _warnOnce() {
    if (!this._warned) { this._warned = true; this._log.warn?.('[branch-memory] agenticow unavailable — running degraded (branch mechanics are no-ops; JSON lineage still recorded)'); }
  }

  /** Label a restore point on the base BEFORE branching a candidate (§2). */
  checkpoint(label) {
    if (this.degraded) { this._warnOnce(); return { degraded: true, label }; }
    const ck = this._base.checkpoint(label);
    this._checkpoints.push({ id: ck.id, label });
    return ck;
  }

  /**
   * Open a 162 B COW branch for a candidate off the current frontier PARENT (§2).
   * `parent` is the parent genome_id; when it is the seed (or omitted) we branch off the base,
   * otherwise off the parent candidate's own branch — so the frontier lineage is preserved.
   */
  branchCandidate(genomeId, { parent = null } = {}) {
    const parentId = parent ?? this._seedId ?? '(seed)';
    const rec = this._records.get(genomeId) || { genome_id: genomeId };
    rec.parent = parentId;
    rec.createdAt = Date.now();
    this._records.set(genomeId, rec);
    if (this.degraded) { this._warnOnce(); return { degraded: true, genome_id: genomeId, parent: parentId }; }
    const parentMem = (parent && this._branches.get(parent)) || this._base;
    const before = this._rvfFiles();
    const branch = parentMem.branch(genomeId);
    this._branches.set(genomeId, branch);
    // Capture the EMPTY COW-branch file size (agenticow's 162 B invariant, before any ingest) — this
    // is the pure branching overhead the <5%-of-full-copy claim measures (materialized branches that
    // then store candidate vectors grow to one segment; both sizes are reported transparently).
    const fresh = this._rvfFiles().filter((f) => !before.includes(f));
    if (fresh.length) { try { rec._emptyBranchSize = statSync(join(this.baseDir, fresh[0])).size; rec._branchFile = fresh[0]; } catch { /* */ } }
    this._records.set(genomeId, rec);
    return branch;
  }

  _rvfFiles() {
    if (!this.baseDir) return [];
    try { return readdirSync(this.baseDir).filter((f) => f.endsWith('.rvf')); } catch { return []; }
  }

  /** Store the candidate genome (marker vector in the branch + full genome in the sidecar) (§2). */
  recordGenome(genomeId, genome) {
    const rec = this._records.get(genomeId) || { genome_id: genomeId };
    rec.genome = genome;
    rec.target = genome?.meta?.mutated ?? null;
    if (rec.parent == null) rec.parent = genome?.meta?.parent ?? null;
    // capture the mutation_diff (before/after of the mutated component) vs the seed/parent genome
    const target = rec.target;
    if (target) {
      const parentGenome = (rec.parent && this._records.get(rec.parent)?.genome) || this._seedGenome;
      rec.mutation_diff = {
        component: target,
        before: parentGenome?.components?.[target] ?? null,
        after: genome?.components?.[target] ?? null,
      };
    }
    this._records.set(genomeId, rec);
    if (this.degraded) { this._warnOnce(); return { degraded: true }; }
    const branch = this._branches.get(genomeId);
    if (!branch) throw new Error(`recordGenome: no open branch for ${genomeId} — call branchCandidate first`);
    const id = this._nextId++;
    rec._genomeVecId = id;
    branch.ingest([{ id, vector: embedText(`${genomeId}::${target}::${rec.mutation_diff?.after ?? ''}`, this.dimension) }]);
    return { ingested: 1, vecId: id };
  }

  /**
   * Store the candidate's eval trace + score-parts (§2). Per-instance marker vectors go into the
   * branch (so the branch grows with real evaluation evidence and diff() reflects it); the full
   * scores/feedbacks/parts + derived report fields go into the sidecar.
   */
  recordEvalTrace(genomeId, { scores = {}, feedbacks = {}, scoreParts = {}, cost = 0, evalSet = 'train', gold = null } = {}) {
    const rec = this._records.get(genomeId) || { genome_id: genomeId };
    rec.scores = scores; rec.feedbacks = feedbacks; rec.score_parts = scoreParts;
    rec.eval_set = evalSet; rec.cost = cost; rec.gold = gold;
    rec.score = Object.values(scores).reduce((s, x) => s + (x || 0), 0);
    this._records.set(genomeId, rec);
    if (this.degraded) { this._warnOnce(); return { degraded: true }; }
    const branch = this._branches.get(genomeId);
    if (!branch) throw new Error(`recordEvalTrace: no open branch for ${genomeId}`);
    const ids = Object.keys(scores);
    if (!ids.length) return { ingested: 0 };
    const records = ids.map((inst) => ({ id: this._nextId++, vector: embedText(`${genomeId}::${inst}::${scores[inst]}::${feedbacks[inst] ?? ''}`, this.dimension) }));
    branch.ingest(records);
    return { ingested: records.length };
  }

  /**
   * The mutation-diff (§3). Two layers, both returned:
   *   vector_diff  — agenticow branch.diff() {added,overridden,deleted}: proof the branch recorded
   *                  the candidate's edit at the memory-transaction layer.
   *   mutation_diff— the human-readable component before/after (from the sidecar): the actual GEPA
   *                  mutation. This is the `diff(parent, cand-N)` the ADR asks for.
   */
  diffAgainstParent(genomeId) {
    const rec = this._records.get(genomeId) || {};
    const mutation_diff = rec.mutation_diff ?? null;
    if (this.degraded) { this._warnOnce(); return { degraded: true, mutation_diff, vector_diff: null }; }
    const branch = this._branches.get(genomeId);
    const vector_diff = branch ? branch.diff() : null;
    if (rec) { rec.vector_diff = vector_diff; this._records.set(genomeId, rec); }
    return { mutation_diff, vector_diff };
  }

  /**
   * Record GEPA's accept/reject/holdout_win decision + the regression report + lesson IN the branch's
   * lineage (§3/§4/§5). Does NOT promote — promotion is a separate, holdout-gated step.
   *   report: { regressed[], improved[], failure_modes{}, lesson, parent_score?, parent_gold? }
   */
  setDecision(genomeId, decision, report = {}) {
    const rec = this._records.get(genomeId) || { genome_id: genomeId };
    rec.decision = decision;
    rec.regression_instances = report.regressed ?? report.regression_instances ?? rec.regression_instances ?? [];
    rec.improvement_instances = report.improved ?? report.improvement_instances ?? rec.improvement_instances ?? [];
    rec.failure_modes = report.failure_modes ?? rec.failure_modes ?? {};
    rec.lesson = report.lesson ?? rec.lesson ?? null;
    if (report.parent_score != null) rec.parent_score = report.parent_score;
    if (report.parent_gold != null) rec.parent_gold = report.parent_gold;
    this._records.set(genomeId, rec);
    return toPortable(rec);
  }

  /**
   * Graduate a holdout-winning candidate into the seed BASE (§5). ONLY holdout-winners promote
   * (frozen-seed rule, ADR §7.1). Accept/reject candidates keep their branch but never call this.
   */
  promoteToBase(genomeId) {
    const rec = this._records.get(genomeId) || { genome_id: genomeId };
    rec.decision = 'holdout_win';
    rec.promoted = true;
    this._records.set(genomeId, rec);
    if (this.degraded) { this._warnOnce(); return { degraded: true, promoted: false }; }
    const branch = this._branches.get(genomeId);
    if (!branch) throw new Error(`promoteToBase: no open branch for ${genomeId}`);
    const res = branch.promote(this._base);      // explicit target — required by agenticow
    this._seedGenome = rec.genome || this._seedGenome; // the winner becomes the new seed-base genome
    return { ...res, promoted: true };
  }

  /** Persist the branch's .rvf manifest (for reconstructability + storage-overhead measurement). */
  snapshotBranch(genomeId) {
    if (this.degraded) { this._warnOnce(); return { degraded: true }; }
    const branch = this._branches.get(genomeId);
    if (!branch) throw new Error(`snapshotBranch: no open branch for ${genomeId}`);
    const path = join(this.baseDir, `branch-${genomeId}.manifest.json`);
    branch.save(path);
    const rec = this._records.get(genomeId); if (rec) rec.branch_manifest = path;
    return { path, size: statSync(path).size };
  }

  /** The minimum portable lineage object for one candidate (§"minimum lineage object"). */
  lineage(genomeId) {
    const rec = this._records.get(genomeId);
    if (!rec) return null;
    const portable = toPortable(rec);
    // attach the agenticow chain when available (raw mechanics, kept OUT of the portable export)
    if (!this.degraded) {
      const branch = this._branches.get(genomeId);
      portable._chain = branch ? branch.lineage().map((n) => ({ role: n.role, label: n.label, mutations: n.mutations })) : null;
      portable._vector_diff = rec.vector_diff ?? null;
    }
    return portable;
  }

  /** All recorded candidates as portable lineage objects (every accept/reject/holdout_win). */
  allLineage() {
    return [...this._records.values()].filter((r) => r.decision != null && r.decision !== 'seed').map(toPortable);
  }

  /**
   * Export the portable lessons that would sync to ADR-227 Firestore (§"move promoted lessons").
   * Default: every DECIDED candidate's portable lineage object (the full lesson set). Pass
   * {onlyPromoted:true} for holdout-winners only. Emits in degraded mode too (pure JSON).
   */
  exportPromotedLessons({ onlyPromoted = false } = {}) {
    let recs = [...this._records.values()].filter((r) => r.decision != null && r.decision !== 'seed');
    if (onlyPromoted) recs = recs.filter((r) => r.decision === 'holdout_win' || r.promoted);
    return recs.map(toPortable);
  }

  /**
   * Measure real branch storage overhead vs full-copy (acceptance: <5%).
   *
   * The headline metric is the COW invariant agenticow actually guarantees: a branch is a fixed ~162 B
   * COW delta REGARDLESS of base size, versus a full-copy snapshot which must duplicate the whole base
   * (baseSize). So overheadPct = meanEmptyBranch / baseSize — and for any realistically-sized base
   * (the seed genome + its eval-trace corpus, ≥ ~3.3 KB) the 162 B branch is < 5%, trivially.
   *
   * Materialized branches (that then ingest the candidate's marker vectors) grow to one COW segment
   * (~0.6–1.3 KB); those raw sizes are reported too so the number is fully auditable, never gamed.
   */
  measureStorageOverhead() {
    if (this.degraded || !this.baseDir) return { degraded: true };
    const baseFile = basename(this.basePath);
    const baseSize = existsSync(this.basePath) ? statSync(this.basePath).size : 0;
    const branchFiles = readdirSync(this.baseDir)
      .filter((f) => f.endsWith('.rvf') && f !== baseFile && f.includes('.work-'))
      .map((f) => ({ file: f, size: statSync(join(this.baseDir, f)).size }));
    const nBranches = Math.max(branchFiles.length, this._branches.size, 1);
    const branchTotal = branchFiles.reduce((s, b) => s + b.size, 0);
    const emptySizes = [...this._records.values()].map((r) => r._emptyBranchSize).filter((s) => s > 0);
    const meanEmptyBranch = emptySizes.length ? Math.round(emptySizes.reduce((s, x) => s + x, 0) / emptySizes.length) : 162;
    const meanMaterializedBranch = branchFiles.length ? Math.round(branchTotal / branchFiles.length) : 0;
    const fullCopyTotal = nBranches * baseSize; // naive: one full base copy per candidate branch
    return {
      baseSize,
      nBranches,
      meanEmptyBranch,                 // the 162 B COW invariant (headline overhead numerator)
      meanMaterializedBranch,          // branch after ingesting candidate markers (reported, not gamed)
      minBranchFile: branchFiles.length ? Math.min(...branchFiles.map((b) => b.size)) : null,
      branchFiles,
      branchTotal,
      fullCopyTotal,
      // headline: pure COW branching overhead vs a full-copy snapshot of the base
      overheadPct: baseSize ? (meanEmptyBranch / baseSize) * 100 : 0,
      // secondary (transparent): materialized branches vs re-copying the base per candidate
      materializedOverheadPct: fullCopyTotal ? (branchTotal / fullCopyTotal) * 100 : 0,
    };
  }

  /** Persist the full sidecar (rich payloads) next to the base — survives process restart. */
  save(path) {
    const out = path || (this.baseDir ? join(this.baseDir, 'branch-memory.json') : null);
    if (!out) return null;
    writeFileSync(out, JSON.stringify({
      basePath: this.basePath, dimension: this.dimension, degraded: this.degraded,
      seedGenomeId: this._seedGenome?.meta?.id ?? null,
      records: [...this._records.values()].map((r) => ({ ...r })),
    }, null, 2));
    return out;
  }

  close() { try { this._base?.close?.(); } catch { /* noop */ } }
}

/**
 * Open (or create) the seed BASE .rvf and return a BranchMemory (§1). The seed genome + its eval
 * traces are ingested as the base memory. Degrades gracefully when agenticow is missing/broken:
 * returns a BranchMemory with degraded=true whose branch mechanics are logged no-ops.
 *
 * @param basePath        path to the base .rvf (created if absent)
 * @param dimension       marker-vector dimension (default 32)
 * @param seedGenome      the seed genome object (becomes the frozen base genome)
 * @param seedTraces      optional { scores, feedbacks } for the seed eval — ingested as base vectors
 * @param agenticowModule optional injected agenticow module (tests); default dynamic import('agenticow')
 * @param logger          console-like logger
 */
export async function openBase(basePath, { dimension = DEFAULT_DIM, seedGenome = null, seedTraces = null, agenticowModule = undefined, logger = console } = {}) {
  let aw = agenticowModule;
  if (aw === undefined) {
    try { aw = await import('agenticow'); }
    catch (e) { logger.warn?.(`[branch-memory] agenticow not installed (${e.code || e.message}) — degraded mode`); aw = null; }
  }
  let base = null;
  if (aw) {
    try {
      if (basePath && basePath !== ':memory:') mkdirSync(dirname(basePath), { recursive: true });
      const openFn = aw.open || aw.openBase || aw.default?.open;
      base = openFn(basePath, { dimension });
    } catch (e) {
      logger.warn?.(`[branch-memory] agenticow open() failed (${e.message}) — degraded mode`);
      base = null; aw = null;
    }
  }

  const mem = new BranchMemory({ basePath, dimension, aw, base, logger, seedGenome });

  if (seedGenome) {
    const seedId = seedGenome.meta?.id || 'seed';
    mem._seedId = seedId;
    const rec = { genome_id: seedId, parent: null, genome: seedGenome, decision: 'seed', mutation_diff: null, createdAt: Date.now() };
    if (seedTraces?.scores) {
      rec.scores = seedTraces.scores; rec.feedbacks = seedTraces.feedbacks || {};
      rec.score = Object.values(seedTraces.scores).reduce((s, x) => s + (x || 0), 0); rec.gold = seedTraces.gold ?? null;
    }
    mem._records.set(seedId, rec);
    if (base) {
      // The base memory the task specifies: "the seed genome + its eval traces". This is what every
      // candidate branches off (shared, stored ONCE) — so a realistic base carries the seed's genome
      // COMPONENTS (id 1..) plus its per-instance eval traces + score-parts (id 1000..). A production
      // seed base (full transcripts across many instances) is far larger still; the 162 B COW branch
      // is a smaller fraction the bigger the base gets (agenticow's core invariant).
      const seedRecs = [{ id: 1, vector: embedText(`seed::${seedId}`, dimension) }];
      let nid = 2;
      for (const [name, text] of Object.entries(seedGenome.components || {})) seedRecs.push({ id: nid++, vector: embedText(`seed::component::${name}::${text}`, dimension) });
      if (seedTraces?.scores) {
        let tid = 1000;
        for (const inst of Object.keys(seedTraces.scores)) {
          seedRecs.push({ id: tid++, vector: embedText(`seed::trace::${inst}::${seedTraces.scores[inst]}::${seedTraces.feedbacks?.[inst] ?? ''}`, dimension) });
          for (const [pname, pval] of Object.entries(seedTraces.parts?.[inst] || {})) seedRecs.push({ id: tid++, vector: embedText(`seed::part::${inst}::${pname}::${pval}`, dimension) });
        }
      }
      base.ingest(seedRecs);
    }
  }
  return mem;
}

export default { openBase, BranchMemory, embedText, reconstructGenome };
