// Pure submit decision for the daily OpenEnv Arena flywheel. No I/O, no clock, no LLM.
//
// decideSubmit(flags) -> {submit, reasons}. `flags` is a flat object of named conditions; EVERY key in
// DECISION_KEYS must be exactly `true` (not truthy) or the run does not submit. Unknown keys also block,
// so a caller cannot smuggle in a flag the policy does not know. reasons lists every failing key, in
// DECISION_KEYS order. buildDecisionFlags(facts) derives the flags from raw run facts (also pure); the facts
// themselves are re-derived from the files on disk at decision time (recheck.mjs), never resumed booleans.
//
// Policy `gate-only` (the default; owner rUv): auto-submit only when (1) the Flywheel gate promotes the candidate and
// its signed receipt verifies against the pinned key; (2) every pre-submit check passed on THIS request and image and
// the request digest is the one bound into the gate receipt; (3) the 24 h slot is free; (4) mode = auto.
//
// Policy `daily-best` (owner standing approval, 2026-10-08): submit the best available request every day. The KIND is
// chosen by gatePromote && gateReceiptVerified alone: 'promoted' -> the candidate's request under exactly the
// DECISION_KEYS above; otherwise 'incumbent-redraw' -> the STORED copy of the arena-validated incumbent's exact request,
// unchanged apart from a fresh submission_id and the re-draw name, under REDRAW_KEYS (the stored copy intact and bound to
// the validated digest; every pre-submit check again, today, on its own image; not if the arena rejected that body
// since). A promoted kind whose other
// conditions fail blocks; it never falls through to a re-draw, so every condition stays load-bearing in both policies.
// A re-draw is another sample of the same request: selection on noise, never an improvement.
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

export const POLICIES = Object.freeze(['gate-only', 'daily-best']);

/** daily-best, kind 'incumbent-redraw': the conditions for re-submitting the arena-validated incumbent's request. */
export const REDRAW_KEYS = Object.freeze([
  'modeAuto',
  // the incumbent itself: validated by the arena, agreed by the board, not a dry-run rehearsal, its stored request intact
  // and bound to the validated digest, re-submitted unchanged (fresh id and re-draw name only), and that body not
  // rejected by the arena since (an author-origin rejection is never POSTed again without a human)
  'leaderboardAgreesWithIncumbent', 'redrawNotRehearsal', 'incumbentValidated', 'storedRequestIntact', 'requestRenderedForIncumbent',
  'redrawIsIncumbentRequest', 'incumbentBodyNotRejected',
  // every pre-submit check on THIS request and image, run today
  'requestDigestValid', 'checksForThisRequest', 'envLaneCommitPinned', 'redrawCheckedToday',
  'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk',
  'runDateIsToday', 'slotFree', 'notAlreadySubmitted',
]);
/** Re-draw conditions about whether a valid incumbent request exists at all: one of them failing = needs-human. */
export const REDRAW_REQUEST_KEYS = Object.freeze(['incumbentValidated', 'storedRequestIntact', 'requestRenderedForIncumbent', 'redrawIsIncumbentRequest',
  'incumbentBodyNotRejected', 'requestDigestValid', 'checksForThisRequest', 'envLaneCommitPinned', 'redrawCheckedToday',
  'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk']);
/** search.skipped when the incumbent has no genome (body-only): no rental, no search, nothing to promote over it. */
export const SEARCH_SKIPPED_NO_GENOME = 'incumbent_has_no_genome';
/** One wording for every report, so a public post states the kind honestly. */
export const KIND_LABELS = Object.freeze({
  promoted: 'promoted candidate: the Flywheel gate promoted it on preregistered paired evidence (verified receipt)',
  'incumbent-redraw': 'incumbent re-draw: the arena-validated incumbent request again with a fresh submission_id; selection on noise, not an improvement',
});
/** The kind a status reports: what this date POSTed (submission.kind, from the journaled intent), else the decision's
 *  kind. A same-date rerun recomputes the decision; it never relabels what was already submitted. */
export const reportedKind = s => s?.submission?.kind ?? s?.decision?.kind ?? null;

const KEY_SET = new Set(DECISION_KEYS);
const DAILY_KEY_SET = new Set([...DECISION_KEYS, ...REDRAW_KEYS]);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** daily-best: which request today's decision is about. Only a promoted gate with a verified receipt names the candidate. */
export const decisionKind = flags => (isObj(flags) && flags.gatePromote === true && flags.gateReceiptVerified === true ? 'promoted' : 'incumbent-redraw');

/**
 * The decision. Fails closed on any non-object input, missing key, non-`true` value, unknown key or unknown policy.
 * gate-only -> {submit, reasons} (unchanged); daily-best -> {submit, reasons, kind} over the kind's own key list.
 */
