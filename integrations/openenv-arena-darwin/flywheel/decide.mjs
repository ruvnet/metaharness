// Pure submit decision for the daily OpenEnv Arena flywheel. No I/O, no clock, no LLM.
//
// decideSubmit(flags) -> {submit, reasons}. `flags` is a flat object of named conditions; EVERY key in
// DECISION_KEYS must be exactly `true` (not truthy) or the run does not submit. Unknown keys also block,
// so a caller cannot smuggle in a flag the policy does not know. reasons lists every failing key, in
// DECISION_KEYS order. buildDecisionFlags(facts) derives the flags from raw run facts (also pure); the facts
// themselves are re-derived from the files on disk at decision time (recheck.mjs), never resumed booleans.
//
// Policy (owner rUv): auto-submit only when (1) the Flywheel gate promotes the candidate and its signed
// receipt verifies against the pinned key; (2) every pre-submit check passed on THIS request and image and
// the request digest is the one bound into the gate receipt; (3) the 24 h slot is free; (4) mode = auto.
import { SHA256_RE } from './canonical-json.mjs';

export const DECISION_KEYS = Object.freeze([
  // (4) mode
  'modeAuto',
  // evidence provenance (the incumbent itself: local state and the public leaderboard agree on day 1 vs. not)
  'leaderboardAgreesWithIncumbent', 'darwinEvidenceIsScorecards', 'candidatePresent', 'candidateDiffersFromIncumbent',
  'candidateMatchesPlan', 'confirmationPreregistered', 'confirmationProvenanceMatchesPlan', 'confirmationNotDryRun',
  'confirmationCardsMatchGenomes', 'pairedEvidenceUsed',
  // (1) gate
  'gatePromote', 'gateReceiptVerified', 'gatePublicKeyPinned', 'gateCandidateDigestMatches', 'gateBaselineDigestMatches',
  'gateConfigMatchesPlan',
  // (2) request + checks
  'requestRenderedForCandidate', 'requestDigestValid', 'requestDigestBoundInGateReceipt', 'checksForThisRequest',
  'envLaneCommitPinned', 'imageEnvSourceMatchesPlan',
  'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk',
  // (3) slot + idempotency (+ the run is today's: resumed checks and receipts are never older than this date)
  'runDateIsToday', 'slotFree', 'notAlreadySubmitted',
]);

const KEY_SET = new Set(DECISION_KEYS);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The decision. Fails closed on any non-object input, missing key, non-`true` value or unknown key. */
export function decideSubmit(flags) {
  if (!isObj(flags)) return { submit: false, reasons: ['invalid_decision_input'] };
  const reasons = DECISION_KEYS.filter(k => flags[k] !== true);
  for (const k of Object.keys(flags).sort()) if (!KEY_SET.has(k)) reasons.push(`unexpected_flag:${k}`);
  return { submit: reasons.length === 0, reasons };
}

const ok = check => isObj(check) && check.ok === true;
const hex = v => typeof v === 'string' && SHA256_RE.test(v);
const sameHex = (a, b) => hex(a) && hex(b) && a === b;
const sameNum = (a, b) => typeof a === 'number' && Number.isFinite(a) && a === b;
const sortedIds = list => (Array.isArray(list) && list.every(s => typeof s === 'string') ? [...list].sort() : null);

/** Every task ID of the request was replayed (exact set, no extras, no duplicates). */
export function replayCoversRequest(replay, requestTasks) {
  const want = sortedIds(Array.isArray(requestTasks) ? requestTasks.map(t => t?.task_id) : null);
  const got = sortedIds(replay?.taskIds);
  if (!want || !got || want.length === 0 || new Set(got).size !== got.length) return false;
  return want.length === got.length && want.every((id, i) => id === got[i]);
}

/**
 * Day-1 rule (owner policy): "no incumbent on the leaderboard -> incumbent = v2 defaults". Local state, the public
 * board and the account's own GET /submissions must agree: day 1 <=> the board shows nothing for the user AND no own
 * submission was ever validated; day N <=> the board shows the user AND the latest validated own submission IS the
 * local incumbent. -> true | false | null (unknown: unreadable board or submissions list).
 */
export function boardAgrees(incumbent, board) {
  const day1 = incumbent?.day1, has = board?.hasIncumbent, latest = board?.latestValidatedId;
  if (typeof day1 !== 'boolean' || typeof has !== 'boolean' || !(latest === null || typeof latest === 'string')) return null;
  return day1 ? has === false && latest === null
    : has === true && typeof incumbent.submissionId === 'string' && latest === incumbent.submissionId;
}

