// Late flywheel phases (no GPU): render + pre-submit checks, the signed gate, the pure decision, the single
// guarded submission and its follow-up. `x` is the run context built by flywheel.mjs runFlywheel().
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from './canonical-json.mjs';
import { buildDecisionFlags, decideSubmit, decisionKind, REDRAW_REQUEST_KEYS } from './decide.mjs';
import { clearPending, genomeToTasks, readPending, readStoredRequest, recordRedraw, recordRedrawRejected, redrawName, requestBodyDigest,
  storeRequest, submissionIdFor, tasksMatch, writeIncumbent, writePending } from './incumbent.mjs';
import { readJson, readJsonIfExists, redact, runStep, writeJsonAtomic } from './journal.mjs';
import { recheckFacts, redrawFacts } from './recheck.mjs';

export const QUOTA_FALLBACK_S = 24 * 3600; // a 429 without retry_after_s: the arena's own rolling window

// submission_id tag and name suffix per genome-rendered request. The id embeds the run date, so every request is fresh.
const RENDERED = Object.freeze({ candidate: { tag: '', suffix: '' }, 'needs-human': { tag: 'v2', suffix: ' (v2 defaults)' } });

/**
 * daily-best re-draw: the STORED copy of the arena-validated incumbent's exact request (incumbent.json storedRequest),
 * unchanged apart from a fresh submission_id (`<prefix>-<date>-redraw-<hash>`) and the re-draw name, then every
 * pre-submit check on it today against ITS image (render-and-check verbatim mode; never config.image, never re-rendered
 * from a genome). A stored copy that is missing or not intact renders nothing (the decision then names
 * storedRequestIntact). The decision re-reads and re-hashes everything again (recheck.mjs redrawFacts).
 */
export function redrawPhase(x, inc) {
  const { config, deps, j, date, stateDir } = x;
  return runStep(j, 'render-incumbent-redraw', async () => {
    const rec = readJsonIfExists(join(stateDir, 'incumbent.json'));
    const sr = readStoredRequest(stateDir, rec?.storedRequest);
    const base = { renderedFor: 'incumbent-redraw', source: 'stored-request', genome: inc.genome ?? null, genomeDigest: inc.genomeDigest ?? null,
      storedRequest: rec?.storedRequest ?? null, configImage: config.image };
    if (!sr.ok) {
      return { ...base, submissionId: null, name: null, image: null, tasks: null, requestPath: null, requestSha256: null, reportPath: null,
        ok: false, reasons: [`stored_request_unusable:${sr.problem}`], checks: deps.renderCheck.toDecisionFacts(null), configImageDiffers: null };
    }
    const body = sr.request;
    const submissionId = submissionIdFor({ prefix: config.submission.idPrefix, date, tasks: body.tasks, image: body.image, tag: 'redraw' });
    const name = redrawName(body.name);
    const request = { ...body, submission_id: submissionId, name };
    const n = j.find('render-incumbent-redraw', 'start').length;
    const report = await deps.renderCheck.run({ outDir: join(x.runDir, 'incumbent-redraw', `attempt-${n}`), submissionId, name, request,
      image: body.image, dataset: body.dataset, tasks: body.tasks, runId: `${date}-incumbent-redraw-${n}`, nowMs: deps.nowMs(), checkedAt: deps.clock() });
    const onDisk = report?.request_path ? readJson(report.request_path) : null;
    return { ...base, submissionId, name, image: onDisk?.image ?? null, tasks: onDisk?.tasks ?? null, storedImage: body.image,
      configImageDiffers: config.image !== body.image, requestPath: report?.request_path ?? null, requestSha256: report?.request_sha256 ?? null,
      ok: report?.ok === true, reasons: report?.reasons ?? ['render_and_check_returned_nothing'], reportPath: report?.report_path ?? null,
      checks: deps.renderCheck.toDecisionFacts(report) };
  });
}

