// SPDX-License-Identifier: MIT
//
// ADR-226 (Advisor-loop) — the INVERSION of the fusion prototype: the CHEAP model runs the entire
// agentic loop and emits every tool action; the STRONG model is a READ-ONLY advisor that never
// enters the tool protocol at all. It receives problem + full transcript + current diff as a single
// stateless completion and replies in plain prose (critique, root-cause check, next 1-3 concrete
// actions, and a pre-submit APPROVE/REVISE verdict). Because the strong model never emits a tool
// call, the tool-call-format confound (FUSION-BENCHMARK arm A: 8/8 empty patches) is STRUCTURALLY
// absent on the frontier path, not merely mitigated.
//
// Three bounded trigger paths (ADR-226 §3.5):
//   1. VOLUNTARY  — the cheap agent calls {"tool":"advise","question":...}   (capped maxAdvisories)
//   2. CHECKPOINT — involuntary gate on the same signals fusion used for escalation
//                   (repeated test-fail, thrash), with a cooldown             (counts vs maxAdvisories)
//   3. PRE-SUBMIT — mandatory review of every non-empty-diff submit, bounded veto (maxVetoes),
//                   vetoed diffs snapshotted for counterfactual gold-scoring   (NOT vs maxAdvisories)
//
// Pure + dependency-injected like agentic-loop.mjs / fusion-loop.mjs: no fs/network of its own;
// solve-advisor.mjs wires the real fetchRepo/llm/Docker; advisor-loop.test.mjs wires mocks ($0).
// Deliberately NOT an extension of fusionSolve (§3.1): the control flow is the exact inverse
// (one cheap actor; no router/delegate/sidekick machinery), and arm C must stay frozen.
// `agentic-loop.mjs` and `fusion-loop.mjs` are untouched.

import { makeTools, parseAction, stateHash, buildAgenticSystem } from './agentic-loop.mjs';

/**
 * Build the CHEAP-loop system prompt: the agentic tool surface PLUS the `advise` tool, inserted
 * with the exact buildFusionSystem idiom (replace the submit line with advise line + submit line),
 * plus the advisor framing. Shared verbatim by arms D and D-self (§3.2) so the D-vs-D-self
 * comparison is clean on advisor-model identity; arm D0 runs the unmodified buildAgenticSystem.
 */
export function buildAdvisedSystem(ext = 'py', glob = '*.py') {
  const base = buildAgenticSystem(ext, glob);
  const submitLine = '{"tool":"submit"}                      finalize your patch and stop';
  const adviseLine =
    '{"tool":"advise","question":"<what you are unsure about — the plan, the root cause, or whether your fix is right>"}  '
    + 'consult your STRONG read-only advisor; it sees your full transcript + current diff and replies with guidance';
  return base.replace(submitLine, adviseLine + '\n' + submitLine)
    + '\n\nYou are a fast agent with a STRONG senior ADVISOR on call. The advisor cannot run tools or edit — it only '
    + 'critiques. Consult it when uncertain about the plan, the root cause, or fix correctness — never for mechanical '
    + 'steps you can just do. Its reply is guidance; YOU still choose and execute every action. Your final submit is '
    + 'automatically reviewed by the advisor.';
}

/**
 * Build the ADVISOR system prompt (§3.3). Free prose is the point: the frontier tool-call-format
 * confound structurally cannot occur on this path.
 */
export function buildAdvisorSystem(ext = 'py') {
  return 'You are a READ-ONLY senior engineer reviewing an autonomous junior bug-fixing agent mid-task. You will '
    + 'receive: the problem statement, the agent\'s full action/observation transcript, the current working-tree diff, '
    + 'and a PHASE tag. You cannot execute tools or edit files, and you must NOT output JSON tool calls — reply in '
    + 'plain prose, ≤300 words: (1) is the diagnosis/root-cause right? (2) is the diff correct, minimal, '
    + `non-test-touching? (3) the exact next 1-3 actions (file, line, what to change — e.g. which .${ext} file). `
    + 'Reference only files present in the transcript or diff. If PHASE is pre-submit, your FIRST line must be '
    + 'exactly `VERDICT: APPROVE` or `VERDICT: REVISE — <one-line reason>`.';
}

