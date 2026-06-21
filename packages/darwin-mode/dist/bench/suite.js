// SPDX-License-Identifier: MIT
//
// Benchmark suite handling (ADR-076 §anti-gaming): a task set is an IMMUTABLE,
// hash-pinned snapshot. `hashTasks` canonicalises the tasks and hashes them;
// `verifySuite` recomputes and compares. Replay refuses to run on a mismatch, so
// a self-improving agent cannot quietly edit the task files to look better
// (benchmark tampering control).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/** Recursively sort object keys so JSON is canonical regardless of authoring order. */
function canonicalise(value) {
    if (Array.isArray(value))
        return value.map(canonicalise);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = canonicalise(value[key]);
        }
        return out;
    }
    return value;
}
/** Stable SHA-256 over the canonicalised task list. */
export function hashTasks(tasks) {
    const canonical = JSON.stringify(canonicalise(tasks));
    return createHash('sha256').update(canonical).digest('hex');
}
/** Build a hash-pinned suite from a task list. */
export function makeSuite(id, version, tasks) {
    return {
        id,
        version,
        createdAt: new Date().toISOString(),
        taskHash: hashTasks(tasks),
        tasks,
    };
}
/** Recompute the hash and compare it to the recorded one. */
export function verifySuite(suite) {
    const actual = hashTasks(suite.tasks);
    return { ok: actual === suite.taskHash, expected: suite.taskHash, actual };
}
/** Load a suite from disk and verify its hash (throws on tamper). */
export async function loadSuite(file) {
    const raw = await readFile(file, 'utf8');
    const suite = JSON.parse(raw);
    const check = verifySuite(suite);
    if (!check.ok) {
        throw new Error(`benchmark suite tampered: taskHash ${check.expected} != recomputed ${check.actual}`);
    }
    return suite;
}
/** Persist a suite as pretty JSON, creating the parent directory. */
export async function saveSuite(file, suite) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(suite, null, 2), 'utf8');
}
//# sourceMappingURL=suite.js.map