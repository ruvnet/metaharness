// SPDX-License-Identifier: MIT
//
// Tier-2 agent sandbox (ADR-106). Executes a variant's REAL surface code by
// spawning `tier2-driver.js` in an ISOLATED child `node` process (so the child
// can import the variant's `.ts` surfaces). Isolation:
//
//   - Node permission model (`--permission`): filesystem READ limited to the
//     driver file and the variant directory; NO filesystem write, child
//     process, worker, native addon or WASI grants. On Node versions with a
//     network permission, network is denied too.
//   - `--disallow-code-generation-from-strings`: eval / Function-constructor
//     style code construction throws.
//   - `--max-old-space-size` heap cap; wall-clock timeout with SIGKILL.
//   - shell-free (`execFile`), env-scrubbed (only identifiers), cwd = variant dir.
//   - the driver re-verifies its own confinement and strips ambient globals
//     before importing any variant module.
//
// If the runtime cannot provide this isolation (no permission model, no type
// stripping), Tier-2 execution is REFUSED (exit 99, blockedActions set) — it
// never falls back to running a variant unconfined. The gate (`inspectVariant`) runs FIRST, exactly like the
// 'real' sandbox (`sandbox.ts`) and the LLM-agent sandbox
// (`llm-agent-sandbox.ts`): a disqualified variant's surface files are never
// imported/executed by `tier2-driver.js`.
//
// Requires Node ≥ 22 (`--experimental-strip-types` + `--permission`). A child
// error is a clean "unsolved" trace rather than a crash of the loop.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectVariant } from './safety.js';
const execFileAsync = promisify(execFile);
const DISQUALIFIED_EXIT_CODE = 99;
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
/** Default heap cap (MiB) for the isolated Tier-2 child. */
export const TIER2_MAX_OLD_SPACE_MB = 256;
/**
 * The permission-model flag this runtime supports, or a reason it cannot
 * isolate Tier-2 execution. Exported for tests and diagnostics.
 */
export function tier2IsolationSupport(flags = process.allowedNodeEnvironmentFlags) {
    const permissionFlag = flags.has('--permission')
        ? '--permission'
        : flags.has('--experimental-permission')
            ? '--experimental-permission'
            : undefined;
    if (!permissionFlag)
        return { ok: false, reason: `Node ${process.versions.node} has no permission model` };
    if (!flags.has('--experimental-strip-types')) {
        return { ok: false, reason: `Node ${process.versions.node} cannot strip TypeScript types` };
    }
    return { ok: true, permissionFlag };
}
/**
 * Spawn the Tier-2 driver for `variantDir` in the isolated child process. This
 * does NOT run the static gate — callers must (`runVariantTaskAgent` does). It
 * is exported so the isolation layer can be tested on its own.
 */
export async function spawnIsolatedDriver(variantDir, task, opts = {}) {
    const support = tier2IsolationSupport(opts.nodeFlags);
    if (!support.ok)
        return { kind: 'refused', reason: `isolation unavailable: ${support.reason}` };
    if (!existsSync(DRIVER))
        return { kind: 'refused', reason: 'isolation unavailable: tier2 driver not built' };
    let dir;
    let driver;
    try {
        dir = realpathSync(resolvePath(variantDir));
        driver = realpathSync(DRIVER);
    }
    catch {
        return { kind: 'error', reason: 'variant directory unresolvable' };
    }
    // A comma would split an --allow-fs-read list on some Node versions.
    if (dir.includes(',') || driver.includes(',')) {
        return { kind: 'refused', reason: 'isolation unavailable: path contains a comma' };
    }
    const nonce = `@@T2-${randomBytes(12).toString('hex')}@@`;
    const maxOld = Math.max(32, Math.floor(opts.maxOldSpaceMb ?? TIER2_MAX_OLD_SPACE_MB));
    const args = [
        support.permissionFlag,
        `--allow-fs-read=${driver}`,
        `--allow-fs-read=${dir}`,
        '--disallow-code-generation-from-strings',
        `--max-old-space-size=${maxOld}`,
        '--experimental-strip-types',
        '--no-warnings',
        driver,
        dir,
        JSON.stringify(task),
        nonce,
    ];
    try {
        const { stdout } = await execFileAsync(process.execPath, args, {
            timeout: opts.timeoutMs ?? 10_000,
            killSignal: 'SIGKILL',
            env: opts.env ?? {},
            cwd: dir,
            maxBuffer: 1 << 20,
            windowsHide: true,
        });
        const line = stdout.split('\n').reverse().find((l) => l.startsWith(nonce));
        if (!line)
            return { kind: 'error', reason: 'driver produced no result' };
        const out = JSON.parse(line.slice(nonce.length));
        if (out.refused)
            return { kind: 'refused', reason: out.reason ?? 'isolation unavailable' };
        return { kind: 'ok', out };
    }
    catch (e) {
        return { kind: 'error', reason: `child error: ${e.message}`.slice(0, 200) };
    }
}
/**
 * Run ONE agent task against a variant by executing its real surface code.
 *
 * The ADR-071 safety gate runs first: if `inspectVariant` reports any
 * findings, `tier2-driver.js` never imports/executes the variant's surface
 * files, and a disqualified trace (exitCode 99, mirroring `sandbox.ts` and
 * `llm-agent-sandbox.ts`) is returned instead.
 */
export async function runVariantTaskAgent(variant, task, timeoutMs = 10_000) {
    // ── Gate first: a disqualified variant never has its surface code run. ──
    const findings = await inspectVariant(variant.dir);
    if (findings.length > 0) {
        return {
            variantId: variant.id,
            taskId: task.id,
            startedAt: '1970-01-01T00:00:00.000Z',
            finishedAt: '1970-01-01T00:00:00.000Z',
            exitCode: DISQUALIFIED_EXIT_CODE,
            stdout: '',
            stderr: findings.join('\n'),
            durationMs: 0,
            timedOut: false,
            blockedActions: findings,
        };
    }
    // The child gets no PATH and no inherited variables — only identifiers.
    const scrubbedEnv = {
        METAHARNESS_VARIANT: variant.id,
        METAHARNESS_TASK: task.id,
    };
    const res = await spawnIsolatedDriver(variant.dir, task, { timeoutMs, env: scrubbedEnv });
    // ── Refuse rather than run unconfined. ──
    if (res.kind === 'refused') {
        return {
            variantId: variant.id,
            taskId: task.id,
            startedAt: '1970-01-01T00:00:00.000Z',
            finishedAt: '1970-01-01T00:00:00.000Z',
            exitCode: DISQUALIFIED_EXIT_CODE,
            stdout: '',
            stderr: res.reason,
            durationMs: 0,
            timedOut: false,
            blockedActions: [`tier2 ${res.reason}`],
        };
    }
    // A child failure is an unsolved task, not a safety block.
    const out = res.kind === 'ok'
        ? res.out
        : { solved: false, attemptsUsed: 0, durationMs: 0, log: res.reason };
    const blocked = false;
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