/**
 * The involuntary-checkpoint policy (§3.5.2) — mirrors makeRouter's priority/edge-trigger semantics
 * (fusion-loop.mjs) with two deliberate deviations: cooldown defaults to 4 (fusion's is 3) because
 * an advisor call costs more than one escalated cheap step, and there is NO leadSteps analogue —
 * the opening plan stays cheap. decide() returns { consult, reason }; `_state()` is exposed for
 * tests. Suppressed while step <= advisedUntil; fails >= threshold consults + sets the cooldown;
 * a NEW thrash event (thrash > lastThrash) consults + sets the cooldown (edge-trigger).
 */
export function makeAdvisorGate(cfg = {}) {
  const { adviseAfterFails = 2, adviseOnThrash = true, cooldown = 4 } = cfg;
  let advisedUntil = 0; // suppress consults through this step index
  let lastThrash = 0;   // last thrash count we consulted on (edge-trigger)
  return {
    decide({ step, consecutiveTestFails = 0, thrash = 0 } = {}) {
      if (step <= advisedUntil) return { consult: false, reason: 'advisor-cooldown' };
      if (consecutiveTestFails >= adviseAfterFails) {
        advisedUntil = step + cooldown;
        return { consult: true, reason: `repeated-test-fail(${consecutiveTestFails})` };
      }
      if (adviseOnThrash && thrash > lastThrash) { // a NEW thrash event since we last consulted
        lastThrash = thrash;
        advisedUntil = step + cooldown;
        return { consult: true, reason: 'thrash' };
      }
      return { consult: false, reason: 'no-signal' };
    },
    _state() { return { advisedUntil, lastThrash }; },
  };
}

/**
 * Serialize the advisor's view (§3.4). The advisor deliberately sees MORE than the loop's 12k-char
 * sliding window (a designed asymmetry): the FULL transcript is replayed with each observation
 * re-capped to `obsChars`; if the transcript section exceeds `maxChars`, keep the first 2 entries
 * (head anchors the plan) + as many tail entries as fit (tail is current state) with an
 * `…[elided N steps]` marker. Diff is head-capped at `diffChars` with a truncation note.
 * Hard bound: the returned prompt NEVER exceeds 38,000 chars (≈ 8-13k input tokens) — the number
 * §5's cost model is derived from. Conformance (§8): this function takes ONLY problem/transcript/
 * diff inputs — under --no-test-oracle nothing gold can reach the advisor through it.
 */
export function buildAdvisorPrompt({
  problem, transcript = [], diff = '', phase = 'consult', reason, question,
  maxChars = 24000, diffChars = 8000, obsChars = 1200,
} = {}) {
  const HARD_CAP = 38000;
  const capObs = (s) => { const t = String(s ?? ''); return t.length > obsChars ? t.slice(0, obsChars) + `\n…[obs truncated ${t.length - obsChars} chars]` : t; };
  const problemPart = `--- problem statement ---\n${String(problem || '').slice(0, 6000)}`;
  const d = String(diff || '');
  const diffPart = '--- current diff ---\n'
    + (d.length > diffChars ? d.slice(0, diffChars) + `\n…[diff truncated ${d.length - diffChars} chars]` : (d || '(no edits yet)'));
  let phasePart = `PHASE: ${phase === 'checkpoint' ? `checkpoint(${reason || ''})` : phase}`;
  if (phase === 'consult' && question) phasePart += `\nAGENT'S QUESTION: ${String(question).slice(0, 500)}`;
  // Transcript budget: the configured maxChars, further squeezed so the WHOLE prompt stays ≤38k.
  const overhead = problemPart.length + diffPart.length + phasePart.length + '--- agent transcript ---\n'.length + 4; // joining newlines
  const budget = Math.max(0, Math.min(maxChars, HARD_CAP - overhead));
  const entries = transcript.map((t) => `>>> ${t.actionRaw}\n${capObs(t.obs)}`);
  let body;
  const full = entries.join('\n');
  if (full.length <= budget) body = full;
  else {
    const head = entries.slice(0, 2);
    const headLen = head.join('\n').length;
    const tail = [];
    let tailLen = 0;
    const markerRoom = 30; // '…[elided N steps]' + newlines
    for (let i = entries.length - 1; i >= 2; i--) {
      const add = entries[i].length + 1;
      if (headLen + markerRoom + tailLen + add > budget) break;
      tail.unshift(entries[i]); tailLen += add;
    }
    const elided = entries.length - head.length - tail.length;
    body = [...head, `…[elided ${elided} steps]`, ...tail].join('\n');
  }
  return `${problemPart}\n--- agent transcript ---\n${body}\n${diffPart}\n${phasePart}`;
}

