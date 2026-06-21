// SPDX-License-Identifier: MIT
//
// The archive (ADR-073) — Darwin Mode's population memory. The archive is a
// TREE of variants, persisted as `archive.json`, not a single best branch.
// Non-promoted variants are RETAINED, not deleted: "did not clear the promotion
// gate" means "not chosen as a parent by the default policy", never "removed".
// Selection (`selectParents`) samples the WHOLE archive — including older,
// non-promoted branches — which is how evolution escapes hill-climbing.
//
// Dependency-free (Node built-ins only). The on-disk shape is a stable
// `ArchiveRecord[]` so that load → save → load round-trips exactly.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/**
 * In-memory tree of {@link ArchiveRecord}s keyed by variant id, persisted to a
 * JSON file. Insertion order is preserved (a `Map` iterates in insertion order)
 * so every ordering — `all`, tie-breaks in `best`, ties in `selectParents` — is
 * deterministic and reproducible from `archive.json` alone.
 */
export class Archive {
    file;
    /** variantId → record. A Map preserves insertion order. */
    records = new Map();
    /**
     * @param file Absolute path to `archive.json`. The file need not exist yet;
     *   {@link load} tolerates a missing or corrupt file by starting empty.
     */
    constructor(file) {
        this.file = file;
    }
    /**
     * Load records from {@link file} if it exists. A missing, unreadable, or
     * corrupt file (or one whose JSON is not an `ArchiveRecord[]`) is tolerated by
     * starting from an empty archive — never throws.
     */
    async load() {
        this.records.clear();
        let raw;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch {
            return; // missing / unreadable — start empty
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return; // corrupt JSON — start empty
        }
        if (!Array.isArray(parsed))
            return; // wrong shape — start empty
        for (const entry of parsed) {
            if (!isArchiveRecord(entry))
                continue; // skip malformed entries defensively
            this.records.set(entry.variant.id, entry);
        }
    }
    /**
     * Insert a record `{ variant, score: null, children: [] }` if the variant id
     * is absent (idempotent — a re-add is a no-op). When `variant.parentId` is set
     * and that parent already exists, append this id to the parent's `children`
     * (without duplicates), wiring up the tree edge.
     */
    addVariant(variant) {
        if (this.records.has(variant.id))
            return; // idempotent
        this.records.set(variant.id, { variant, score: null, children: [] });
        const parentId = variant.parentId;
        if (parentId !== null) {
            const parent = this.records.get(parentId);
            if (parent && !parent.children.includes(variant.id)) {
                parent.children.push(variant.id);
            }
        }
    }
    /**
     * Attach a scorecard to a variant. Throws a clear error if the variant id is
     * unknown — scoring a phantom variant is a programmer error, not a soft miss.
     */
    setScore(variantId, score) {
        const record = this.records.get(variantId);
        if (!record) {
            throw new Error(`Archive.setScore: unknown variant "${variantId}" (add it before scoring)`);
        }
        record.score = score;
    }
    /** The record for `variantId`, or `undefined` if it is not in the archive. */
    get(variantId) {
        return this.records.get(variantId);
    }
    /** Every record, in insertion order. */
    all() {
        return [...this.records.values()];
    }
    /**
     * The scored record with the highest `score.finalScore`, or `null` when no
     * record is scored yet. Ties break toward the earlier insertion (the first
     * record to reach that score wins), making the choice deterministic.
     */
    best() {
        let winner = null;
        for (const record of this.records.values()) {
            if (record.score === null)
                continue;
            if (winner === null || record.score.finalScore > winner.score.finalScore) {
                winner = record;
            }
        }
        return winner;
    }
    /**
     * The archive-wide selection that escapes hill-climbing: the top-`limit`
     * scored variants by `finalScore`, drawn from the WHOLE archive including
     * older, non-promoted branches (ADR-073 stall fallback). Deterministic — ties
     * break by insertion order, so the result is reproducible.
     *
     * @param limit Maximum number of parents to return. `<= 0` yields `[]`.
     */
    selectParents(limit) {
        if (limit <= 0)
            return [];
        // Tag with insertion index so ties break deterministically by insertion order.
        const scored = [];
        let index = 0;
        for (const record of this.records.values()) {
            if (record.score !== null)
                scored.push({ record, index });
            index += 1;
        }
        scored.sort((a, b) => {
            const delta = b.record.score.finalScore - a.record.score.finalScore;
            if (delta !== 0)
                return delta; // higher finalScore first
            return a.index - b.index; // tie-break: earlier insertion first
        });
        return scored.slice(0, limit).map((s) => s.record.variant);
    }
    /**
     * MAP-Elites elite selection (quality-diversity). Bin the scored records by a
     * behaviour descriptor (default: the mutated surface), keep the BEST record per
     * bin (highest finalScore, ties by earliest insertion), and return up to
     * `limit` bin-champions ordered by finalScore. Where `selectParents` can return
     * `limit` near-identical variants (all the same surface — common at the ADR-072
     * 0.985 ceiling), this returns champions from DISTINCT niches, so the next
     * generation explores diverse surfaces instead of collapsing onto one.
     *
     * Pure and deterministic (no wall-clock) → reproducible from `archive.json`.
     *
     * @param limit Maximum number of elites to return. `<= 0` yields `[]`.
     * @param descriptorOf Behaviour-descriptor function; defaults to mutated surface.
     */
    selectElites(limit, descriptorOf = (v) => v.mutationSurface) {
        if (limit <= 0)
            return [];
        // descriptor → champion, tracking insertion index for deterministic ties.
        const champions = new Map();
        let index = 0;
        for (const record of this.records.values()) {
            const i = index++;
            if (record.score === null)
                continue;
            const key = descriptorOf(record.variant);
            const current = champions.get(key);
            if (current === undefined ||
                record.score.finalScore > current.record.score.finalScore) {
                champions.set(key, { record, index: i });
            }
        }
        return [...champions.values()]
            .sort((a, b) => {
            const delta = b.record.score.finalScore - a.record.score.finalScore;
            if (delta !== 0)
                return delta; // higher finalScore first
            return a.index - b.index; // tie-break: earlier insertion first
        })
            .slice(0, limit)
            .map((c) => c.record.variant);
    }
    /**
     * The path of ids from the root ancestor down to `variantId`, following
     * `parentId` upward then reversing. Returns `[]` if `variantId` is unknown.
     * Guarded against cycles (e.g. a self-parent or a corrupt ancestor loop): each
     * id is visited at most once, so the walk always terminates.
     */
    lineageOf(variantId) {
        if (!this.records.has(variantId))
            return [];
        const path = [];
        const seen = new Set();
        let currentId = variantId;
        while (currentId !== null && !seen.has(currentId)) {
            const record = this.records.get(currentId);
            if (!record)
                break; // dangling parent reference — stop the climb
            seen.add(currentId);
            path.push(currentId);
            currentId = record.variant.parentId;
        }
        return path.reverse(); // root ancestor first, target last
    }
    /**
     * A serializable projection of the tree for rendering the evolution graph:
     * one node per record (carrying generation, mutated surface, final score, and
     * promotion flag), and one edge per existing parent→child relationship. Edges
     * referencing a missing endpoint are omitted so the graph stays well-formed.
     */
    toLineageGraph() {
        const nodes = [];
        const edges = [];
        for (const record of this.records.values()) {
            const { variant, score } = record;
            nodes.push({
                id: variant.id,
                parentId: variant.parentId,
                generation: variant.generation,
                mutationSurface: variant.mutationSurface,
                finalScore: score === null ? null : score.finalScore,
                promoted: score === null ? null : score.promoted,
            });
            for (const childId of record.children) {
                if (this.records.has(childId)) {
                    edges.push({ from: variant.id, to: childId });
                }
            }
        }
        return { nodes, edges };
    }
    /**
     * Persist the archive as pretty-printed JSON to {@link file}, creating the
     * parent directory if needed. The on-disk shape is exactly `all()` — an
     * `ArchiveRecord[]` in insertion order — so a subsequent {@link load}
     * reconstructs the same archive.
     */
    async save() {
        await mkdir(dirname(this.file), { recursive: true });
        const json = JSON.stringify(this.all(), null, 2);
        await writeFile(this.file, `${json}\n`, 'utf8');
    }
}
/**
 * Structural guard for a single on-disk record. Defensive against hand-edited or
 * partially-written `archive.json` files: only entries with the minimal shape
 * (a variant with an id, plus a `children` array) are admitted.
 */
function isArchiveRecord(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const obj = value;
    const variant = obj.variant;
    if (variant === null || typeof variant !== 'object')
        return false;
    if (typeof variant.id !== 'string')
        return false;
    if (!Array.isArray(obj.children))
        return false;
    // score may be null or a ScoreCard object; both are acceptable here.
    return true;
}
//# sourceMappingURL=archive.js.map