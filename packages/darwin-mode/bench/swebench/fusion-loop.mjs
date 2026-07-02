// SPDX-License-Identifier: MIT
//
// ADR-222 (Fusion prototype) — the DEVIN-FUSION-style loop: a strong "lead" agent + a cheap
// "sidekick" agent running together, plus a lightweight mid-session model router. This is the
// honest reproduction of cognition.com/blog/devin-fusion's two levers on HARD SWE-bench tasks:
//
//   (1) SIDEKICK DELEGATION — the lead (frontier model) keeps planning/decision/review authority
//       and DELEGATES a mechanical sub-task (wide grep, read many files, apply a decided edit) to a
//       cheap sidekick agent via the `delegate` tool. The sidekick is itself a full ReAct agent
//       (reuses agenticSolve on the SAME work tree), returns a summary, and the lead reviews it.
//   (2) MID-SESSION ROUTING — a small heuristic classifier switches the WORKING model of the lead
//       loop mid-trajectory: cheap by default for mechanical stretches, escalate to frontier on
//       repeated test-fail or thrash (Devin does the switch at context-compaction so it's "free";
//       we switch per-step, which is the simplest honest analog).
//
// Pure + dependency-injected like agentic-loop.mjs: solve-fusion.mjs wires the real fetchRepo/llm/
// evalOne; the unit test wires two scripted models + an in-memory tree. Cost is summed main+sidekick.

import { makeTools, parseAction, agenticSolve, stateHash, buildAgenticSystem } from './agentic-loop.mjs';

/**
 * Build the LEAD-agent system prompt: the agentic tool surface PLUS the `delegate` tool, framed so
 * the strong model keeps the reasoning and hands mechanical work to the sidekick. Byte-compatible
 * with buildAgenticSystem for the shared tools; only the delegate line + lead framing are added.
 */
export function buildFusionSystem(ext = 'py', glob = '*.py') {
  const base = buildAgenticSystem(ext, glob);
  const submitLine = '{"tool":"submit"}                      finalize your patch and stop';
  const delegateLine =
    '{"tool":"delegate","task":"<a SPECIFIC mechanical sub-task, e.g. \'grep every call site of foo() and list files+lines\' or \'apply this exact edit to bar.'
    + ext + '\'","max_steps":6}  hand a mechanical step to your CHEAP sidekick agent; it works on the same tree and returns a summary you then review\n'
    + submitLine;
  return base.replace(submitLine, delegateLine)
    + '\n\nYou are the LEAD agent — a strong model with planning, decision, and review authority. Do the HARD reasoning yourself '
    + '(root-cause the bug, decide the exact fix). DELEGATE bulk/mechanical work — wide greps, reading many files, applying an edit you have '
    + 'already fully decided — to your cheap sidekick via `delegate`, then REVIEW its result with run_tests before continuing. Prefer delegating '
    + 'a mechanical step over doing it yourself, but NEVER delegate the decision of what the fix should be.';
}

/**
 * Build the SIDEKICK sub-agent system prompt: the plain agentic surface (no delegate — sidekicks
 * don't sub-delegate) plus a note that it must do ONLY the delegated mechanical sub-task.
 */
export function buildSidekickSystem(ext = 'py', glob = '*.py') {
  return buildAgenticSystem(ext, glob)
    + '\n\nYou are a SIDEKICK sub-agent. The lead agent delegated ONE SPECIFIC mechanical sub-task (given as the problem below). '
    + 'Do ONLY that sub-task — gather the exact facts (read/grep/ls) or make the exact minimal edit requested, then submit. '
    + 'Do NOT redesign the fix, do NOT go beyond the delegated instruction, and do NOT edit test files.';
}

/**
 * The mid-session model router. Pure-ish: holds a tiny internal escalation state so a triggered
 * escalation stays "sticky" for a cooldown window (matching Devin's observation that switching too
 * often thrashes). decide() takes a signal snapshot and returns { model:'high'|'low', reason }.
 *
 *   leadSteps          first N steps run on the frontier (planning authority)
 *   escalateAfterFails  escalate to frontier once consecutiveTestFails reaches this
 *   cooldown           after an escalation, stay on frontier for this many steps
 *
 * Default policy: cheap by default (mechanical), frontier for the opening plan and whenever the loop
 * is in trouble (repeated failing tests, or thrash — an exact-repeat read/grep/ls).
 */
export function makeRouter(cfg = {}) {
  const { leadSteps = 2, escalateAfterFails = 2, cooldown = 3 } = cfg;
  let escalatedUntil = 0; // stay 'high' through this step index
  let lastThrash = 0;     // last thrash count we escalated on (edge-trigger)
  return {
    decide({ step, consecutiveTestFails = 0, thrash = 0 } = {}) {
      if (step <= escalatedUntil) return { model: 'high', reason: 'escalation-cooldown' };
      if (consecutiveTestFails >= escalateAfterFails) {
        escalatedUntil = step + cooldown;
        return { model: 'high', reason: `repeated-test-fail(${consecutiveTestFails})` };
      }
      if (thrash > lastThrash) { // a NEW thrash event since we last escalated
        lastThrash = thrash;
        escalatedUntil = step + cooldown;
        return { model: 'high', reason: 'thrash' };
      }
      if (step <= leadSteps) return { model: 'high', reason: 'lead-planning' };
      return { model: 'low', reason: 'mechanical-default' };
    },
    _state() { return { escalatedUntil, lastThrash }; },
  };
}

