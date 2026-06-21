// SPDX-License-Identifier: MIT
//
// Deterministic surface-driven task runner (ADR-102) — Tier 1 of the
// Agent-Executing Sandbox (ADR-101). The real sandbox scores a variant by the
// REPO's test command, which is independent of the harness surfaces, so every
// trace is identical and the behavioural manifold collapses (measured:
// nicheEntropy=0, ADR-099). This runner makes the trace a PURE FUNCTION of the
// variant's surface parameters, so a mutation to retryPolicy / contextBuilder /
// toolPolicy actually changes the outcome — activating ADR-091/092/094/097/100.
//
// It does NOT call an LLM, compile, or shell out: it extracts the surface
// parameters with the SAME regexes the DeterministicMutator writes, then
// simulates a scripted agent loop. Fully deterministic ⇒ reproducible (ADR-075):
// `durationMs` is derived from surface params, not wall-clock.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_BY_SURFACE } from './safety.js';
/**
 * A graduated scripted ladder (drives the curriculum, ADR-097). Each rung needs
 * slightly more retry budget and/or context than the last, so an incremental
 * surface improvement solves incrementally MORE rungs — a climbable gradient
 * (not a deceptive all-or-nothing plateau). The lower rungs reward retry-budget
 * growth alone; the upper rungs additionally require a wider context window, so
 * the full ladder rewards combining both surfaces (crossover/epistasis).
 */
export const DEFAULT_MOCK_TASKS = [
    { id: 'mock-1', failAttempts: 0, requiredContext: 10, backoffMs: 20, difficulty: 1 },
    { id: 'mock-2', failAttempts: 1, requiredContext: 20, backoffMs: 20, difficulty: 2 },
    { id: 'mock-3', failAttempts: 1, requiredContext: 30, backoffMs: 30, difficulty: 3 },
    { id: 'mock-4', failAttempts: 2, requiredContext: 50, backoffMs: 40, difficulty: 4 },
    { id: 'mock-5', failAttempts: 2, requiredContext: 70, backoffMs: 50, difficulty: 5 },
];
function intAfter(re, text, fallback) {
    const m = re.exec(text);
    return m ? Number(m[1]) : fallback;
}
/**
 * Extract surface parameters from a variant directory (text-parsing, not import).
 * Uses the same patterns the DeterministicMutator perturbs, so a mutation that
 * bumps a budget or a slice width is reflected here. Missing files → defaults.
 */
export async function extractSurfaceParams(variantDir) {
    const read = async (surface) => {
        try {
            return await readFile(join(variantDir, FILE_BY_SURFACE[surface]), 'utf8');
        }
        catch {
            return '';
        }
    };
    const retry = await read('retryPolicy');
    const context = await read('contextBuilder');
    const memory = await read('memoryPolicy');
    const planner = await read('planner');
    const maxAttempts = intAfter(/\b(?:maxAttempts|maxRetries|retries|retryBudget|budget)\b\s*[:=]\s*(\d+)/, retry, 3);
    const contextWindow = intAfter(/\.slice\(\s*0\s*,\s*(\d+)\s*\)/, context, 30);
    const memMatch = /\b(?:threshold|minScore|cutoff)\b\s*[:=]\s*(0?\.\d+|1(?:\.0+)?|0)\b/.exec(memory);
    const memoryThreshold = memMatch ? Number(memMatch[1]) : 0.5;
    // Plan steps ≈ count of directive sentences in the planner guidance.
    const planSteps = Math.max(1, (planner.match(/\b(?:step|plan|decompose|verify|consider|first|then|focus)\b/gi) ?? []).length);
    return { maxAttempts, contextWindow, memoryThreshold, planSteps };
}
/**
 * Simulate a scripted agent loop. Outcome is a deterministic function of the
 * surface params and the task: the agent must (a) see enough context and
 * (b) retry past the task's failing attempts. The log records plan steps,
 * context builds, and retry decisions — so verbosity/repetition/duration all
 * vary by surface, populating the behavioural phenotype (ADR-091).
 */
export function simulateAgentLoop(params, task) {
    const sees = params.contextWindow >= task.requiredContext;
    const lines = [];
    for (let s = 0; s < params.planSteps; s++)
        lines.push(`plan: step ${s}`);
    let attemptsUsed = 0;
    let solved = false;
    for (let attempt = 0; attempt < params.maxAttempts; attempt++) {
        attemptsUsed = attempt + 1;
        lines.push(`ctx: built window ${params.contextWindow}`);
        // Solvable once we are past the failing attempts AND we can see the bug.
        if (sees && attempt >= task.failAttempts) {
            lines.push('verify: PASS');
            solved = true;
            break;
        }
        lines.push(`retry: attempt ${attempt} failed (${sees ? 'unfixed' : 'blind'})`);
    }
    const durationMs = attemptsUsed * task.backoffMs + params.contextWindow;
    return { solved, attemptsUsed, durationMs, log: lines.join('\n') };
}
/** Run ONE mock task against a variant, producing a surface-dependent RunTrace. */
export async function runVariantTaskMock(variant, task, params) {
    const p = params ?? (await extractSurfaceParams(variant.dir));
    const sim = simulateAgentLoop(p, task);
    // Deterministic timestamps derived from duration (no wall-clock → reproducible).
    const startedAt = '1970-01-01T00:00:00.000Z';
    const finishedAt = new Date(sim.durationMs).toISOString();
    return {
        variantId: variant.id,
        taskId: task.id,
        startedAt,
        finishedAt,
        exitCode: sim.solved ? 0 : 1,
        stdout: sim.log,
        stderr: sim.solved ? '' : `task ${task.id} unsolved after ${sim.attemptsUsed} attempts`,
        durationMs: sim.durationMs,
        timedOut: false,
        blockedActions: [],
    };
}
/** Run a variant against a graded mock suite (defaults to DEFAULT_MOCK_TASKS). */
export async function runVariantTasksMock(variant, tasks = DEFAULT_MOCK_TASKS) {
    const params = await extractSurfaceParams(variant.dir);
    const traces = [];
    for (const task of tasks)
        traces.push(await runVariantTaskMock(variant, task, params));
    return traces;
}
//# sourceMappingURL=mock-sandbox.js.map