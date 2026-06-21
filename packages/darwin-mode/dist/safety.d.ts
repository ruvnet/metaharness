import type { MutationSurface } from './types.js';
/** The seven approved mutation surfaces, in canonical order (ADR-071). */
export declare const SURFACES: readonly MutationSurface[];
/** Surface → the single file it owns. The ONLY files a variant may contain. */
export declare const FILE_BY_SURFACE: Readonly<Record<MutationSurface, string>>;
/** The exact set of filenames permitted inside a variant directory. */
export declare const APPROVED_FILES: ReadonlySet<string>;
/**
 * Blocked filename substrings (case-insensitive). A variant directory must never
 * contain a file whose name hints at secrets, VCS, or keys (ADR-071).
 */
export declare const BLOCKED_FILENAME_PATTERNS: readonly string[];
/**
 * Blocked code-content patterns (case-insensitive). If a variant file's text
 * matches any of these, the variant is disqualified. This is intentionally
 * broad: a harness mutation surface is pure policy logic — it has no business
 * spawning processes, touching the network, reading the environment, the file
 * system, or evaluating dynamic code.
 */
export declare const BLOCKED_CONTENT_PATTERNS: ReadonlyArray<{
    re: RegExp;
    reason: string;
}>;
/**
 * Statically inspect a variant directory BEFORE it is allowed to run.
 * Returns a list of blocking findings; an empty list means the variant is clean.
 *
 * Disqualifying conditions:
 *   - a nested directory, a symlink, or any non-regular-file entry;
 *   - a file that is not one of the seven approved filenames;
 *   - a filename matching a blocked pattern;
 *   - a file exceeding the size cap, or the directory exceeding the file cap;
 *   - file content matching a blocked-capability pattern.
 */
export declare function inspectVariant(dir: string): Promise<string[]>;
/**
 * Validate LLM/agent-generated code BEFORE it is written to a variant file.
 * Independent of inspectVariant (defense in depth). Returns a list of violations;
 * an empty list means the generated code is admissible. A generation that
 * violates this is DISCARDED, never repaired in place (ADR-071).
 */
export declare function validateGeneratedCode(code: string): string[];
/** Convenience: a variant is admissible iff inspectVariant finds nothing. */
export declare function isVariantSafe(dir: string): Promise<boolean>;
//# sourceMappingURL=safety.d.ts.map