// SPDX-License-Identifier: MIT
//
// DRACO grounding gate — the ruflo intelligence-pipeline JUDGE→CONSOLIDATE stage
// applied to citations (ADR-038 follow-up).
//
// The mechanistic finding (ADR-038): the harness arm loses on `grounding`
// (= live cited URLs / total cited URLs) because it surfaces MANY sources, many
// dead, collapsing the fraction. The honest question this module answers: can a
// citation-level JUDGE step recover grounding WITHOUT gaming the metric?
//
// The non-negotiable honesty invariant (why augment's blunt prune is wrong):
// you may NEVER strip a dead citation while keeping the claim it supported — that
// hides an unsupported claim to pump grounding. So the gate works per claim
// (sentence):
//   • a dead URL that SHARES its sentence with a live URL → drop the dead token
//     only; the claim is still supported by the live citation (pure grounding win,
//     coverage untouched);
//   • a sentence whose ONLY citations are dead → the claim is no longer supported,
//     so the WHOLE sentence is dropped (honest — and it pays a real coverage cost
//     if that sentence carried a rubric term);
//   • a sentence with no URLs is prose, not a citation → kept verbatim.
//
// This makes the coverage↔grounding trade-off explicit and measurable OFFLINE
// (the URL checker is injected, exactly like the scorer), so it needs no API run:
// the gate is a pure function of (answer, liveness). It predicts precisely when
// the harness can honestly out-score vanilla — when its dead citations are
// REDUNDANT (co-located with live ones) rather than the sole support for covered
// claims.

import { extractUrls, scoreAnswer, type Rubric, type DimensionScores, type UrlChecker } from './scorer.js';

export interface GroundingGateReport {
  /** Dead URL tokens removed from sentences that still had a live citation. */
  deadUrlsStripped: number;
  /** Sentences removed because their ONLY citation(s) were dead (claim unsupported). */
  claimsDropped: number;
  /** Live cited URLs retained. */
  liveUrlsKept: number;
  /** Dead URLs total seen. */
  deadUrlsSeen: number;
  gatedAnswer: string;
}

/** Split text into sentence/claim units, preserving the splitter is unnecessary
 *  for re-scoring (the scorer is whitespace-insensitive for terms + URLs). */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply the grounding gate to an answer. Deterministic + offline — `checkUrl` is
 * injected (a mock in tests, the live checker in judged runs). Pure: no I/O beyond
 * the injected checker, no mutation of inputs.
 */
export async function applyGroundingGate(answer: string, checkUrl: UrlChecker): Promise<GroundingGateReport> {
  const allUrls = extractUrls(answer);
  // One liveness lookup per unique URL.
  const liveness = new Map<string, 'ok' | 'dead' | 'mismatch'>();
  await Promise.all(
    allUrls.map(async (u) => {
      liveness.set(u, await checkUrl(u));
    }),
  );
  const isLive = (u: string) => liveness.get(u) === 'ok';

  let deadUrlsStripped = 0;
  let claimsDropped = 0;
  let liveUrlsKept = 0;
  let deadUrlsSeen = 0;

  const keptSentences: string[] = [];
  for (const sentence of splitSentences(answer)) {
    const urls = extractUrls(sentence);
    if (urls.length === 0) {
      keptSentences.push(sentence); // prose, not a citation
      continue;
    }
    const live = urls.filter(isLive);
    const dead = urls.filter((u) => !isLive(u));
    deadUrlsSeen += dead.length;

    if (live.length === 0) {
      // Claim's only support is dead → drop the whole claim (NEVER keep an
      // unsupported claim just to remove the dead link — that would be gaming).
      claimsDropped += 1;
      continue;
    }
    // Claim still supported by a live citation → strip just the dead tokens.
    let gated = sentence;
    for (const d of dead) {
      gated = gated.split(d).join('').replace(/\(\s*\)/g, '').replace(/\[\s*\]/g, '');
      deadUrlsStripped += 1;
    }
    // tidy doubled spaces / dangling separators left by token removal
    gated = gated.replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
    liveUrlsKept += live.length;
    keptSentences.push(gated);
  }

  return {
    deadUrlsStripped,
    claimsDropped,
    liveUrlsKept,
    deadUrlsSeen,
    gatedAnswer: keptSentences.join(' '),
  };
}

export interface GatedScore {
  before: DimensionScores;
  after: DimensionScores;
  report: GroundingGateReport;
  /** after.mean − before.mean (the honest composite delta on the M3 scorer). */
  delta: number;
}

/**
 * Score an answer before and after the gate under the M3 deterministic scorer.
 * The delta is the HONEST composite change: grounding rises (dead citations gone),
 * coverage may fall (only if a dropped dead-only claim carried a rubric term).
 */
export async function scoreWithGate(
  answer: string,
  rubric: Rubric,
  prompt: string,
  checkUrl: UrlChecker,
): Promise<GatedScore> {
  const before = await scoreAnswer(answer, rubric, prompt, checkUrl);
  const report = await applyGroundingGate(answer, checkUrl);
  const after = await scoreAnswer(report.gatedAnswer, rubric, prompt, checkUrl);
  return { before, after, report, delta: after.mean - before.mean };
}

/**
 * The break-even predictor (the point of this module). For a harness-style answer
 * with `totalCited` URLs of which `live` resolve, gating raises grounding from
 * live/totalCited toward 1 (over the retained citations). The composite improves
 * iff the grounding gain outweighs the coverage lost to dropped dead-only claims:
 *
 *   Δmean = (Δgrounding − Δcoverage) / 4              (balance, cleanliness ~unchanged)
 *
 * This returns Δgrounding given the citation counts, so callers can compare it to
 * the measured coverage cost. Honest, closed-form, no run required.
 */
export function groundingGain(liveCited: number, deadStrippedRedundant: number, deadOnlyClaims: number): number {
  const totalBefore = liveCited + deadStrippedRedundant + deadOnlyClaims;
  if (totalBefore === 0) return 0;
  const groundingBefore = liveCited / totalBefore;
  // After: dead-redundant tokens stripped, dead-only claims (and their URLs) gone.
  const totalAfter = liveCited;
  const groundingAfter = totalAfter > 0 ? 1 : 0; // all remaining cited URLs are live
  return groundingAfter - groundingBefore;
}
