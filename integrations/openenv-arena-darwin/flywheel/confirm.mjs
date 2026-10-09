// Preregistered paired confirmation (pure). The plan fixes, BEFORE any rollout, which two genomes are
// compared, on which fresh seed block, with how many attempts, under which runner/env/model provenance and
// image digest; its sha256 is journaled first. Both genomes are then scored on the identical seeds.
//
// Paired outcomes and the power ceiling are the Darwin lane's own (lib/confirm.mjs), because gate.mjs v2
// re-derives the pairs from the two scorecards and refuses a --paired file that differs (paired_evidence_mismatch):
//   item = (changed cell, 4-seed block); won = the block is all lib/fitness.mjs ELIGIBLE and rewards not all equal.
// Only cells whose cache key differs are paired; identical cells are the same measurement.
import { canonicalDigest, canonicalJson } from './canonical-json.mjs';
import { confirmationPower, pairedOutcomes as darwinPairedOutcomes } from '../lib/confirm.mjs';

export const PAIRED_ITEM_RULE = 'lib/confirm.mjs pairedOutcomes: changed cells only, one item per 4-seed block; won = all 4 ELIGIBLE && rewards not all equal';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const fail = msg => { throw new Error(msg); };

/** Whole days since 2026-01-01 for a strict YYYY-MM-DD calendar date. Pure (Date.UTC, no clock). */
export function dayIndex(date) {
  const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
  if (!m) fail(`invalid_date:${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) fail(`invalid_date:${date}`);
  const idx = (ms - EPOCH_MS) / 86_400_000;
  if (!Number.isSafeInteger(idx) || idx < 0) fail(`date_before_2026-01-01:${date}`);
  return idx;
}

/** Fresh, date-determined seed block: disjoint across dates (stride >= attempts) and from the search block. */
export function confirmSeedBase(date, { seedBase0, stride, attempts }) {
  if (!Number.isSafeInteger(stride) || !Number.isSafeInteger(attempts) || stride < attempts) fail('confirmation_stride_lt_attempts');
  return seedBase0 + dayIndex(date) * stride;
}

/**
 * Can gate.mjs v2 promote at all? It refuses (confirmation_underpowered) unless there are >= blocksNeeded paired
 * blocks at alpha/candidateBudget, and the e-value needs that many favourable discordant ones. Darwin's formula.
 */
export function pairedPower({ changedFamilies, attempts, alpha, lambda, candidateBudget }) {
  const p = confirmationPower({ changedCells: changedFamilies, attempts, alpha, lambda, candidateBudget });
  return { needed: p.blocksNeeded, maxDiscordant: p.maxPairs, reachable: p.reachable, candidateBudget,
    attemptsPerChangedCellNeeded: Number.isFinite(p.attemptsPerChangedCellNeeded) ? p.attemptsPerChangedCellNeeded : null };
}

/** PairedOutcome[] exactly as gate.mjs v2 derives them (lib/confirm.mjs). Throws when the cards cannot be paired. */
export const pairedOutcomes = (incumbentCard, candidateCard) => darwinPairedOutcomes(incumbentCard, candidateCard);

const cellSig = c => canonicalJson({ family: c.family, difficulty: c.difficulty, budget: c.budget, knobs: c.knobs ?? {} });

/** Families whose cell differs between two genomes (via the cells contract's genomeToCells). */
export function changedFamilies(genomeToCells, a, b) {
  const A = new Map(genomeToCells(a).map(c => [c.family, cellSig(c)]));
  return genomeToCells(b).filter(c => A.get(c.family) !== cellSig(c)).map(c => c.family);
}

/** The plan object whose canonical sha256 is preregistered. Floats are carried as strings (integer-only canon). */
export function confirmationPlan({ date, incumbent, candidate, seedBase, attempts, expectedProvenance, image, gate, changed }) {
  const plan = {
    kind: 'arena_flywheel_confirmation_plan', version: 1, date,
    incumbent: { genome: incumbent.genome, genomeDigest: canonicalDigest(incumbent.genome) },
    candidate: { variantId: candidate.variantId, genome: candidate.genome, genomeDigest: canonicalDigest(candidate.genome) },
    seedBase, attempts, seedRange: [seedBase, seedBase + attempts - 1],
    expectedProvenance, image, pairedItemRule: PAIRED_ITEM_RULE, changedFamilies: changed,
    gate: { alpha: String(gate.alpha), lambda: String(gate.lambda), candidateBudget: gate.candidateBudget },
  };
  if (expectedProvenance?.seedBase !== seedBase || expectedProvenance?.attempts !== attempts) fail('plan_provenance_seed_mismatch');
  return { plan, planHash: canonicalDigest(plan) };
}

export const planHashOf = plan => canonicalDigest(plan);

/** Journal order proves preregistration: `registered` (this hash) precedes the last confirmation `start`, and the
 *  plan file on disk still hashes to it. `entries` = this date's journal rows; pure. */
export function preregistered(entries, planHash, planOnDisk) {
  const regIdx = entries.findLastIndex(e => e.phase === 'confirm-plan' && e.event === 'registered');
  const startIdx = entries.findLastIndex(e => e.phase === 'confirm' && e.event === 'start');
  if (regIdx < 0 || startIdx <= regIdx || entries[regIdx].planHash !== planHash || planOnDisk == null) return false;
  try { return planHashOf(planOnDisk) === planHash; } catch { return false; }
}

/** Exact provenance equality (integer/string domain; anything else is a mismatch). */
export function provenanceMatches(card, expected) {
  try { return canonicalJson(card?.raw?.provenance ?? null) === canonicalJson(expected ?? null) && expected != null; } catch { return false; }
}

/** The card's measured cells are exactly genomeToCells(genome), in order. */
export function cardMatchesGenome(card, genomeToCells, genome) {
  try {
    const want = genomeToCells(genome).map(cellSig);
    const got = (card?.raw?.cells ?? []).map(cellSig);
    return want.length > 0 && want.length === got.length && want.every((s, i) => s === got[i]);
  } catch { return false; }
}
