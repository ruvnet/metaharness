// SPDX-License-Identifier: MIT
//
// The safety layer (ADR-071) — the load-bearing security boundary of Darwin Mode.
//
// A self-modifying agent that can edit anything is a liability. Darwin Mode's
// bound is enforced HERE, with two independent, defense-in-depth checks:
//
//   inspectVariant(dir)      — runs BEFORE any variant executes. Disqualifies a
//                              variant whose directory contains anything other
//                              than the seven approved files, a blocked filename,
//                              a symlink, or blocked content.
//   validateGeneratedCode()  — runs BEFORE generated code is written to disk
//                              (the LLM-mutator path). Independent pattern set.
//
// Both are CODE, not comments. The gate precedes execution; a disqualified
// variant never has its test command run (sandbox returns exitCode 99). A
// variant with any blocked action scores safetyScore 0 and cannot be promoted
// (ADR-072 requires safetyScore ≥ 0.95).
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
/** The seven approved mutation surfaces, in canonical order (ADR-071). */
export const SURFACES = [
    'planner',
    'contextBuilder',
    'reviewer',
    'retryPolicy',
    'toolPolicy',
    'memoryPolicy',
    'scorePolicy',
];
/** Surface → the single file it owns. The ONLY files a variant may contain. */
export const FILE_BY_SURFACE = {
    planner: 'planner.ts',
    contextBuilder: 'context_builder.ts',
    reviewer: 'reviewer.ts',
    retryPolicy: 'retry_policy.ts',
    toolPolicy: 'tool_policy.ts',
    memoryPolicy: 'memory_policy.ts',
    scorePolicy: 'score_policy.ts',
};
/** The exact set of filenames permitted inside a variant directory. */
export const APPROVED_FILES = new Set(Object.values(FILE_BY_SURFACE));
/**
 * Blocked filename substrings (case-insensitive). A variant directory must never
 * contain a file whose name hints at secrets, VCS, or keys (ADR-071).
 */
export const BLOCKED_FILENAME_PATTERNS = [
    '.env',
    'secret',
    'credential',
    'token',
    'private_key',
    'id_rsa',
    '.git',
    '.npmrc',
    'package.json',
    'package-lock',
    'yarn.lock',
    'pnpm-lock',
];
/**
 * Blocked code-content patterns (case-insensitive). If a variant file's text
 * matches any of these, the variant is disqualified. This is intentionally
 * broad: a harness mutation surface is pure policy logic — it has no business
 * spawning processes, touching the network, reading the environment, the file
 * system, or evaluating dynamic code.
 */
