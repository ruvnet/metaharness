// SPDX-License-Identifier: MIT
//
// Tier-2 agent driver (ADR-106). Runs in an ISOLATED child process launched by
// tier2-sandbox.ts under Node's permission model (`--permission`), with string
// code generation disabled and a heap cap, so it can import the variant's real
// surface `.ts` modules and execute their ACTUAL logic — not regex-extracted
// parameters (Tier 1, ADR-102). It drives a deterministic agent loop calling
// the surfaces' real exports and prints a JSON trace to stdout.
//
//   argv[2] = variant directory (contains the 7 surface .ts files)
//   argv[3] = task JSON: { prompt, files, buggyFile, classification, failAttempts, backoffMs }
//   argv[4] = output nonce (the result line is prefixed with it)
//
// Before any variant module is imported the driver:
//   1. verifies it really is confined (permission model active; no fs write,
//      child process, worker, addon or WASI grant) and refuses to run otherwise;
//   2. installs a module-resolution hook (when available) that only resolves
//      the variant's own surface files — no builtins, no packages;
//   3. removes ambient capabilities from the global scope (process, network
//      globals, timers) so variant code cannot reach them even by indirection.
//
// Standalone: imports ONLY node builtins (no package imports), so the child
// needs nothing from dist except this file. Deterministic (durationMs derived
// from the loop, not wall-clock) ⇒ reproducible.
import * as nodeModule from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Surface files the driver imports. Nothing else may be resolved. */
const SURFACE_FILES = ['planner.ts', 'context_builder.ts', 'retry_policy.ts', 'tool_policy.ts'];
// Capture what the driver itself needs BEFORE ambient capabilities are removed.
const argv = process.argv.slice();
const stdoutWrite = process.stdout.write.bind(process.stdout);
const permission = process.permission;
const nonce = argv[4] ?? '';
function emit(obj) {
    stdoutWrite(`${nonce}${JSON.stringify(obj)}\n`);
}
/** Returns a reason string when the process is NOT adequately confined. */
function isolationProblem() {
    if (!permission || typeof permission.has !== 'function')
        return 'permission model not active';
    for (const scope of ['fs.write', 'child', 'worker', 'addon', 'wasi']) {
        try {
            if (permission.has(scope))
                return `permission "${scope}" is granted`;
        }
        catch {
            // An unknown scope on this Node version is not a grant.
        }
    }
    return undefined;
}
function installResolveHook(variantDir) {
    const registerHooks = nodeModule.registerHooks;
    if (typeof registerHooks !== 'function')
        return; // static gate + permission model still apply
    const allowed = new Set(SURFACE_FILES.map((f) => pathToFileURL(join(variantDir, f)).href));
    registerHooks({
        resolve(spec, ctx, next) {
            const res = next(spec, ctx);
            if (!allowed.has(res.url))
                throw new Error(`tier2 isolation: module "${spec}" is not loadable`);
            return res;
        },
    });
}
function removeAmbientCapabilities() {
    const g = globalThis;
    for (const name of [
        'process', 'fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'WebSocketStream',
        'Request', 'Response', 'Headers', 'FormData', 'navigator',
        'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
        // WebAssembly is NOT removed: Node's own TypeScript stripper needs it (the
        // static layers still ban variant references to it).
        'Buffer', 'SharedArrayBuffer', 'Atomics', 'BroadcastChannel',
        'require', 'module', 'global',
    ]) {
        try {
            Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false, enumerable: false });
        }
        catch {
            try {
                delete g[name];
            }
            catch { /* best effort */ }
        }
    }
}
async function main() {
    const problem = isolationProblem();
    if (problem) {
        emit({ refused: true, reason: `isolation unavailable: ${problem}`, solved: false, attemptsUsed: 0, durationMs: 0, log: '' });
        return;
    }
    const variantDir = argv[2];
    const task = JSON.parse(argv[3]);
    const log = [];
    installResolveHook(variantDir);
    removeAmbientCapabilities();
    // Import the variant's REAL surface modules (types stripped by the flag).
    const planner = await import(pathToFileURL(join(variantDir, 'planner.ts')).href);
    const ctxb = await import(pathToFileURL(join(variantDir, 'context_builder.ts')).href);
    const retry = await import(pathToFileURL(join(variantDir, 'retry_policy.ts')).href);
    const tools = await import(pathToFileURL(join(variantDir, 'tool_policy.ts')).href);
    // The agent must produce a plan that ends in verification.
    const plan = (planner.createPlan?.(task.prompt) ?? []);
    const planOk = plan.length > 0 && plan.some((s) => s.kind === 'verify');
    log.push(`plan: ${plan.length} steps, verify=${planOk}`);
    // Tool ordering is exercised (its output shapes the log / behaviour).
    const order = (tools.orderKinds?.(['lint', 'test', 'build']) ?? []);
    log.push(`tools: ${order.join('>')}`);
    const maxA = (retry.maxAttempts ?? 3);
    let solved = false;
    let attemptsUsed = 0;
    let ctxLen = 0;
    for (let attempt = 0;; attempt++) {
        attemptsUsed = attempt + 1;
        // REAL contextBuilder: ranks files by overlap and slices to its window. The
        // bug is "located" only if the buggy file survives into the returned window.
        const ctx = (ctxb.buildContext?.(task.prompt, task.files) ?? []);
        ctxLen = ctx.length;
        const located = ctx.some((c) => c.path === task.buggyFile);
        log.push(`attempt ${attempt}: ctx=${ctx.length} located=${located}`);
        if (planOk && located && attempt >= task.failAttempts) {
            solved = true;
            log.push('verify: PASS');
            break;
        }
        // REAL retryPolicy decides persistence given the failure classification.
        const d = (retry.decideRetry?.(attempt, task.classification) ?? { retry: false, reason: 'no decideRetry' });
        if (!d.retry || attempt + 1 >= maxA) {
            log.push(`stop: ${d.reason}`);
            break;
        }
    }
    const durationMs = attemptsUsed * task.backoffMs + ctxLen;
    emit({ solved, attemptsUsed, durationMs, log: log.join('\n') });
}
main().catch((e) => {
    emit({ solved: false, attemptsUsed: 0, durationMs: 0, log: `ERR ${String(e?.message ?? e).slice(0, 200)}` });
});
//# sourceMappingURL=tier2-driver.js.map