import { type Genome } from './genome.js';
export * from './genome.js';
export * from './metric.js';
export * from './loop.js';
export * from './promotion.js';
/**
 * Absolute path to the shipped cand-6 genome — the first holdout-confirmed cheap-tier policy
 * promotion (edit-by-midpoint; holdout gold 2/12 → 3/12, zero regressions, empty-patch rate
 * 0.583 → 0.333). Provenance: genomes/PROVENANCE.md in this package.
 */
export declare const CAND6_GENOME_PATH: string;
/** Load + validate the shipped cand-6 promoted genome. */
export declare function loadCand6Genome(): Genome;
//# sourceMappingURL=index.d.ts.map