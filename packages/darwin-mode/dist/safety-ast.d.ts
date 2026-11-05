/** Ambient identifiers a surface file may never reference or bind. */
export declare const BANNED_IDENTIFIERS: ReadonlySet<string>;
/** Member names that lead to constructors, prototypes, or runtime internals. */
export declare const BANNED_MEMBERS: ReadonlySet<string>;
/**
 * Analyse one surface file's source. Returns the list of reasons it is rejected;
 * an empty list means the AST layer admits it.
 */
export declare function analyzeSurfaceSource(code: string): string[];
//# sourceMappingURL=safety-ast.d.ts.map