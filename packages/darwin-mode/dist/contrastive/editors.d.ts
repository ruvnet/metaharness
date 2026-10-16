import type { ContrastiveOptions } from './types.js';
export interface EditorRequest {
    readonly role: 'invariant' | 'domain' | 'composer';
    readonly system: string;
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly ceilingUsd: number;
}
/** A real model/agent executor, not a Ruflo coordination-only task record. */
export type EditorExecutor = (request: EditorRequest) => Promise<{
    text: string;
    costUsd: number;
}>;
/** Connect a caller-owned Ruflo worker or model client without adding credentials,
 * provider SDKs, network permissions or automatic agent spawning to Darwin.
 * The executor must meter every attempt, honor cancellation, and enforce ceilingUsd.
 */
export declare function createContrastiveEditors(execute: EditorExecutor): Pick<ContrastiveOptions, 'proposer' | 'composer'>;
//# sourceMappingURL=editors.d.ts.map