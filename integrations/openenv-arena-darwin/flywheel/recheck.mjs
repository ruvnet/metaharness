// Decision-time re-derivation. Every fact the submit decision rests on is recomputed right before decideSubmit from
// the files on disk (plan, confirmation cards, paired outcomes, signed receipt, rendered request, pre-submit report),
// the journal and the CURRENT config. A resumed phase result only says WHERE those files are, never whether they
// passed: resumed booleans (verified, pinned, cardsMatch, tasksMatch, ...) are not trusted. The receipt is verified
// again here against the pin in force now. Anything unreadable yields null, which buildDecisionFlags reads as false.
import { join } from 'node:path';
import { canonicalDigest } from './canonical-json.mjs';
import { cardMatchesGenome, pairedOutcomes, planHashOf, preregistered, provenanceMatches } from './confirm.mjs';
import { torontoDate } from './dates.mjs';
import { genomeToTasks, readStoredRequest, redrawName, requestBodyDigest, tasksMatch } from './incumbent.mjs';
import { readJson, redact } from './journal.mjs';

const tryRead = p => { try { return typeof p === 'string' ? readJson(p) : null; } catch { return null; } };
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const num = v => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** -> {facts (buildDecisionFlags input minus mode/slot/alreadySubmitted), view (for the report)} */
export async function recheckFacts(x, { inc, search, cand, plan, req, conf, gate }) {
  const { deps, config, j } = x;
  const digestOf = deps.darwin.digestOf, cells = deps.darwin.cells;
  const p = plan?.plan ?? null;
  const planDisk = tryRead(plan?.planPath);
  const planIntact = Boolean(p && planDisk && safe(() => planHashOf(planDisk) === plan.planHash && planHashOf(p) === plan.planHash));
  const incCard = tryRead(conf?.incumbentCardPath), candCard = tryRead(conf?.candidateCardPath);
  const pairsNow = safe(() => pairedOutcomes(incCard, candCard));
  const pairsDisk = tryRead(conf?.pairedPath);
  const reqDisk = tryRead(req?.requestPath);
  const reqSha = safe(() => canonicalDigest(reqDisk));
  const report = tryRead(req?.reportPath);
  const checks = report ? safe(() => deps.renderCheck.toDecisionFacts(report), {}) : {};

  let v = null, verifyError = null; // fresh, against the pin in force NOW (a rotated pin revokes yesterday's receipts)
  if (gate?.receiptPath) { try { v = await deps.darwin.verify({ receiptPath: gate.receiptPath }); } catch (e) { verifyError = redact(e?.message ?? e); } }
  const pl = v?.payload ?? {};

  const candDigest = cand && safe(() => canonicalDigest(cand.genome)) === cand.genomeDigest ? cand.genomeDigest : null;
  const expectedTasks = cand && p ? safe(() => genomeToTasks(cand.genome, { genomeToCells: cells.genomeToCells,
    contextTokens: p.expectedProvenance.contextTokens, taskLimits: config.submission.taskLimits })) : null;
  const facts = {
    darwin: { evidence: search?.evidence, skipped: search?.skipped ?? null },
    incumbent: { genomeDigest: safe(() => canonicalDigest(inc.genome)) === inc.genomeDigest ? inc.genomeDigest : null,
      day1: inc.day1, submissionId: inc.submissionId ?? null },
    leaderboard: { hasIncumbent: x.st.arena?.hasIncumbent ?? null, latestValidatedId: x.st.arena?.latestValidatedId },
    candidate: cand ? { genomeDigest: candDigest } : null,
    plan: p ? { intact: planIntact, candidateDigest: safe(() => canonicalDigest(p.candidate.genome)) === p.candidate.genomeDigest ? p.candidate.genomeDigest : null,
      incumbentDigest: safe(() => canonicalDigest(p.incumbent.genome)) === p.incumbent.genomeDigest ? p.incumbent.genomeDigest : null,
      alpha: num(p.gate?.alpha), lambda: num(p.gate?.lambda), candidateBudget: p.gate?.candidateBudget ?? null,
      envSourceSha: p.expectedProvenance?.envSourceSha ?? null } : null,
    confirmation: conf && p ? {
      preregistered: planIntact && preregistered(j.entries(), plan.planHash, planDisk),
      provenanceMatchesPlan: provenanceMatches(incCard, p.expectedProvenance) && provenanceMatches(candCard, p.expectedProvenance),
      dryRun: incCard?.raw?.dryRun === false && candCard?.raw?.dryRun === false ? false : true,
      cardsMatchGenomes: cardMatchesGenome(incCard, cells.genomeToCells, p.incumbent.genome) && cardMatchesGenome(candCard, cells.genomeToCells, p.candidate.genome),
      pairedUsed: Boolean(pairsNow && pairsDisk) && safe(() => digestOf(pairsDisk) === digestOf(pairsNow) && pl.pairedDigest === digestOf(pairsNow))
        && /withSequentialEvidence/.test(pl.config?.rule ?? ''),
    } : {},
    gate: v ? { promote: v.promote === true && pl.promote === true, verified: v.verified === true, publicKeyPinned: v.publicKeyPinned === true,
      candidateDigest: pl.candidate?.digest ?? null, expectedCandidateDigest: candCard ? safe(() => digestOf(candCard)) : null,
      baselineDigest: pl.baseline?.digest ?? null, expectedBaselineDigest: incCard ? safe(() => digestOf(incCard)) : null,
      boundRequestSha256: pl.binding?.requestSha256 ?? null,
      alpha: pl.config?.alpha ?? null, lambda: pl.config?.lambda ?? null, candidateBudget: pl.config?.candidateBudget ?? null } : {},
    request: req ? { sha256: reqSha && reqSha === req.requestSha256 ? reqSha : null, image: reqDisk?.image ?? null, expectedImage: config.image,
      renderedFor: req.renderedFor, tasks: reqDisk?.tasks ?? null, genomeDigest: safe(() => canonicalDigest(req.genome)),
      tasksMatchCandidate: Boolean(expectedTasks && reqDisk) && tasksMatch(reqDisk.tasks, expectedTasks) } : {},
    checks,
    expectEnvCommit: config.checks?.expectEnvCommit ?? null,
    dates: { run: x.date, today: torontoDate(x.now) },
  };
  const view = v ? { verified: v.verified === true, publicKeyPinned: v.publicKeyPinned === true, publicKey: v.publicKey ?? null, error: verifyError }
    : { verified: null, publicKeyPinned: null, error: verifyError };
  return { facts, view };
}