/** Render the request for `genome` with the env lane's renderer and run every pre-submit check on it. */
export function renderPhase(x, renderedFor, genome, contextTokens) {
  const { config, deps, j, date } = x;
  if (!Object.hasOwn(RENDERED, renderedFor)) throw new Error(`unknown rendered request kind: ${renderedFor}`);
  return runStep(j, `render-${renderedFor}`, async () => {
    const tasks = genomeToTasks(genome, { genomeToCells: deps.darwin.cells.genomeToCells, contextTokens, taskLimits: config.submission.taskLimits });
    const { tag, suffix } = RENDERED[renderedFor];
    const submissionId = submissionIdFor({ prefix: config.submission.idPrefix, date, tasks, image: config.image, tag });
    const name = `${config.submission.namePrefix} ${date}${suffix}`;
    const n = j.find(`render-${renderedFor}`, 'start').length;
    const report = await deps.renderCheck.run({ outDir: join(x.runDir, renderedFor, `attempt-${n}`), submissionId, name,
      image: config.image, dataset: config.dataset, tasks, runId: `${date}-${renderedFor}-${n}`, nowMs: deps.nowMs(), checkedAt: deps.clock() });
    const request = report?.request_path ? readJson(report.request_path) : null;
    // `genome` is what this request was rendered FROM: the only genome a POST of it may record as the incumbent
    return { renderedFor, submissionId, name, genome, genomeDigest: canonicalDigest(genome), expectedTasks: tasks, tasks: request?.tasks ?? null,
      tasksMatch: request ? tasksMatch(request.tasks, tasks) : false, image: request?.image ?? null,
      requestPath: report?.request_path ?? null, requestSha256: report?.request_sha256 ?? null,
      ok: report?.ok === true, reasons: report?.reasons ?? ['render_and_check_returned_nothing'], reportPath: report?.report_path ?? null,
      checks: deps.renderCheck.toDecisionFacts(report) };
  });
}

/** gate.mjs v2 on the search report (--run: selection context) + the CONFIRMATION cards + Darwin-derived pairs at the
 *  PREREGISTERED alpha, lambda and candidateBudget (from the plan, never today's config), then verification against
 *  the pinned key. The result is for the report; the decision re-verifies the receipt itself (recheck.mjs). */
export function gatePhase(x, conf, req, { runPath, candidateBudget, alpha, lambda }) {
  const { deps, j } = x;
  return runStep(j, 'gate', async () => {
    const n = j.find('gate', 'start').length;
    const g = await deps.darwin.gate({ runPath, baselinePath: conf.incumbentCardPath, candidatePath: conf.candidateCardPath,
      pairedPath: conf.pairedPath, outPath: join(x.runDir, 'gate', `receipt-${n}.json`), candidateBudget, alpha, lambda,
      requestSha256: req?.requestSha256 ?? null });
    const v = await deps.darwin.verify({ receiptPath: g.receiptPath });
    const p = v.payload ?? {};
    return {
      promote: g.promote === true && v.promote === true && p.promote === true, verified: v.verified === true,
      publicKeyPinned: v.publicKeyPinned === true, publicKey: v.publicKey ?? null, reasons: p.reasons ?? g.reasons ?? [],
      exitCode: g.exitCode ?? null, error: g.error ?? null, candidateBudget: p.config?.candidateBudget ?? null,
      alpha: p.config?.alpha ?? null, lambda: p.config?.lambda ?? null,
      boundRequestSha256: p.binding?.requestSha256 ?? null, bindingSupported: g.bindingSupported === true,
      sequential: p.sequential ?? null, deltas: p.deltas ?? null, receiptPath: g.receiptPath, gateFingerprint: p.gateFingerprint ?? null,
    };
  });
}

/** Fresh slot read; any failure is "not free" (fail closed). */
export async function slotNow(x) {
  const nowMs = x.deps.nowMs();
  try {
    const s = await x.deps.arena.slot(nowMs);
    const freeAtMs = Number.isFinite(s?.freeAtMs) ? s.freeAtMs : null;
    const latest = s?.latestValidatedId;
    return { free: s?.free === true, reasons: s?.reasons ?? [], freeAtMs, freeAt: s?.freeAt ?? null,
      retryAfterS: freeAtMs === null ? null : Math.max(0, Math.ceil((freeAtMs - nowMs) / 1000)),
      latestValidatedId: latest === null || typeof latest === 'string' ? latest : undefined };
  } catch (e) { return { free: false, reasons: [`slot_check_failed:${redact(e?.message ?? e)}`], freeAtMs: null, freeAt: null, retryAfterS: null, latestValidatedId: undefined }; }
}

