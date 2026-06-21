// SPDX-License-Identifier: MIT
//
// The parent-vs-child benchmark runner (ADR-076). Reuses the SAME secure sandbox
// (gate-first, shell-free, env-scrubbed — ADR-071) to run each task's public,
// hidden, and regression commands, scores the result, and decides promotion with
// the statistical gate. This is the headline: "benchmark the parent vs the
// child, not the idea."
import { runVariantTask } from '../sandbox.js';
import { scoreBenchmark } from './score.js';
import { decidePromotion } from './promotion.js';
import { verifySuite } from './suite.js';
/**
 * Run ONE variant against ONE task in the sandbox and score it. The three test
 * commands run with the variant's directory gate-checked first; any blocked
 * action surfaces as a safety violation (and the command never runs).
 */
export async function runTaskForVariant(variant, profile, task, opts = {}) {
    const at = (testCommand, label) => runVariantTask({ ...variant }, { ...profile, testCommand }, `${task.id}:${label}`, {
        taskTimeoutMs: task.timeoutMs,
    });
    const pub = await at(task.publicTestCommand, 'public');
    const hidden = await at(task.hiddenTestCommand, 'hidden');
    const regression = await at(task.regressionTestCommand, 'regression');
    const safetyViolations = [
        ...pub.blockedActions,
        ...hidden.blockedActions,
        ...regression.blockedActions,
    ];
    const publicTestPassed = pub.exitCode === 0;
    const hiddenTestPassed = hidden.exitCode === 0;
    const regressionPassed = regression.exitCode === 0;
    // Real wall-clock, RECORDED for observability but NOT fed into the score.
    const durationMs = pub.durationMs + hidden.durationMs + regression.durationMs;
    const costUsd = opts.costUsdPerTask ?? 0;
    const score = scoreBenchmark({
        publicTestPassed,
        hiddenTestPassed,
        regressionPassed,
        safetyViolations,
        blockedFileTouches: [], // prototype: variant never patches repo files
        hallucinatedFileRefs: false,
        costUsd,
        maxCostUsd: task.maxCostUsd,
        // Latency is scored DETERMINISTICALLY (duration 0 ⇒ latencyEfficiency 1.0).
        // At prototype level every variant runs the identical task command, so raw
        // wall-clock is pure noise; folding it in made the promotion decision (and
        // the winner) non-reproducible, defeating this path's own Repro gate
        // (ADR-076/079). The real `durationMs` is kept in the result for
        // observability; faithful latency scoring returns with the LLM evaluator,
        // where per-variant latency is a real reproducible signal (metered, not
        // wall-clock). `scoreBenchmark` itself stays a faithful pure function.
        durationMs: 0,
        timeoutMs: task.timeoutMs * 3,
    });
    return {
        taskId: task.id,
        variantId: variant.id,
        parentId: variant.parentId,
        repoCommit: task.commit,
        solved: score.verifiedSolve,
        publicTestPassed,
        hiddenTestPassed,
        regressionPassed,
        durationMs,
        costUsd,
        changedFiles: [],
        blockedFileTouches: [],
        safetyViolations,
        hallucinatedFileRefs: false,
        traceQuality: score.verifiedSolve ? 1 : 0.5,
        patchPath: '',
        tracePath: '',
        baseScore: score.baseScore,
        finalScore: score.finalScore,
    };
}
/**
 * Evaluate a child against its parent over a task set using an INJECTED runner
 * (the user-facing, testable shape). Carries FULL result objects — so the safety
 * check is over real `safetyViolations`/`blockedFileTouches`, not a score proxy —
 * and returns the statistical promotion decision (ADR-076).
 */
export async function evaluateWithRunner(input) {
    const parentResults = [];
    const childResults = [];
    for (const task of input.tasks) {
        parentResults.push(await input.runVariant(input.parentId, task));
        childResults.push(await input.runVariant(input.childId, task));
    }
    const decision = decidePromotion({
        parentResults,
        childResults,
        cleanReplay: input.cleanReplay ?? false,
        seed: input.seed,
        samples: input.samples,
        minDelta: input.minDelta,
    });
    return { parentResults, childResults, decision };
}
/**
 * Evaluate a child harness against its parent over a hash-verified suite, using
 * the real secure sandbox. Verifies the suite snapshot first (benchmark-tampering
 * control), then delegates to `evaluateWithRunner`.
 */
export async function evaluateChildAgainstParent(input) {
    const check = verifySuite(input.suite);
    if (!check.ok) {
        throw new Error(`benchmark suite tampered: taskHash ${check.expected} != recomputed ${check.actual}`);
    }
    const byId = new Map([
        [input.parent.id, input.parent],
        [input.child.id, input.child],
    ]);
    const runVariant = (variantId, task) => {
        const variant = byId.get(variantId);
        if (!variant)
            throw new Error(`unknown variant ${variantId}`);
        return runTaskForVariant(variant, input.profile, task, input.opts);
    };
    return evaluateWithRunner({
        parentId: input.parent.id,
        childId: input.child.id,
        tasks: input.suite.tasks,
        runVariant,
        cleanReplay: input.cleanReplay,
        seed: input.seed,
        samples: input.samples,
        minDelta: input.minDelta,
    });
}
//# sourceMappingURL=runner.js.map