/**
 * daily-best, kind 'incumbent-redraw': the re-draw's request and pre-submit facts, re-derived from its files on disk
 * exactly like the candidate's (plus its check date and body digest), incumbent.json as it is on disk NOW and its
 * stored validated request re-read and re-hashed NOW (readStoredRequest: path, perms, owner, both digests).
 * expectedImage/expectedName come from that stored request (never config.image). asValidatedSha256 = the re-draw body
 * under the validated submission's own submission_id and name (null when the record lacks either): it must reproduce
 * the record's requestSha256. clockToday = Toronto date of the clock right now; evaluatorDryRun = the config now.
 * -> {request, storedRequest, checks, incumbentRecord, clockToday, evaluatorDryRun}: replaces those slots of
 * recheckFacts' facts for buildDecisionFlags.
 */
export function redrawFacts(x, { redraw }) {
  const { deps, config } = x;
  const reqDisk = tryRead(redraw?.requestPath);
  const reqSha = safe(() => canonicalDigest(reqDisk));
  const report = tryRead(redraw?.reportPath);
  const checks = report ? safe(() => deps.renderCheck.toDecisionFacts(report), {}) : {};
  const rec = tryRead(join(x.stateDir, 'incumbent.json'));
  const recObj = rec && typeof rec === 'object' && !Array.isArray(rec) ? rec : null;
  const sr = recObj ? readStoredRequest(x.stateDir, recObj.storedRequest) : null;
  const asValidated = reqDisk && typeof reqDisk === 'object' && recObj && typeof recObj.submissionId === 'string' && typeof recObj.requestName === 'string'
    ? safe(() => canonicalDigest({ ...reqDisk, submission_id: recObj.submissionId, name: recObj.requestName })) : null;
  return {
    request: redraw ? { sha256: reqSha && reqSha === redraw.requestSha256 ? reqSha : null, image: reqDisk?.image ?? null,
      expectedImage: sr?.image ?? null, renderedFor: redraw.renderedFor, source: redraw.source ?? null, tasks: reqDisk?.tasks ?? null,
      name: typeof reqDisk?.name === 'string' ? reqDisk.name : null, expectedName: redrawName(sr?.name),
      submissionId: typeof reqDisk?.submission_id === 'string' && reqDisk.submission_id === redraw.submissionId ? reqDisk.submission_id : null,
      bodySha256: reqDisk ? safe(() => requestBodyDigest(reqDisk)) : null, asValidatedSha256: asValidated } : {},
    storedRequest: sr ? { fileOk: sr.fileOk, problem: sr.problem, recordedSha256: sr.recordedSha256, fileSha256: sr.fileSha256,
      canonicalSha256: sr.canonicalSha256, canonical: sr.canonical, submissionId: sr.submissionId, name: sr.name, bodySha256: sr.bodySha256,
      image: sr.image } : null,
    checks: { ...checks, checkedDate: safe(() => torontoDate(report?.checked_at ?? NaN)) },
    incumbentRecord: recObj ? { state: recObj.state ?? null, hasGenome: recObj.genome !== null && recObj.genome !== undefined,
      genomeDigest: safe(() => canonicalDigest(recObj.genome)) === recObj.genomeDigest ? recObj.genomeDigest : null,
      submissionId: recObj.submissionId ?? null, requestSha256: recObj.requestSha256 ?? null,
      requestBodySha256: recObj.requestBodySha256 ?? null, requestName: recObj.requestName ?? null, lastRejected: recObj.lastRejected ?? null } : null,
    clockToday: safe(() => torontoDate(deps.nowMs())),
    evaluatorDryRun: typeof config.evaluator?.dryRun === 'boolean' ? config.evaluator.dryRun : null,
  };
}