/** arena-api.mjs persists its receipt with post_attempted=true BEFORE the POST; no receipt or false => never sent. */
function neverPosted(pending) {
  if (typeof pending.receiptPath !== 'string' || !existsSync(pending.receiptPath)) return true;
  try { return readJson(pending.receiptPath).post_attempted === false; } catch { return false; }
}

const outcomeOf = s => (s?.state === 'validated' ? 'submitted-validated' : s?.state === 'rejected' ? 'submitted-rejected'
  : s?.state === 'absent' ? 'submit-unknown' : 'submitted-pending');

/** Outcome of a date whose submission was already attempted by an earlier run (from the journal). */
function resumedOutcome(j, st) {
  const status = j.last('submit', 'status'), result = j.last('submit', 'result');
  if (status) { st.submission ??= { submissionId: status.submissionId, state: status.state }; return outcomeOf(status); }
  if (result?.receiptState === 'refused') return result.code === 'SUBMISSION_QUOTA_EXCEEDED' ? 'slot-busy' : 'submit-refused';
  return 'submit-unknown';
}

/** Poll a pending submission (never POSTs). The incumbent changes only on `validated`. */
export async function follow(x, pending, polls) {
  const { deps, j, st, stateDir } = x;
  for (let i = 0; i <= polls; i++) {
    if (i > 0) await deps.sleep(x.config.poll.intervalS * 1000);
    let s;
    try { s = await deps.arena.getSubmission(pending.submissionId); } catch (e) { j.append('submit', 'status-error', { error: redact(e?.message) }); continue; }
    const state = s?.state ?? 'absent';
    j.append('submit', 'status', { submissionId: pending.submissionId, state, slotState: s?.slot_state ?? null, errorOrigin: s?.error_origin ?? null });
    st.submission = { ...(st.submission ?? {}), submissionId: pending.submissionId, forDate: pending.date, state,
      slotState: s?.slot_state ?? null, errorOrigin: s?.error_origin ?? null, runId: s?.run_id ?? null };
    if (state === 'validated') {
      const rec = { genome: pending.genome ?? null, submissionId: pending.submissionId, requestSha256: pending.requestSha256,
        requestBodySha256: pending.requestBodySha256 ?? null, requestName: pending.requestName ?? null, date: pending.date, state,
        storedRequest: pending.storedRequest ?? null };
      if (pending.kind !== 'incumbent-redraw') {
        try { writeIncumbent(stateDir, rec); } catch (e) { // the stored copy is unusable: record the genome, re-draws stay blocked
          if (!rec.storedRequest || rec.genome === null) throw e;
          writeIncumbent(stateDir, { ...rec, storedRequest: null });
          const why = redact(e?.message ?? e);
          j.append('incumbent', 'stored-request-unusable', { submissionId: pending.submissionId, reason: why });
          st.notes.push(`validated ${pending.submissionId} recorded without its stored request (${why}): re-draws stay blocked (needs-human) until a human bootstraps it`);
        }
        clearPending(stateDir);
        j.append('incumbent', 'updated', { submissionId: pending.submissionId, requestSha256: pending.requestSha256 });
        return state;
      }
      let error = null; // a re-draw: the genome stays; only the newest-validated pointer moves (or nothing, fail closed)
      try { recordRedraw(stateDir, rec); } catch (e) { error = redact(e?.message ?? e); }
      clearPending(stateDir);
      if (!error) j.append('incumbent', 'redraw-recorded', { submissionId: pending.submissionId, requestSha256: pending.requestSha256 });
      else {
        j.append('incumbent', 'unchanged', { reason: error, submissionId: pending.submissionId });
        st.notes.push(`validated re-draw ${pending.submissionId} was not recorded (${error}): reconcile incumbent.json by hand`);
      }
      return state;
    }
    if (state === 'rejected') {
      // A rejected re-draw (author origin; a missing origin counts as author) blocks re-draws of that body before the
      // pending record goes: otherwise the next day would POST the same rejected body again with no human involved.
      const origin = s?.error_origin ?? null;
      if (pending.kind === 'incumbent-redraw' && origin !== 'platform') {
        const written = recordRedrawRejected(stateDir, { submissionId: pending.submissionId, date: pending.date, errorOrigin: origin,
          requestBodySha256: pending.requestBodySha256 ?? null });
        j.append('incumbent', 'redraw-rejected', { submissionId: pending.submissionId, errorOrigin: origin, recorded: written !== null });
        st.notes.push(`incumbent re-draw ${pending.submissionId} was rejected (${origin ?? 'author'} origin): re-draws of this request stay `
          + 'blocked (needs-human) until a promoted candidate is validated or a human removes lastRejected from incumbent.json');
      }
      clearPending(stateDir); j.append('incumbent', 'unchanged', { reason: 'rejected', submissionId: pending.submissionId }); return state;
    }
    if (state === 'absent' && neverPosted(pending)) { // crashed before arena-api.mjs persisted `sending`: nothing was sent
      clearPending(stateDir); j.append('submit', 'never-sent', { submissionId: pending.submissionId }); return state;
    }
  }
  writePending(stateDir, { ...pending, state: st.submission?.state ?? pending.state });
  return st.submission?.state ?? pending.state;
}