/**
 * Run the advised cheap loop (§3.5-§3.6). The cheap model (`llmLow`) emits every tool action; the
 * strong model (`llmAdvisor`) is consulted read-only via the three trigger paths and is ALWAYS
 * called with temp=0. `llmAdvisor: null` runs the pure-cheap D0 mode: unmodified buildAgenticSystem
 * prompt, zero advisor calls, advisorCost=0 — same code path otherwise (§4.1).
 *
 * Both llms keep the contract async (prompt, system, temp) => { raw, cost }.
 * Advisor errors are NON-FATAL (§3.6): a failed consult becomes an '(advisor unavailable: …)'
 * observation and a failed pre-submit review counts as APPROVE (fail-open — resolve rate before
 * cost). llmLow errors break the loop, exactly as in agenticSolve/fusionSolve.
 *
 * Step accounting (§3.5, pre-registered §4.6): `advise` and a vetoed `submit` are ordinary
 * transcript entries counted against maxSteps; no extra loop steps are granted. Extra LLM calls are
 * the advisor calls themselves, hard-capped at maxAdvisories + maxVetoes + 1 per instance.
 *
 * Returns { patch, steps, submitted, resolvedInLoop, cost, loopCost, advisorCost, advisories,
 *   vetoes, vetoedPatches, executorActions, thrash, transcript } — executorActions = count of
 *   non-advise, non-vetoed-submit actions (§4.6's step-budget disambiguation).
 */
