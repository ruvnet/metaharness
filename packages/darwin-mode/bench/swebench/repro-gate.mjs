// SPDX-License-Identifier: MIT
//
// ADR-195 Phase-2 #2 — REPRODUCTION-FIRST gate (production).
//
// The conformant analog of Test-Driven Repair (ADR-175, TDR's 68.3% lever) and a STRONGER version of
// §44's weak repro-gate. The flow:
//   1. WRITE   generate a failing `reproduce_bug.py` from the issue (reuses test-critic.buildReproTest:
//              a VALID repro must FAIL on the unmodified buggy repo — that's the "captures the bug"
//              check). Conformant: deps present in the base Docker env, NO gold tests.
//   2. ITERATE run the agentic solve loop; after each candidate patch, run the SELF-WRITTEN repro
//              against the patched tree. If it passes → done (the agent verified its own fix). If it
//              still fails, feed the repro trace back and let the agent iterate, for a BOUNDED number
//              of rounds.
//   3. GATE    the resolution signal is "the self-written repro now passes" — never the gold test.
//
// This module is PURE + dependency-injected: the repro writer, the solve-one-round function, and the
// repro RUNNER are all injected, so the control flow (write → iterate → gate, with round bounding and
// trace feedback) is unit-tested offline with NO network / NO Docker. `solve-agentic.mjs` wires the
// real buildReproTest + a single agentic round + runConformantTests when `--repro-gate` is set.

/**
 * Run the reproduction-first loop.
 *
 * Injected dependencies:
 *   writeRepro    async () => { valid:boolean, repro:string, cost:number, ... }
 *                 Generate+validate the failing reproduce_bug.py (test-critic.buildReproTest).
 *   solveRound    async ({ round, reproTrace, prevPatch }) => { patch:string, cost?:number, resolvedInLoop?:boolean }
 *                 One agentic solve round. `reproTrace` is the previous round's repro failure trace
 *                 (empty on round 1); `prevPatch` is the last candidate (for resume/diff context).
 *   runRepro      ({ patch, repro }) => { ran:boolean, passed:boolean, logTail:string }
 *                 Run the self-written repro against the patched tree (conformant — no gold test).
 *
 * Options: { maxRounds=3 }
 *
 * Returns:
 *   { patch, reproValid, reproPassed, rounds, cost, history }
 *   - reproValid : the writer produced a repro that fails on the buggy code (the gate is ARMED).
 *   - reproPassed: a candidate patch made the self-written repro pass (the gate FIRED).
 *   - patch      : the patch that passed the repro, else the last candidate (best-effort).
 *
 * Honesty: if the writer can't produce a valid repro, the gate cannot arm — we fall back to a single
 * plain solve round and report reproValid=false (so the caller knows the gate didn't actually run).
 */
export async function reproGateSolve({ writeRepro, solveRound, runRepro, maxRounds = 3 } = {}) {
  let cost = 0;
  const history = [];

  const rb = await writeRepro();
  cost += rb.cost || 0;
  // ADR-175 §63 / #47: carry the non-gating symptom-binding confidence through so run reports can
  // record how well the self-written repro binds to the issue's symptom (undefined if the writer
  // didn't compute it, e.g. an invalid repro).
  const symptomBinding = rb.symptomBinding;

  // Gate could not arm — no valid failing repro. Do ONE plain solve round so we still return a patch,
  // and report reproValid=false so this instance is not counted as repro-gated.
  if (!rb.valid) {
    const r = await solveRound({ round: 1, reproTrace: '', prevPatch: '' });
    cost += r.cost || 0;
    history.push({ round: 1, repro: 'invalid', resolvedInLoop: !!r.resolvedInLoop });
    return { patch: r.patch || '', reproValid: false, reproPassed: false, rounds: 1, cost, history, symptomBinding };
  }

  const repro = rb.repro;
  let prevPatch = '';
  let reproTrace = '';
  let lastPatch = '';

  for (let round = 1; round <= maxRounds; round++) {
    const r = await solveRound({ round, reproTrace, prevPatch });
    cost += r.cost || 0;
    lastPatch = r.patch || lastPatch;
    prevPatch = r.patch || prevPatch;

    // No edits this round — nothing to verify; stop (avoid burning rounds on an empty diff).
    if (!r.patch || !r.patch.trim()) {
      history.push({ round, emptyPatch: true, reproPassed: false });
      break;
    }

    const rr = runRepro({ patch: r.patch, repro });
    const passed = !!(rr.ran && rr.passed);
    history.push({ round, ran: !!rr.ran, reproPassed: passed, resolvedInLoop: !!r.resolvedInLoop });
    if (passed) {
      return { patch: r.patch, reproValid: true, reproPassed: true, rounds: round, cost, history, symptomBinding };
    }
    // Feed the repro failure trace back so the next round iterates toward making the repro pass.
    reproTrace = (rr.logTail || '').slice(-2500);
  }

  return { patch: lastPatch, reproValid: true, reproPassed: false, rounds: history.length, cost, history, symptomBinding };
}

/**
 * Build the feedback block appended to the agent's context describing the self-written repro test and
 * (after round 1) its failure trace. Pure — used by solve-agentic.mjs's solveRound wiring so the agent
 * iterates against ITS OWN repro (not the gold test).
 */
export function reproFeedbackBlock(repro, reproTrace) {
  const parts = [
    '--- REPRODUCTION TEST (self-written from the issue — your fix must make THIS pass) ---',
    '```python',
    String(repro || '').slice(0, 4000),
    '```',
  ];
  if (reproTrace && reproTrace.trim()) {
    parts.push(
      '--- the reproduction test is STILL FAILING on your current patch; trace: ---',
      String(reproTrace).slice(0, 2000),
      'Iterate your fix until the reproduction test above passes.',
    );
  }
  parts.push('--- end reproduction context ---');
  return parts.join('\n');
}