async function submit(x, req, kind) {
  const { deps, j, st, stateDir, date } = x;
  const receiptPath = join(x.runDir, 'submit', 'arena-receipt.json');
  // The genome the POSTed request was rendered from (decide.mjs candidateMatchesPlan / incumbentValidated proved it is
  // the candidate / the incumbent; null for a body-only incumbent), the body digest a later re-draw must reproduce
  // exactly, the name that (with submission_id) rebuilds the POSTed bytes from that body, and the immutable stored copy
  // of exactly the approved bytes (written BEFORE the POST; it becomes incumbent.json's storedRequest once validated).
  // The copy is bookkeeping for later re-draws, never a condition of this POST (arena-api.mjs re-checks the exact bytes
  // against the approved digest): a copy that cannot be stored is journaled and noted, and the request is POSTed without
  // one, so it can never be re-drawn (storedRequestIntact) until a human bootstraps it. The decision is not re-opened.
  let request = null, requestBodySha256 = null, requestName = null, storedRequest = null;
  try { request = readJson(req.requestPath); requestBodySha256 = requestBodyDigest(request); requestName = typeof request.name === 'string' ? request.name : null; }
  catch { request = null; /* the POST below fails on it too */ }
  if (request) {
    try { storedRequest = storeRequest(stateDir, request, req.requestSha256); } catch (e) {
      const why = redact(e?.message ?? e);
      j.append('submit', 'stored-request-failed', { submissionId: req.submissionId, reason: why });
      st.notes.push(`the approved request was not stored (${why}): it is POSTed without a stored copy and can never be re-drawn until a human bootstraps it`);
    }
  }
  const pending = { date, submissionId: req.submissionId, requestSha256: req.requestSha256, genome: req.genome ?? null, receiptPath, state: 'sending',
    requestBodySha256, requestName, ...(storedRequest ? { storedRequest } : {}), ...(kind ? { kind } : {}) };
  writePending(stateDir, pending); // before the POST: a crash is reconciled by the next run, never re-POSTed
  j.append('submit', 'intent', { submissionId: req.submissionId, requestSha256: req.requestSha256, ...(kind ? { kind } : {}) });
  let r;
  try { r = await deps.arena.submit({ request: request ?? readJson(req.requestPath), approvedSha256: req.requestSha256, receiptPath }); } catch (e) {
    st.submission = { submissionId: req.submissionId, posted: null, state: 'unknown', error: redact(e?.message), ...(kind ? { kind } : {}) };
    j.append('submit', 'error', { error: st.submission.error });
    st.outcome = 'submit-unknown';
    return;
  }
  // daily-best: `kind` on the submission is what was POSTed; every report states that, never a later recomputed decision
  st.submission = { submissionId: req.submissionId, posted: r?.post_attempted === true, receiptState: r?.state ?? null,
    state: r?.arena?.state ?? null, httpStatus: r?.http_status ?? null, code: r?.error_code ?? null, retryAfterS: r?.retry_after_s ?? null,
    ...(kind ? { kind } : {}) };
  j.append('submit', 'result', { ...st.submission });
  if (r?.state === 'refused') {
    clearPending(stateDir);
    if (r.error_code === 'SUBMISSION_QUOTA_EXCEEDED') {
      const given = Number.isFinite(r.retry_after_s) && r.retry_after_s >= 0; // without it: the arena's 24 h window
      writeJsonAtomic(join(stateDir, 'quota.json'), { retryAfterS: given ? r.retry_after_s : QUOTA_FALLBACK_S,
        retryAfterSource: given ? 'arena' : 'fallback-24h', observedAtMs: deps.nowMs() });
      st.outcome = 'slot-busy';
    } else st.outcome = 'submit-refused';
    return;
  }
  if (r?.state !== 'recorded') { st.outcome = 'submit-unknown'; return; }
  st.outcome = outcomeOf({ state: await follow(x, pending, x.config.poll.attempts) });
}

