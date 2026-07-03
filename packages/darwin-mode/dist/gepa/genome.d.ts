/** Lineage/provenance metadata carried by a genome. */
export interface GenomeMeta {
    id?: string;
    parent?: string | null;
    source?: string;
    notes?: string;
    /** The component name changed by the mutation that produced this genome. */
    mutated?: string;
}
/** A GEPA candidate: named TEXT components (dict[str,str]) + lineage metadata. */
export interface Genome {
    version?: number;
    meta?: GenomeMeta;
    components: Record<string, string>;
}
/** Substitute the polyglot placeholders. */
export declare function renderComponent(text: string, ext?: string, glob?: string): string;
/** Tool rendering order — structure, not genome (a mutation cannot reorder or add tools in run 1). */
export declare const TOOL_ORDER: readonly ["ls", "read", "grep", "edit", "line_edit", "run_tests", "submit"];
/**
 * The SEED genome — extracted verbatim (placeholders aside) from the bench prompt builders
 * (buildAgenticSystem / buildAdvisedSystem / buildAdvisorSystem). DO NOT edit these strings by
 * hand: the byte-equivalence test will fail if they drift from agentic-loop.mjs / advisor-loop.mjs.
 */
export declare const SEED_GENOME: Genome;
/** Validate a genome object. Returns a list of problems ([] = valid). */
export declare function validateGenome(genome: unknown): string[];
/**
 * Reassemble the executor SYSTEM PROMPT from a genome. `advised: true` renders the advisor-mode
 * prompt (advise tool line inserted before submit + escalation framing appended) — byte-identical
 * to buildAdvisedSystem for the seed; default renders the solo/D0 prompt — byte-identical to
 * buildAgenticSystem for the seed. Pure; never mutates the genome (verified-contract rule 3).
 */
export declare function buildSystemFromGenome(genome: Genome, ext?: string, glob?: string, { advised }?: {
    advised?: boolean;
}): string;
/** Render the advisor/verifier system prompt from the genome (advisor-arm genomes only). */
export declare function buildAdvisorSystemFromGenome(genome: Genome, ext?: string): string;
/** Deep-clone a genome and apply a single-component text mutation (fresh object, never in-place). */
export declare function mutateComponent(genome: Genome, componentName: string, newText: string, { id, notes }?: {
    id?: string;
    notes?: string;
}): Genome;
/** Load + validate a genome JSON file (readFileSync injected — keeps this module dependency-free). */
export declare function loadGenome(readFileSync: (path: string, encoding: 'utf8') => string, path: string): Genome;
//# sourceMappingURL=genome.d.ts.map