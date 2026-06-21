import type { HarnessVariant, RepoProfile } from './types.js';
/**
 * Generate the baseline harness variant from a repo profile. Writes the seven
 * mutation-surface files (filenames per FILE_BY_SURFACE) into
 * `<workRoot>/variants/baseline/`, creating directories as needed, and returns
 * the variant descriptor. Generation 0, no parent.
 */
export declare function generateBaselineHarness(profile: RepoProfile, workRoot: string): Promise<HarnessVariant>;
//# sourceMappingURL=generator.d.ts.map