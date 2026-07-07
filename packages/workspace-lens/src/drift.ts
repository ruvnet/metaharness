// SPDX-License-Identifier: MIT
//
// Workspace stability metrics. workspaceDrift measures how much the readout DISTRIBUTION moves between
// consecutive readouts (layers/positions): the Jensen–Shannon divergence between adjacent softmax
// distributions, averaged. A radical jump without an output-token boundary signals the internal
// reasoning path collapsing or mutating uncontrollably. entropyTrajectory tracks whether the workspace
// is converging (entropy falling → committing to a concept) or dissolving (rising → losing its grip).

import type { WorkspaceReadout } from './types.js';
import { jensenShannon, softmax } from './linalg.js';

/** Reconstruct the readout's probability distribution over its returned tokens (for step-to-step JS). */
function readoutProbs(r: WorkspaceReadout): number[] {
  // Use the token logits we kept; re-softmax over the returned top-k so two readouts are compared on the
  // same support ordering. Callers that need full-vocab drift should pass full-vocab readouts (topK=vocab).
  return softmax(r.tokens.map((t) => t.logit));
}

/**
 * Mean Jensen–Shannon divergence (nats) between consecutive readouts in order. 0 when fewer than two
 * readouts. Only compares readouts whose token support has the same length (same topK) so the JS is
 * well-defined; mismatched pairs are skipped and reported via `comparedPairs`.
 */
export function workspaceDrift(readouts: readonly WorkspaceReadout[]): { drift: number; comparedPairs: number } {
  let sum = 0;
  let pairs = 0;
  for (let i = 1; i < readouts.length; i++) {
    const a = readoutProbs(readouts[i - 1]);
    const b = readoutProbs(readouts[i]);
    if (a.length !== b.length || a.length === 0) continue;
    sum += jensenShannon(a, b);
    pairs += 1;
  }
  return { drift: pairs === 0 ? 0 : sum / pairs, comparedPairs: pairs };
}

/** The per-readout entropy sequence, in the readouts' given order. */
export function entropyTrajectory(readouts: readonly WorkspaceReadout[]): number[] {
  return readouts.map((r) => r.entropy);
}