export async function advisorSolve({
  problem, io, llmLow, llmAdvisor, gate, maxSteps = 20,
  system, advisorSystem, tempSchedule, onStep, onAdvice,
  maxAdvisories = 4, maxVetoes = 2, adviceChars = 1600, advisorMaxChars = 24000,
}) {
  const tools = makeTools(io);
  const d0 = !llmAdvisor;                          // D0 mode: no advisor at all
  system = system || (d0 ? buildAgenticSystem() : buildAdvisedSystem());
  advisorSystem = advisorSystem || buildAdvisorSystem();
  gate = gate || makeAdvisorGate();

  const transcript = [];
  const advisories = [];      // { step, trigger, reason, question?, verdict?, promptChars, cost, advice }
  const vetoedPatches = [];   // { step, diff } — snapshots for §4.7's counterfactual gold-scoring
  let submitted = false, resolvedInLoop = false;
  let loopCost = 0, advisorCost = 0;
  let consecutiveTestFails = 0, thrash = 0;
  let vetoes = 0, budgetUsed = 0, executorActions = 0;
  const seenStates = new Set();

  // One stateless completion over problem + transcript + diff. Advisor temp is ALWAYS 0.
  async function consult(phase, reason, question) {
    const prompt = buildAdvisorPrompt({ problem, transcript, diff: io.gitDiff(), phase, reason, question, maxChars: advisorMaxChars });
    const r = await llmAdvisor(prompt, advisorSystem, 0);
    const cost = r.cost || 0;
    advisorCost += cost;
    return { advice: String(r.raw ?? ''), promptChars: prompt.length, cost };
  }

  const header = `--- problem statement ---\n${String(problem || '').slice(0, 6000)}\n--- begin. Output ONE JSON action. ---`;
  for (let step = 1; step <= maxSteps && !submitted; step++) {
    const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-12000);
    let raw = '';
    try { const r = await llmLow(convo, system, tempSchedule ? tempSchedule(step, maxSteps) : undefined); raw = r.raw; loopCost += r.cost || 0; }
    catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
    const action = parseAction(raw);
    let obs;
    let executor = true; // flips false for advise + vetoed submit only

    if (action.tool === 'advise' && !d0) {
      // 1. VOLUNTARY consult — capped by maxAdvisories (shared with checkpoint consults).
      executor = false;
      if (budgetUsed >= maxAdvisories) obs = `advisor budget exhausted (${maxAdvisories}) — proceed with your best judgment`;
      else {
        budgetUsed++;
        try {
          const c = await consult('consult', undefined, action.question);
          advisories.push({ step, trigger: 'advise', reason: 'voluntary', question: String(action.question || '').slice(0, 500), promptChars: c.promptChars, cost: c.cost, advice: c.advice.slice(0, 400) });
          obs = `ADVISOR:\n${c.advice.slice(0, adviceChars)}\n(Guidance only — you execute the actions.)`;
          if (onAdvice) onAdvice(step, 'advise', c.advice);
        } catch (e) { obs = `(advisor unavailable: ${String(e.message || e)})`; }
      }
    } else if (action.tool === 'submit') {
      // 3. MANDATORY pre-submit review (§3.5.3) — skipped in D0, on an empty diff, or once the
      // veto budget is spent (no infinite veto loop). NOT counted against maxAdvisories.
      const diff = io.gitDiff();
      if (d0 || !diff.trim() || vetoes >= maxVetoes) { submitted = true; obs = 'submitted.'; }
      else {
        let verdictAdvice = null;
        try { verdictAdvice = await consult('pre-submit'); }
        catch { /* advisor failure on pre-submit counts as APPROVE (§3.6, fail-open) */ }
        if (verdictAdvice === null) { submitted = true; obs = 'submitted.'; }
        else {
          const c = verdictAdvice;
          // First line must be VERDICT: APPROVE or VERDICT: REVISE — anything else is an
          // unparseable verdict and defaults to APPROVE (fail-open, §3.5).
          const revise = /^\s*VERDICT:\s*REVISE/i.test(c.advice);
          const approve = /^\s*VERDICT:\s*APPROVE/i.test(c.advice);
          advisories.push({ step, trigger: 'pre-submit', reason: 'pre-submit', verdict: approve ? 'APPROVE' : revise ? 'REVISE' : 'unparseable→APPROVE', promptChars: c.promptChars, cost: c.cost, advice: c.advice.slice(0, 400) });
          if (onAdvice) onAdvice(step, 'pre-submit', c.advice);
          if (revise) {
            vetoes++;
            vetoedPatches.push({ step, diff }); // snapshot BEFORE any post-veto edits (§4.7)
            executor = false;
            obs = `submit VETOED by advisor (${vetoes}/${maxVetoes}):\n${c.advice.slice(0, adviceChars)}\nAddress this, run_tests, then submit again.`;
          } else { submitted = true; obs = 'submitted.'; }
        }
      }
    } else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
    else if (tools[action.tool]) {
      obs = tools[action.tool](action);
      if (action.tool === 'run_tests') {
        if (/ALL TARGET TESTS PASS/.test(obs)) { resolvedInLoop = true; consecutiveTestFails = 0; }
        else if (!/no edits applied yet/.test(obs)) consecutiveTestFails++;
      }
      // Anti-thrash (same convention as agentic-loop.mjs) — bumps the thrash counter the gate
      // uses as its edge-trigger signal, so it MUST run before gate.decide below.
      if (['read', 'grep', 'ls'].includes(action.tool)) {
        const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
        if (seenStates.has(h)) { thrash++; obs += '\n⚠️ SYSTEM: You already ran this exact action and got this exact result. Stop repeating — change your strategy (read a different file / edit / run_tests) or submit.'; }
        else seenStates.add(h);
      }
      // 2. INVOLUNTARY CHECKPOINT — the gate runs AFTER the normal tool obs is computed (§3.5.2).
      // Same signals fusion used for escalation; judgment injection instead of model swap.
      // Counts against maxAdvisories.
      if (!d0) {
        const dec = gate.decide({ step, consecutiveTestFails, thrash });
        if (dec.consult && budgetUsed < maxAdvisories) {
          budgetUsed++;
          try {
            const c = await consult('checkpoint', dec.reason);
            advisories.push({ step, trigger: 'checkpoint', reason: dec.reason, promptChars: c.promptChars, cost: c.cost, advice: c.advice.slice(0, 400) });
            obs += `\n📋 ADVISOR (checkpoint: ${dec.reason}):\n${c.advice.slice(0, adviceChars)}`;
            if (onAdvice) onAdvice(step, 'checkpoint', c.advice);
          } catch (e) { obs += `\n(advisor unavailable: ${String(e.message || e)})`; }
        }
      }
    } else obs = `error: unknown tool "${action.tool}". Valid: ls, read, grep, edit, line_edit, run_tests, ${d0 ? '' : 'advise, '}submit.`;

    if (executor) executorActions++;
    const actionRaw = JSON.stringify(action.tool === 'noop' ? { raw: raw.slice(0, 200) } : action).slice(0, 400);
    transcript.push({ actionRaw, obs });
    if (onStep && onStep(step, action, obs) === 'stop') break;
  }

  return {
    patch: io.gitDiff(), steps: transcript.length, submitted, resolvedInLoop,
    cost: loopCost + advisorCost, loopCost, advisorCost,
    advisories, vetoes, vetoedPatches, executorActions, thrash, transcript,
  };
}
