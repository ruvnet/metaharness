import type { ArchiveRecord, HarnessVariant, ScoreCard } from './types.js';
/**
 * In-memory tree of {@link ArchiveRecord}s keyed by variant id, persisted to a
 * JSON file. Insertion order is preserved (a `Map` iterates in insertion order)
 * so every ordering — `all`, tie-breaks in `best`, ties in `selectParents` — is
 * deterministic and reproducible from `archive.json` alone.
 */
export declare class Archive {
    private readonly file;
    /** variantId → record. A Map preserves insertion order. */
    private readonly records;
    /**
     * @param file Absolute path to `archive.json`. The file need not exist yet;
     *   {@link load} tolerates a missing or corrupt file by starting empty.
     */
    constructor(file: string);
    /**
     * Load records from {@link file} if it exists. A missing, unreadable, or
     * corrupt file (or one whose JSON is not an `ArchiveRecord[]`) is tolerated by
     * starting from an empty archive — never throws.
     */
    load(): Promise<void>;
    /**
     * Insert a record `{ variant, score: null, children: [] }` if the variant id
     * is absent (idempotent — a re-add is a no-op). When `variant.parentId` is set
     * and that parent already exists, append this id to the parent's `children`
     * (without duplicates), wiring up the tree edge.
     */
    addVariant(variant: HarnessVariant): void;
    /**
     * Attach a scorecard to a variant. Throws a clear error if the variant id is
     * unknown — scoring a phantom variant is a programmer error, not a soft miss.
     */
    setScore(variantId: string, score: ScoreCard): void;
    /** The record for `variantId`, or `undefined` if it is not in the archive. */
    get(variantId: string): ArchiveRecord | undefined;
    /** Every record, in insertion order. */
    all(): ArchiveRecord[];
    /**
     * The scored record with the highest `score.finalScore`, or `null` when no
     * record is scored yet. Ties break toward the earlier insertion (the first
     * record to reach that score wins), making the choice deterministic.
     */
    best(): ArchiveRecord | null;
    /**
     * The archive-wide selection that escapes hill-climbing: the top-`limit`
     * scored variants by `finalScore`, drawn from the WHOLE archive including
     * older, non-promoted branches (ADR-073 stall fallback). Deterministic — ties
     * break by insertion order, so the result is reproducible.
     *
     * @param limit Maximum number of parents to return. `<= 0` yields `[]`.
     */
    selectParents(limit: number): HarnessVariant[];
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
    selectElites(limit: number, descriptorOf?: (variant: HarnessVariant) => string): HarnessVariant[];
    /**
     * The path of ids from the root ancestor down to `variantId`, following
     * `parentId` upward then reversing. Returns `[]` if `variantId` is unknown.
     * Guarded against cycles (e.g. a self-parent or a corrupt ancestor loop): each
     * id is visited at most once, so the walk always terminates.
     */
    lineageOf(variantId: string): string[];
    /**
     * A serializable projection of the tree for rendering the evolution graph:
     * one node per record (carrying generation, mutated surface, final score, and
     * promotion flag), and one edge per existing parent→child relationship. Edges
     * referencing a missing endpoint are omitted so the graph stays well-formed.
     */
    toLineageGraph(): {
        nodes: Array<{
            id: string;
            parentId: string | null;
            generation: number;
            mutationSurface: string;
            finalScore: number | null;
            promoted: boolean | null;
        }>;
        edges: Array<{
            from: string;
            to: string;
        }>;
    };
    /**
     * Persist the archive as pretty-printed JSON to {@link file}, creating the
     * parent directory if needed. The on-disk shape is exactly `all()` — an
     * `ArchiveRecord[]` in insertion order — so a subsequent {@link load}
     * reconstructs the same archive.
     */
    save(): Promise<void>;
}
//# sourceMappingURL=archive.d.ts.map