export const BLOCKED_CONTENT_PATTERNS = [
    // Environment access — both dotted (`process.env`) and computed-member forms
    // (`process['env']`, `process[`env`]`, `process . env`). The char class
    // `[.[]` covers the dot and the opening bracket; `['"\x60]?` the optional quote.
    { re: /process\s*[.[]\s*['"\x60]?\s*env/i, reason: 'environment access (process.env)' },
    { re: /\bReflect\s*\.\s*get\s*\(\s*process/i, reason: 'environment access (Reflect.get(process))' },
    { re: /process\s*[.[]\s*['"\x60]?\s*binding/i, reason: 'process.binding' },
    { re: /\bchild_process\b/i, reason: 'process spawning (child_process)' },
    { re: /\bexecSync\b|\bexecFileSync\b|\bspawnSync\b|\bspawn\b|\bexec\s*\(/i, reason: 'process execution' },
    { re: /\brequire\s*\(/i, reason: 'dynamic require()' },
    { re: /\bimport\s*\(/i, reason: 'dynamic import()' },
    { re: /\beval\s*\(/i, reason: 'eval()' },
    { re: /\bnew\s+Function\b/i, reason: 'new Function()' },
    { re: /\bfetch\s*\(/i, reason: 'network access (fetch)' },
    { re: /\bXMLHttpRequest\b|\bWebSocket\b/i, reason: 'network access (XHR/WebSocket)' },
    // node: builtins, including subpaths like `node:fs/promises`.
    { re: /\bnode:(fs|net|http|https|dns|tls|dgram|cluster|vm|worker_threads)(\/|\b)/i, reason: 'restricted node builtin' },
    // Bare-specifier imports, including subpaths like `fs/promises`, `net/x`.
    { re: /from\s+['"](fs|net|http|https|dns|tls|dgram|cluster|vm|worker_threads)(\/[^'"]*)?['"]/i, reason: 'restricted module import' },
    { re: /\bglobalThis\b|\b__proto__\b|\bconstructor\s*\[/i, reason: 'prototype/global escape' },
    { re: /\bcurl\b|\bwget\b|\bssh\b|\bscp\b|\bsudo\b|\bchmod\b|\bnc\s|\bnetcat\b/i, reason: 'shell command string' },
    // Destructive fs — any `rm` with a flag OR a path (`rm -rf`, `rm -r`, `rm /etc/x`).
    { re: /\brm\s+[-/]|\brmdir\b|\bunlink\b|\brmSync\b/i, reason: 'destructive filesystem command' },
    { re: /\bprivate_key\b|\bcredential\b|\bsecret\b|\btoken\b|BEGIN [A-Z ]*PRIVATE KEY/i, reason: 'secret handling' },
];
/** Hard caps to bound a pathological variant directory. */
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;
/**
 * Statically inspect a variant directory BEFORE it is allowed to run.
 * Returns a list of blocking findings; an empty list means the variant is clean.
 *
 * Disqualifying conditions:
 *   - a nested directory, a symlink, or any non-regular-file entry;
 *   - a file that is not one of the seven approved filenames;
 *   - a filename matching a blocked pattern;
 *   - a file exceeding the size cap, or the directory exceeding the file cap;
 *   - file content matching a blocked-capability pattern.
 */
export async function inspectVariant(dir) {
    const blocked = [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [`variant directory unreadable: ${dir}`];
    }
    if (entries.length > MAX_FILES) {
        blocked.push(`too many entries (${entries.length} > ${MAX_FILES})`);
    }
    for (const entry of entries) {
        const name = entry.name;
        const full = join(dir, name);
        // Reject symlinks and non-regular files via lstat (no symlink escape).
        let stat;
        try {
            stat = await lstat(full);
        }
        catch {
            blocked.push(`unstattable entry ${name}`);
            continue;
        }
        if (stat.isSymbolicLink()) {
            blocked.push(`symlink not allowed: ${name}`);
            continue;
        }
        if (stat.isDirectory()) {
            blocked.push(`unexpected directory ${name}`);
            continue;
        }
        if (!stat.isFile()) {
            blocked.push(`non-regular file ${name}`);
            continue;
        }
        const lower = name.toLowerCase();
        if (!APPROVED_FILES.has(name)) {
            blocked.push(`unexpected file ${name} (not in the approved allowlist)`);
        }
        for (const pat of BLOCKED_FILENAME_PATTERNS) {
            if (lower.includes(pat)) {
                blocked.push(`blocked filename pattern "${pat}" in ${name}`);
                break;
            }
        }
        if (stat.size > MAX_FILE_BYTES) {
            blocked.push(`file ${name} too large (${stat.size} > ${MAX_FILE_BYTES} bytes)`);
            continue; // do not read an oversized file into memory
        }
        let content;
        try {
            content = await readFile(full, 'utf8');
        }
        catch {
            blocked.push(`unreadable file ${name}`);
            continue;
        }
        for (const { re, reason } of BLOCKED_CONTENT_PATTERNS) {
            if (re.test(content))
                blocked.push(`blocked content in ${name}: ${reason}`);
        }
    }
    return blocked;
}
/**
 * Validate LLM/agent-generated code BEFORE it is written to a variant file.
 * Independent of inspectVariant (defense in depth). Returns a list of violations;
 * an empty list means the generated code is admissible. A generation that
 * violates this is DISCARDED, never repaired in place (ADR-071).
 */
export function validateGeneratedCode(code) {
    const violations = [];
    for (const { re, reason } of BLOCKED_CONTENT_PATTERNS) {
        if (re.test(code))
            violations.push(reason);
    }
    // De-duplicate (a pattern set can flag the same reason twice).
    return [...new Set(violations)];
}
/** Convenience: a variant is admissible iff inspectVariant finds nothing. */
export async function isVariantSafe(dir) {
    return (await inspectVariant(dir)).length === 0;
}
//# sourceMappingURL=safety.js.map