/** Re-derive every fact from disk + current config (recheck.mjs), decide (pure), and submit only in auto mode when
 *  every condition holds. Resumed phase results are file locations here, never verdicts. Under policy daily-best the
 *  re-derived gate picks the kind; for an incumbent re-draw the request/check facts are the re-draw's, also from disk. */
export async function decideAndSubmit(x, { inc, search, cand, plan, conf, req, gate }) {
  const { j, st, stateDir, date, config } = x;
  const policy = config.policy ?? 'gate-only';
  const intent = j.last('submit', 'intent');
  const pending = readPending(stateDir);
  if (intent && pending?.date === date) await follow(x, pending, config.poll.attempts);
  st.slot.decision = await slotNow(x);
  const { facts, view } = await recheckFacts(x, { inc, search, cand, plan, conf, req, gate });
  if (st.gate) st.gate.atDecision = view; // the verification the decision used (current pin), next to the gate-time one
  const base = { ...facts, mode: st.mode, slot: st.slot.decision, alreadySubmitted: Boolean(intent) || Boolean(readPending(stateDir)) };
  let flags = buildDecisionFlags(base, policy), used = facts, chosen = req;
  if (policy === 'daily-best' && decisionKind(flags) === 'incumbent-redraw') {
    chosen = st.redraw ?? null;
    used = { ...base, ...redrawFacts(x, { redraw: chosen }) };
    flags = buildDecisionFlags(used, policy);
    if (used.storedRequest?.problem) st.notes.push(`stored validated request: ${used.storedRequest.problem}`);
  }
  st.flags = flags;
  st.decision = decideSubmit(flags, policy);
  st.wouldSubmitInAuto = decideSubmit({ ...flags, modeAuto: true }, policy).submit;
  const kind = policy === 'daily-best' ? st.decision.kind : undefined;
  j.append('decide', 'done', { submit: st.decision.submit, reasons: st.decision.reasons, wouldSubmitInAuto: st.wouldSubmitInAuto,
    requestSha256: used.request?.sha256 ?? null, planHash: plan?.planHash ?? null, ...(kind ? { policy, kind } : {}) });
  if (intent) { // this date already POSTed (or tried): never again
    st.outcome = resumedOutcome(j, st);
    if (kind) { // the kind POSTed is the journaled one (an intent without a kind was a gate-only, i.e. promoted, POST)
      const posted = intent.kind ?? 'promoted';
      st.submission = { ...(st.submission ?? { submissionId: intent.submissionId }), kind: posted };
      if (posted !== kind) st.notes.push(`this date already POSTed ${intent.submissionId} as kind ${posted}; this rerun's recomputed decision kind (${kind}) is not what was submitted`);
    }
    return;
  }
  if (st.decision.submit) { await submit(x, chosen, kind); return; }
  // daily-best: neither a submittable promoted candidate nor a valid incumbent request -> a human decides
  const noIncumbentRequest = kind === 'incumbent-redraw' && st.decision.reasons.some(r => REDRAW_REQUEST_KEYS.includes(r));
  st.outcome = st.needsHuman || noIncumbentRequest ? 'needs-human' : cand ? 'skipped' : 'no-candidate';
}
