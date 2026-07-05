// D1-S1 (self-learning scale loop) — the SWE-bench code-repair Evaluator for @metaharness/flywheel.
//
// Bridges a flywheel POLICY (operating-policy levers) + a holdout of SWE-bench instances → a flywheel
// `Score`, so `runFlywheelGenerations` can compound operating-policy improvements on the REAL code-repair
// domain (not the arithmetic reasoning proxy). The whole point of @metaharness/flywheel's injected
// Evaluator seam: everything SWE-bench-specific lives HERE, never in the flywheel core.
//
// The two expensive halves are INJECTED so this stays testable at $0 and the real (network + Docker)
// pieces wire in only for the budgeted live run (D1-S4):
//   • runSolver(policy, instances) -> [{ instance_id, model_patch, costUsd? }]
//       REAL = wrap bench/swebench/solve.mjs (the cheap-model search-replace solver, `--base-url`),
//       shaping its prompts from the policy levers. The solver NEVER runs tests.
//   • gradePredictions(predictions) -> { resolvedIds: string[] }
//       REAL = the OFFICIAL `swebench` Docker harness (test execution + resolved scoring). This adapter
//       NEVER re-implements resolved-scoring — a gold score comes only from the official harness.
//
// The Score projection (the honest mapping onto the flywheel's four abstract axes):
//   primary    = # resolved (tests pass)                      — higher better
//   noopRate   = fraction of EMPTY/no-op patches (model gave up) — lower better (the cand-6 signal)
//   costPerWin = $ per resolved instance                       — lower better
//   regressed  = false (no safety-regression signal in SWE-bench; reserved for a red/blue gate)

/** An empty/no-op patch = the solver committed nothing (gave up). Default predicate. */
export function isEmptyPatch(p) {
  return !p || typeof p.model_patch !== 'string' || p.model_patch.trim().length === 0;
}

/**
 * Build a @metaharness/flywheel `Evaluator` over SWE-bench. `runSolver` + `gradePredictions` are the
 * only domain seams. Returns `(policy, suite) => Promise<Score>`.
 */
export function makeSwebenchEvaluator({ runSolver, gradePredictions, emptyPatch = isEmptyPatch }) {
  if (typeof runSolver !== 'function') throw new Error('makeSwebenchEvaluator: runSolver is required');
  if (typeof gradePredictions !== 'function') throw new Error('makeSwebenchEvaluator: gradePredictions is required');

  return async function swebenchEvaluate(policy, suite) {
    const instances = suite.items;
    const predictions = await runSolver(policy, instances);
    const { resolvedIds } = await gradePredictions(predictions);
    const resolved = new Set(resolvedIds);

    const n = Math.max(1, predictions.length);
    const empties = predictions.filter((p) => emptyPatch(p)).length;
    const totalCost = predictions.reduce((s, p) => s + (Number(p.costUsd) || 0), 0);
    const wins = predictions.filter((p) => resolved.has(p.instance_id)).length;

    return {
      primary: wins,
      // cost PER WIN: with zero resolved, cost-per-win is the WORST possible (you spent and won
      // nothing) — a large sentinel, NOT the raw spend. Otherwise a policy that resolves nothing looks
      // artificially "cheap" and blocks every real gain on the cost axis.
      noopRate: empties / n,
      costPerWin: wins > 0 ? totalCost / wins : 999,
      regressed: false,
    };
  };
}

/**
 * Build a @metaharness/flywheel `Proposer` for SWE-bench operating-policy levers. Frontier call that
 * improves ONE lever's text. INJECTED `complete(model, prompt) -> text`. (Real = an OpenRouter/cognitum
 * chat call; mock in tests.) The proposer is domain-flavored only in its PROMPT — the flywheel core
 * never sees it.
 */
export function makeSwebenchProposer({ complete, proposerModel }) {
  return async function swebenchPropose(base, target) {
    const current = base.policy?.[target] ?? '(none)';
    const prompt =
      `You optimize a cheap code-repair agent's OPERATING POLICY so it resolves more SWE-bench ` +
      `instances (tests pass) and gives up less often (fewer empty patches). Improve ONLY its "${target}" ` +
      `— one concrete, generalizable instruction (e.g. "always emit a minimal search/replace edit to the ` +
      `most-relevant file before the step budget ends; never return an empty patch"). Current "${target}":\n` +
      `${current}\n\nReturn ONLY the improved policy text, no preamble.`;
    const text = await complete(proposerModel, prompt);
    return (text || '').trim() || current;
  };
}