/**
 * Run the Fusion loop. Returns { patch, steps, submitted, resolvedInLoop, cost, mainCost, sideCost,
 * routeLog, delegations, modelSwitches, highSteps, lowSteps, thrash, transcript }.
 *
 *   problem        the SWE-bench problem statement
 *   io             the makeTools I/O contract (shared with agentic-loop.mjs), incl. runTests/gitDiff
 *   llmHigh        async (prompt, system, temp) => { raw, cost }   the frontier / lead model
 *   llmLow         async (prompt, system, temp) => { raw, cost }   the cheap / sidekick model
 *   router         a makeRouter() instance (default constructed)
 *   maxSteps       lead-loop step budget (default 20)
 *   sidekickSteps  per-delegation sidekick step budget (default 6)
 */
export async function fusionSolve({
  problem, io, llmHigh, llmLow, router, maxSteps = 20, sidekickSteps = 6,
  system, sidekickSystem, tempSchedule, onStep,
}) {
  const tools = makeTools(io);
  router = router || makeRouter();
  system = system || buildFusionSystem();
  sidekickSystem = sidekickSystem || buildSidekickSystem();

  const transcript = [];
  let submitted = false, resolvedInLoop = false;
  let mainCost = 0, sideCost = 0;
  let consecutiveTestFails = 0, thrash = 0;
  const routeLog = [];    // { step, model, reason }
  const delegations = []; // { step, task, steps, changed, resolvedInLoop, cost }
  const seenStates = new Set();

  // Run the cheap sidekick as its own bounded ReAct agent on the SAME work tree. It sees the current
  // diff state (edits persist), does the delegated mechanical task, and returns a review summary.
  async function runSidekick(task, subSteps) {
    const before = io.gitDiff();
    const r = await agenticSolve({
      problem: `DELEGATED SUB-TASK (from the lead agent — do ONLY this, then submit):\n${String(task || '').slice(0, 2500)}`,
      io, llm: llmLow, maxSteps: subSteps, system: sidekickSystem,
    });
    const after = io.gitDiff();
    return {
      cost: r.cost || 0, steps: r.steps, changed: after !== before,
      resolvedInLoop: r.resolvedInLoop,
      last: r.transcript.length ? r.transcript[r.transcript.length - 1].obs : '',
    };
  }

  const header = `--- problem statement ---\n${String(problem || '').slice(0, 6000)}\n`
    + '--- begin. You are the LEAD agent: plan, review, and DELEGATE mechanical steps to your sidekick. Output ONE JSON action. ---';

  for (let step = 1; step <= maxSteps && !submitted; step++) {
    const decision = router.decide({ step, maxSteps, consecutiveTestFails, thrash });
    routeLog.push({ step, model: decision.model, reason: decision.reason });
    const llm = decision.model === 'high' ? llmHigh : llmLow;

    const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-12000);
    let raw = '';
    try {
      const r = await llm(convo, system, tempSchedule ? tempSchedule(step, maxSteps) : undefined);
      raw = r.raw; mainCost += r.cost || 0;
    } catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }

    const action = parseAction(raw);
    let obs;
    if (action.tool === 'submit') { submitted = true; obs = 'submitted.'; }
    else if (action.tool === 'delegate') {
      const budget = action.max_steps ? Math.max(1, Math.min(action.max_steps | 0, sidekickSteps * 2)) : sidekickSteps;
      const sk = await runSidekick(action.task, budget);
      sideCost += sk.cost;
      if (sk.resolvedInLoop) resolvedInLoop = true;
      delegations.push({ step, task: String(action.task || '').slice(0, 300), steps: sk.steps, changed: sk.changed, resolvedInLoop: sk.resolvedInLoop, cost: sk.cost });
      obs = `sidekick ran ${sk.steps} step(s); ${sk.changed ? 'applied edits' : 'no edits'}; tests ${sk.resolvedInLoop ? 'PASS ✓' : 'not passing'}.\n`
        + `sidekick's last observation:\n${String(sk.last).slice(0, 900)}\n`
        + 'Review this result: verify with run_tests, refine/delegate again, or submit if the fix is complete.';
    }
    else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
    else if (tools[action.tool]) {
      obs = tools[action.tool](action);
      if (action.tool === 'run_tests') {
        if (/ALL TARGET TESTS PASS/.test(obs)) { resolvedInLoop = true; consecutiveTestFails = 0; }
        else if (!/no edits applied yet/.test(obs)) consecutiveTestFails++;
      }
    }
    else obs = `error: unknown tool "${action.tool}". Valid: ls, read, grep, edit, line_edit, run_tests, delegate, submit.`;

    // Anti-thrash (same convention as agentic-loop.mjs) — an exact-repeat navigation state bumps
    // the thrash counter, which the router uses as an escalation trigger.
    if (['read', 'grep', 'ls'].includes(action.tool)) {
      const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
      if (seenStates.has(h)) { thrash++; obs += '\n⚠️ SYSTEM: you already ran this exact action and got this exact result — change strategy (edit / run_tests / delegate) or submit.'; }
      else seenStates.add(h);
    }

    const actionRaw = JSON.stringify(action.tool === 'noop' ? { raw: raw.slice(0, 200) } : action).slice(0, 400);
    transcript.push({ actionRaw, obs });
    if (onStep) onStep(step, action, obs, decision);
  }

  const modelSwitches = routeLog.reduce((n, r, i) => n + (i > 0 && r.model !== routeLog[i - 1].model ? 1 : 0), 0);
  const highSteps = routeLog.filter((r) => r.model === 'high').length;
  return {
    patch: io.gitDiff(), steps: transcript.length, submitted, resolvedInLoop,
    cost: mainCost + sideCost, mainCost, sideCost,
    routeLog, delegations, modelSwitches, highSteps, lowSteps: routeLog.length - highSteps, thrash, transcript,
  };
}
