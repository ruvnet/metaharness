import type { ContrastiveOptions, ContrastiveResult } from './types.js';
/**
 * One opt-in, development-only round. Adapters are trusted effect boundaries:
 * they must load the candidate, enforce ceilingUsd, and honor cancellation.
 * A digest echo is adapter attestation, not proof against a dishonest adapter.
 * No production promotion, code evaluation, network, or persistence occurs here.
 */
export declare function runContrastive(options: ContrastiveOptions): Promise<ContrastiveResult>;
//# sourceMappingURL=engine.d.ts.map