export function decideSubmit(flags, policy = 'gate-only') {
  if (policy === 'gate-only') {
    if (!isObj(flags)) return { submit: false, reasons: ['invalid_decision_input'] };
    const reasons = DECISION_KEYS.filter(k => flags[k] !== true);
    for (const k of Object.keys(flags).sort()) if (!KEY_SET.has(k)) reasons.push(`unexpected_flag:${k}`);
    return { submit: reasons.length === 0, reasons };
  }
  if (policy !== 'daily-best') return { submit: false, reasons: ['invalid_policy'], kind: null };
  if (!isObj(flags)) return { submit: false, reasons: ['invalid_decision_input'], kind: null };
  const kind = decisionKind(flags);
  const reasons = (kind === 'promoted' ? DECISION_KEYS : REDRAW_KEYS).filter(k => flags[k] !== true);
  for (const k of Object.keys(flags).sort()) if (!DAILY_KEY_SET.has(k)) reasons.push(`unexpected_flag:${k}`);
  return { submit: reasons.length === 0, reasons, kind };
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
 * policy 'daily-best' adds the re-draw-only flags, from (with `request`/`checks` then describing the RE-DRAW request):
 *   incumbentRecord:{state, hasGenome, genomeDigest, submissionId, requestSha256, requestBodySha256, requestName, lastRejected}
 *   (incumbent.json as on disk at decision time), storedRequest:{fileOk, recordedSha256, fileSha256, canonicalSha256,
 *   canonical, submissionId, name, bodySha256, image} (incumbent.mjs readStoredRequest of the stored copy, at decision
 *   time), request:{..., source, name, expectedName, submissionId, bodySha256, asValidatedSha256}, darwin:{..., skipped},
 *   evaluatorDryRun (config now), checks:{..., checkedDate}, clockToday (the Toronto date of the decision-time clock, not
 *   of the caller's --now)
 */
export function buildDecisionFlags(f = {}, policy = 'gate-only') {
  const flags = gateOnlyFlags(f);
  if (policy !== 'daily-best') return flags;
  const r = f.request ?? {}, rec = isObj(f.incumbentRecord) ? f.incumbentRecord : null, inc = f.incumbent ?? {};
  const sr = isObj(f.storedRequest) ? f.storedRequest : null;
  const rej = rec?.lastRejected;
  return { ...flags,
    // the incumbent was itself accepted + validated by the arena, and incumbent.json on disk NOW is this run's incumbent
    // (the same genome, or, for a body-only incumbent, still none)
    incumbentValidated: inc.day1 === false && rec !== null && rec.state === 'validated'
      && (inc.genomeDigest === null ? rec.hasGenome === false && rec.genomeDigest === null : sameHex(rec.genomeDigest, inc.genomeDigest))
      && typeof rec.submissionId === 'string' && rec.submissionId === inc.submissionId,
    // the stored copy is the exact validated request: an untouched read-only file at its content address whose bytes and
    // canonical JSON both hash to the record's requestSha256, with the record's submission_id, name and body digest
    storedRequestIntact: rec !== null && sr !== null && sr.fileOk === true && sr.canonical === true && sameHex(sr.recordedSha256, rec.requestSha256)
      && sameHex(sr.fileSha256, rec.requestSha256) && sameHex(sr.canonicalSha256, rec.requestSha256)
      && typeof sr.submissionId === 'string' && sr.submissionId === rec.submissionId
      && typeof sr.name === 'string' && sr.name === rec.requestName && sameHex(sr.bodySha256, rec.requestBodySha256),
    // built from the stored request, for ITS image (never config.image), under the re-draw name and a fresh submission_id
    requestRenderedForIncumbent: r.renderedFor === 'incumbent-redraw' && r.source === 'stored-request' && typeof r.image === 'string'
      && r.image === r.expectedImage && typeof r.name === 'string' && r.name === r.expectedName
      && typeof r.submissionId === 'string' && typeof inc.submissionId === 'string' && r.submissionId !== inc.submissionId
      && (rec === null || r.submissionId !== rec.submissionId),
    // byte-identical to the validated request apart from submission_id and name: a re-draw, never a lookalike. Its body is
    // the stored body and the record's, and that body under the validated submission's own id and name reproduces
    // requestSha256, the digest of the bytes arena-api.mjs actually POSTed for it.
    redrawIsIncumbentRequest: rec !== null && sr !== null && sameHex(r.bodySha256, sr.bodySha256) && sameHex(r.bodySha256, rec.requestBodySha256)
      && sameHex(r.asValidatedSha256, rec.requestSha256),
    // no author-origin rejection of this body is recorded since it was validated (a malformed record blocks too)
    incumbentBodyNotRejected: rec !== null && (rej === undefined || rej === null
      || (isObj(rej) && hex(rej.requestBodySha256) && rej.requestBodySha256 !== rec.requestBodySha256 && rej.requestBodySha256 !== r.bodySha256)),
    // the pre-submit checks of this request ran today by the run date AND by the decision-time clock (a resumed,
    // pre-dated or stale --now run never reuses older checks)
    redrawCheckedToday: typeof f.checks?.checkedDate === 'string' && f.checks.checkedDate === f.dates?.today && f.checks.checkedDate === f.clockToday,
    // not a dry-run rehearsal: the search produced real scorecards, or (a body-only incumbent) no search ran because there
    // is no genome and the evaluator is not in dry-run now
    redrawNotRehearsal: f.darwin?.evidence === 'evaluator_scorecards'
      || (f.darwin?.skipped === SEARCH_SKIPPED_NO_GENOME && inc.genomeDigest === null && rec?.hasGenome === false && f.evaluatorDryRun === false),
  };
}

function gateOnlyFlags(f) {
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
