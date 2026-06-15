// SPDX-License-Identifier: MIT
//
// DRACO optimization arm 2 (ADR-038) — best-of-N self-consistency SELECTION.
//
// Both prior arms LOST to vanilla because they TRANSFORM the dossier (rebuild
// or prune) and the scorer re-fetches real URLs — any transform sheds grounding.
// Learning: SELECT or UNION, never rewrite.
//
// This arm generates N INTACT candidate dossiers, each emphasizing a different
// DRACO dimension (grounding / coverage / balance), then uses the independent
// JUDGE to pick the best overall. No candidate is ever rewritten, so grounding
// cannot be lost — best-of-N can only match or exceed the single draw in
// expectation (a strictly better selector than taking the first). This is the
// ruflo RETRIEVE→JUDGE pattern: generate a candidate set, JUDGE-select.
//
// The selection signal is the INDEPENDENT judge's holistic quality rating — NOT
// the DRACO scorer (using the scorer to select would be training-on-the-test).
// Dependency-injected transports → offline-testable.

import type { OpenRouterTransport, ChatMessage } from './fusion.js';
import { SINGLE_MODEL_PROMPT } from './optimized.js';

/**
 * Diverse-angle candidate prompts. Each is the strong direct-dossier prompt with
 * one DRACO dimension emphasised, so the N candidates genuinely differ (opus at
 * default temperature is near-deterministic — prompt diversity is what creates a
 * real candidate set to select from). Index 0 is the neutral baseline.
 */
export const CANDIDATE_ANGLES: string[] = [
  '', // neutral — identical to vanilla
  ' Prioritise PRIMARY sources and give a real, specific source URL for every load-bearing claim.',
  ' Maximise COVERAGE: address every facet of the question, including secondary and recent developments.',
  ' Show BALANCE: present the consensus AND the strongest dissenting positions side by side, not averaged.',
];

const JUDGE_SELECT_PROMPT =
  'You are an impartial research-quality judge. Rate the dossier below from 0.0 ' +
  'to 1.0 on overall quality: grounding (real, checkable source URLs), coverage ' +
  '(addresses the whole question), balance (multiple positions), and faithfulness ' +
  '(claims supported by their citations). Reply with ONLY the number.';

export interface SelfConsistencyResult {
  questionId: string;
  answer: string;
  totalTokens: number;
  selectedIndex: number;
  /** Judge quality rating per candidate (same order as CANDIDATE_ANGLES). */
  scores: number[];
}

/** Parse a 0–1 quality rating from the judge text; fails closed to 0. */
export function parseQuality(text: string): number {
  const m = text.match(/(?:^|[^0-9.])(0?\.\d+|1(?:\.0+)?|0)(?![0-9])/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/**
 * Best-of-N self-consistency selection. Generates `candidates` intact dossiers
 * (diverse angles), judge-rates each, returns the highest. Never transforms a
 * candidate. Pure w.r.t. the injected transports.
 */
export async function selfConsistentResearch(
  question: { id: string; prompt: string },
  opts: {
    baseModel: string;
    judgeModel: string;
    transport: OpenRouterTransport;
    judgeTransport: OpenRouterTransport;
    /** How many candidates (1..CANDIDATE_ANGLES.length). Default 3. */
    candidates?: number;
  },
): Promise<SelfConsistencyResult> {
  const n = Math.min(Math.max(1, opts.candidates ?? 3), CANDIDATE_ANGLES.length);
  let totalTokens = 0;

  // 1. Generate N intact candidate dossiers (diverse angles).
  const dossiers = await Promise.all(
    CANDIDATE_ANGLES.slice(0, n).map(async (angle) => {
      const messages: ChatMessage[] = [
        { role: 'system', content: SINGLE_MODEL_PROMPT + angle },
        { role: 'user', content: question.prompt },
      ];
      return opts.transport(opts.baseModel, messages);
    }),
  );
  for (const d of dossiers) totalTokens += d.tokens;

  // 2. Judge-rate each candidate (independent holistic quality, NOT the scorer).
  const ratings = await Promise.all(
    dossiers.map(async (d) => {
      const r = await opts.judgeTransport(opts.judgeModel, [
        { role: 'system', content: JUDGE_SELECT_PROMPT },
        { role: 'user', content: d.text },
      ]);
      totalTokens += r.tokens;
      return parseQuality(r.text);
    }),
  );

  // 3. Select the highest-rated candidate (ties → earliest, i.e. prefer neutral).
  let best = 0;
  for (let i = 1; i < ratings.length; i++) if (ratings[i] > ratings[best]) best = i;

  return {
    questionId: question.id,
    answer: dossiers[best].text,
    totalTokens,
    selectedIndex: best,
    scores: ratings,
  };
}