/**
 * Raw facts -> flags. Inputs (all optional; anything missing yields a false flag):
 *   mode, darwin:{evidence}, incumbent:{genomeDigest, day1, submissionId}, leaderboard:{hasIncumbent, latestValidatedId},
 *   candidate:{genomeDigest} | null,
 *   plan:{intact, candidateDigest, incumbentDigest, alpha, lambda, candidateBudget, envSourceSha},
 *   confirmation:{preregistered, provenanceMatchesPlan, dryRun, cardsMatchGenomes, pairedUsed},
 *   gate:{promote, verified, publicKeyPinned, candidateDigest, expectedCandidateDigest, baselineDigest,
 *         expectedBaselineDigest, boundRequestSha256, alpha, lambda, candidateBudget},
 *   request:{sha256, image, renderedFor, tasks, tasksMatchCandidate, expectedImage, genomeDigest},
 *   checks:{requestSha256, image, envSourceSha, envCommit, envDirty,
 *           checks:{anonymousPull, openenvValidate, exampleReplay, schemaEqual, limits}},
 *   expectEnvCommit, dates:{run, today}, slot:{free}, alreadySubmitted
 */
export function buildDecisionFlags(f = {}) {
  const g = f.gate ?? {}, r = f.request ?? {}, c = f.confirmation ?? {}, ch = f.checks ?? {}, cs = ch.checks ?? {}, p = f.plan ?? {};
  const candidatePresent = isObj(f.candidate) && hex(f.candidate.genomeDigest);
  return {
    modeAuto: f.mode === 'auto',
    leaderboardAgreesWithIncumbent: boardAgrees(f.incumbent, f.leaderboard) === true,
    darwinEvidenceIsScorecards: f.darwin?.evidence === 'evaluator_scorecards',
    candidatePresent,
    candidateDiffersFromIncumbent: candidatePresent && hex(f.incumbent?.genomeDigest) && f.candidate.genomeDigest !== f.incumbent.genomeDigest,
    // the preregistered plan on disk names THIS candidate and incumbent, and the request was rendered from that genome
    candidateMatchesPlan: p.intact === true && candidatePresent && sameHex(p.candidateDigest, f.candidate.genomeDigest)
      && sameHex(p.incumbentDigest, f.incumbent?.genomeDigest) && sameHex(r.genomeDigest, f.candidate.genomeDigest),
    confirmationPreregistered: c.preregistered === true,
    confirmationProvenanceMatchesPlan: c.provenanceMatchesPlan === true,
    confirmationNotDryRun: c.dryRun === false,
    confirmationCardsMatchGenomes: c.cardsMatchGenomes === true,
    pairedEvidenceUsed: c.pairedUsed === true,
    gatePromote: g.promote === true,
    gateReceiptVerified: g.verified === true,
    gatePublicKeyPinned: g.publicKeyPinned === true,
    gateCandidateDigestMatches: sameHex(g.candidateDigest, g.expectedCandidateDigest),
    gateBaselineDigestMatches: sameHex(g.baselineDigest, g.expectedBaselineDigest),
    // the signed receipt tested at the PREREGISTERED alpha, lambda and alpha split (never today's config)
    gateConfigMatchesPlan: sameNum(g.alpha, p.alpha) && sameNum(g.lambda, p.lambda)
      && Number.isSafeInteger(p.candidateBudget) && g.candidateBudget === p.candidateBudget,
    requestRenderedForCandidate: r.renderedFor === 'candidate' && r.tasksMatchCandidate === true
      && typeof r.image === 'string' && r.image === r.expectedImage,
    requestDigestValid: hex(r.sha256),
    requestDigestBoundInGateReceipt: sameHex(g.boundRequestSha256, r.sha256),
    checksForThisRequest: sameHex(ch.requestSha256, r.sha256) && typeof ch.image === 'string' && ch.image === r.image,
    // the env lane code that rendered, validated and replayed is the pinned, clean commit
    envLaneCommitPinned: typeof f.expectEnvCommit === 'string' && /^[0-9a-f]{40}$/.test(f.expectEnvCommit)
      && ch.envCommit === f.expectEnvCommit && ch.envDirty === false,
    // the environment source INSIDE the submitted image is what the confirmation measured (lib/provenance.mjs hash)
    imageEnvSourceMatchesPlan: sameHex(ch.envSourceSha, p.envSourceSha),
    imagePulledAnonymously: ok(cs.anonymousPull),
    openenvValidatePassed: ok(cs.openenvValidate),
    exampleReplayAllTasksPassed: ok(cs.exampleReplay) && replayCoversRequest(cs.exampleReplay, r.tasks),
    schemaEqual: ok(cs.schemaEqual),
    limitsOk: ok(cs.limits),
    runDateIsToday: typeof f.dates?.run === 'string' && f.dates.run === f.dates.today,
    slotFree: f.slot?.free === true,
    notAlreadySubmitted: f.alreadySubmitted === false,
  };
}
