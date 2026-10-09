// Late flywheel phases (no GPU): render + pre-submit checks, the signed gate, the pure decision, the single
// guarded submission and its follow-up. `x` is the run context built by flywheel.mjs runFlywheel().
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from './canonical-json.mjs';
import { buildDecisionFlags, decideSubmit } from './decide.mjs';
import { clearPending, genomeToTasks, readPending, submissionIdFor, tasksMatch, writeIncumbent, writePending } from './incumbent.mjs';
import { readJson, redact, runStep, writeJsonAtomic } from './journal.mjs';
import { recheckFacts } from './recheck.mjs';

export const QUOTA_FALLBACK_S = 24 * 3600; // a 429 without retry_after_s: the arena's own rolling window

/** Render the request for `genome` with the env lane's renderer and run every pre-submit check on it. */
export function renderPhase(x, renderedFor, genome, contextTokens) {
  const { config, deps, j, date } = x;
  return runStep(j, `render-${renderedFor}`, async () => {
    const tasks = genomeToTasks(genome, { genomeToCells: deps.darwin.cells.genomeToCells, contextTokens, taskLimits: config.submission.taskLimits });
    const v2 = renderedFor !== 'candidate';
    const submissionId = submissionIdFor({ prefix: config.submission.idPrefix, date, tasks, image: config.image, tag: v2 ? 'v2' : '' });
    const name = `${config.submission.namePrefix} ${date}${v2 ? ' (v2 defaults)' : ''}`;
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
      writeIncumbent(stateDir, { genome: pending.genome, submissionId: pending.submissionId, requestSha256: pending.requestSha256, date: pending.date, state });
      clearPending(stateDir);
      j.append('incumbent', 'updated', { submissionId: pending.submissionId, requestSha256: pending.requestSha256 });
      return state;
    }
    if (state === 'rejected') { clearPending(stateDir); j.append('incumbent', 'unchanged', { reason: 'rejected', submissionId: pending.submissionId }); return state; }
    if (state === 'absent' && neverPosted(pending)) { // crashed before arena-api.mjs persisted `sending`: nothing was sent
      clearPending(stateDir); j.append('submit', 'never-sent', { submissionId: pending.submissionId }); return state;
    }
  }
  writePending(stateDir, { ...pending, state: st.submission?.state ?? pending.state });
  return st.submission?.state ?? pending.state;
}

async function submit(x, req) {
  const { deps, j, st, stateDir, date } = x;
  const receiptPath = join(x.runDir, 'submit', 'arena-receipt.json');
  // The genome the POSTed request was rendered from (decide.mjs candidateMatchesPlan proved it is the candidate).
  const pending = { date, submissionId: req.submissionId, requestSha256: req.requestSha256, genome: req.genome, receiptPath, state: 'sending' };
  writePending(stateDir, pending); // before the POST: a crash is reconciled by the next run, never re-POSTed
  j.append('submit', 'intent', { submissionId: req.submissionId, requestSha256: req.requestSha256 });
  let r;
  try { r = await deps.arena.submit({ request: readJson(req.requestPath), approvedSha256: req.requestSha256, receiptPath }); } catch (e) {
    st.submission = { submissionId: req.submissionId, posted: null, state: 'unknown', error: redact(e?.message) };
    j.append('submit', 'error', { error: st.submission.error });
    st.outcome = 'submit-unknown';
    return;
  }
  st.submission = { submissionId: req.submissionId, posted: r?.post_attempted === true, receiptState: r?.state ?? null,
    state: r?.arena?.state ?? null, httpStatus: r?.http_status ?? null, code: r?.error_code ?? null, retryAfterS: r?.retry_after_s ?? null };
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
 *  every condition holds. Resumed phase results are file locations here, never verdicts. */
export async function decideAndSubmit(x, { inc, search, cand, plan, conf, req, gate }) {
  const { j, st, stateDir, date, config } = x;
  const intent = j.last('submit', 'intent');
  const pending = readPending(stateDir);
  if (intent && pending?.date === date) await follow(x, pending, config.poll.attempts);
  st.slot.decision = await slotNow(x);
  const { facts, view } = await recheckFacts(x, { inc, search, cand, plan, conf, req, gate });
  if (st.gate) st.gate.atDecision = view; // the verification the decision used (current pin), next to the gate-time one
  const flags = buildDecisionFlags({ ...facts, mode: st.mode, slot: st.slot.decision,
    alreadySubmitted: Boolean(intent) || Boolean(readPending(stateDir)) });
  st.flags = flags;
  st.decision = decideSubmit(flags);
  st.wouldSubmitInAuto = decideSubmit({ ...flags, modeAuto: true }).submit;
  j.append('decide', 'done', { submit: st.decision.submit, reasons: st.decision.reasons, wouldSubmitInAuto: st.wouldSubmitInAuto,
    requestSha256: facts.request?.sha256 ?? null, planHash: plan?.planHash ?? null });
  if (intent) { st.outcome = resumedOutcome(j, st); return; } // this date already POSTed (or tried): never again
  if (st.decision.submit) { await submit(x, req); return; }
  st.outcome = st.needsHuman ? 'needs-human' : cand ? 'skipped' : 'no-candidate';
}
