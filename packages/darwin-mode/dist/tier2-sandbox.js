// SPDX-License-Identifier: MIT
//
// Tier-2 agent sandbox (ADR-106). Executes a variant's REAL surface code by
// spawning `tier2-driver.js` in a child `node --experimental-strip-types`
// process (so the child can import the variant's `.ts` surfaces). Shell-free
// (`execFile`, argv split — no command injection), env-scrubbed (only PATH +
// identifiers leak), and timeout-bounded — the same safety posture as the real
// sandbox (ADR-071). The gate (`inspectVariant`) has already cleared the variant
// before any execution.
//
// Requires Node ≥ 22 (`--experimental-strip-types`). On older Node or any child
// error, the variant gets a clean "unsolved" trace rather than crashing the loop.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/**
 * Resolve the compiled driver. From `dist/tier2-sandbox.js` the sibling
 * `./tier2-driver.js` exists; when this module runs from `src/` (tests/dev via a
 * TS loader), fall back to the built `../dist/tier2-driver.js`. The driver must
 * be compiled (`npm run build`) for the 'agent' sandbox to run.
 */
function resolveDriver() {
    const sibling = fileURLToPath(new URL('./tier2-driver.js', import.meta.url));
    if (existsSync(sibling))
        return sibling;
    return fileURLToPath(new URL('../dist/tier2-driver.js', import.meta.url));
}
const DRIVER = resolveDriver();
/**
 * Default agent suite. The buggy file `src/<a>_<b>.ts` is preceded by `before`
 * distractors `src/<a>_<b>_<i>.ts` that share its EXACT two terms — so the real
 * contextBuilder gives them all the same overlap score and falls back to input
 * order. The buggy file therefore sits at rank `before`, surviving into the
 * returned window only if the contextBuilder's `.slice(0, N)` window is wider
 * than that. Solving thus depends on the REAL contextBuilder window/ranking,
 * plus retry persistence ('transient' lets decideRetry continue to maxAttempts).
 */
function buggyAfter(a, b, before) {
    const buggyFile = `src/${a}_${b}.ts`;
    const files = [
        ...Array.from({ length: before }, (_, i) => `src/${a}_${b}_${i}.ts`),
        buggyFile,
    ];
    return { prompt: `fix ${a} ${b}`, files, buggyFile };
}
export const DEFAULT_AGENT_TASKS = [
    { id: 'a-easy', ...buggyAfter('auth', 'token', 0), classification: 'transient', failAttempts: 0, backoffMs: 20, difficulty: 1 },
    { id: 'a-mid', ...buggyAfter('cache', 'key', 35), classification: 'transient', failAttempts: 1, backoffMs: 30, difficulty: 3 },
    { id: 'a-hard', ...buggyAfter('retry', 'budget', 60), classification: 'transient', failAttempts: 2, backoffMs: 40, difficulty: 5 },
];
/** Run ONE agent task against a variant by executing its real surface code. */
export async function runVariantTaskAgent(variant, task, timeoutMs = 10_000) {
    const scrubbedEnv = {
        PATH: process.env.PATH,
        METAHARNESS_VARIANT: variant.id,
        METAHARNESS_TASK: task.id,
    };
    let out = { solved: false, attemptsUsed: 0, durationMs: 0, log: '' };
    let blocked = false;
    try {
        const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--no-warnings', DRIVER, variant.dir, JSON.stringify(task)], { timeout: timeoutMs, env: scrubbedEnv, cwd: variant.dir, maxBuffer: 1 << 20 });
        out = JSON.parse(stdout.trim() || '{}');
    }
    catch (e) {
        out = { solved: false, attemptsUsed: 0, durationMs: 0, log: `child error: ${e.message}`.slice(0, 200) };
        blocked = false; // a child failure is an unsolved task, not a safety block
    }
    const startedAt = '1970-01-01T00:00:00.000Z';
    return {
        variantId: variant.id,
        taskId: task.id,
        startedAt,
        finishedAt: new Date(out.durationMs).toISOString(),
        exitCode: out.solved ? 0 : 1,
        stdout: out.log,
        stderr: out.solved ? '' : `task ${task.id} unsolved (${out.attemptsUsed} attempts)`,
        durationMs: out.durationMs,
        timedOut: false,
        blockedActions: blocked ? ['tier2 child blocked'] : [],
    };
}
/** Run a variant against the agent suite (defaults to DEFAULT_AGENT_TASKS). */
export async function runVariantTasksAgent(variant, tasks = DEFAULT_AGENT_TASKS, timeoutMs = 10_000) {
    const traces = [];
    for (const task of tasks)
        traces.push(await runVariantTaskAgent(variant, task, timeoutMs));
    return traces;
}
//# sourceMappingURL=tier2-sandbox.js.map