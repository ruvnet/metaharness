import type { ContrastiveResult, ExperienceLibrary } from './types.js';
export interface ExperienceContext {
    tenantId: string;
    projectId: string;
    /** Pin executor model, host and task schema here. This is a caller-owned key. */
    environmentKey: string;
}
export interface RememberInput extends ExperienceContext {
    sourceTaskId: string;
    cue: string;
    lesson: string;
    result: ContrastiveResult;
}
/** Build a portable experiment record. This never persists or promotes production state.
 * Result/receipt objects are trusted caller data, not cryptographic attestations.
 * Score values are deliberately omitted from the library visible to editors.
 */
export declare function rememberContrastiveExperience(library: ExperienceLibrary, input: RememberInput): ExperienceLibrary;
/** Conservative lexical retrieval, not an embedding model or proof of transfer.
 * A deployment may replace ranking with RuVector after this scope filter.
 */
export declare function retrieveContrastiveExperiences(library: ExperienceLibrary, input: ExperienceContext & {
    query: string;
    limit?: number;
}): ExperienceLibrary;
//# sourceMappingURL=memory.d.ts.map