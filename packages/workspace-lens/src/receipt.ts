// SPDX-License-Identifier: MIT
//
// buildReceipt — the one-call orchestrator. Given a lens, a prompt, the captured hidden states, and a
// concept library, it reads the workspace at every state, scores drift/entropy, fires safety triggers,
// and assembles the signable WorkspaceLensReceipt. Pure aside from a sha256 of the prompt (node:crypto,
// a builtin) — no model, no network — so it runs identically offline and in a governance hot path.

import { createHash } from 'node:crypto';
import type { WorkspaceLens } from './lens.js';
import type {
  HiddenState, ConceptVector, WorkspaceLensReceipt, WorkspaceReadout,
} from './types.js';
import { detectConcepts, flagsFromTriggers, type DetectOptions } from './safety.js';
import { workspaceDrift, entropyTrajectory } from './drift.js';

export interface BuildReceiptOptions {
  /** Number of workspace tokens to keep per readout. Default 8. */
  topK?: number;
  /** Concept vectors to score for safety triggers. Default none. */
  concepts?: readonly ConceptVector[];
  /** Concept-trigger cosine threshold. */
  detect?: DetectOptions;
  /** ISO timestamp for the receipt. REQUIRED — pass it in so the receipt is deterministic/reproducible. */
  createdAt: string;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function buildReceipt(
  lens: WorkspaceLens,
  prompt: string,
  states: readonly HiddenState[],
  opts: BuildReceiptOptions,
): WorkspaceLensReceipt {
  const topK = opts.topK ?? 8;
  const readouts: WorkspaceReadout[] = states
    .filter((s) => lens.hasLayer(s.layer))
    .map((s) => lens.readout(s, topK));

  const triggers = opts.concepts ? detectConcepts(lens, states, opts.concepts, opts.detect) : [];
  const flags = flagsFromTriggers(triggers);
  const { drift } = workspaceDrift(readouts);

  const layersSeen = readouts.map((r) => r.layer);
  const layerRange: [number, number] = layersSeen.length
    ? [Math.min(...layersSeen), Math.max(...layersSeen)]
    : [0, 0];

  return {
    promptHash: sha256(prompt),
    modelId: lens.modelId,
    lensId: lens.lensId,
    layerRange,
    positions: [...new Set(readouts.map((r) => r.position))].sort((a, b) => a - b),
    topTokens: readouts.map((r) => ({
      layer: r.layer,
      position: r.position,
      tokens: r.tokens.map((t) => ({ token: t.token, rank: t.rank, logit: t.logit })),
    })),
    flags,
    triggers,
    workspaceDrift: drift,
    entropyTrajectory: entropyTrajectory(readouts),
    createdAt: opts.createdAt,
  };
}
