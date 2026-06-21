// SPDX-License-Identifier: MIT
//
// The mutation engine (ADR-071) — produces a child variant from a parent by
// perturbing exactly one approved surface file, behind the safety gate.
//
// A mutation is BOUNDED by construction: it copies the parent variant directory
// verbatim, picks ONE surface deterministically, regenerates ONLY that surface's
// file, and writes nothing else. Generated code is run through
// `validateGeneratedCode` BEFORE it touches disk; a violation is discarded and
// the parent's file is preserved (a safe no-op mutation), so a child variant
// always still passes `inspectVariant` (ADR-071 §hard gate).
//
// The mutator is pluggable via `CodeGenerator`: the default `DeterministicMutator`
// performs seeded string-replacement edits (the prototype path), and can be
// swapped for an LLM-backed generator behind the SAME gate.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FILE_BY_SURFACE, SURFACES, validateGeneratedCode } from './safety.js';
/** A pure, deterministic 32-bit hash — seeds choice without `Math.random`. */
function hash(...parts) {
    let h = 0x811c9dc5;
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/** Clamp a `.slice(start, end)` window to a small, sane range. */
function clampWindow(n) {
    if (!Number.isFinite(n))
        return 30;
    return Math.max(5, Math.min(200, Math.round(n)));
}
/**
 * The ordered catalogue of bounded edits the deterministic mutator can apply.
 * They are tried in a seeded rotation; the first that matches the parent file is
 * used. Every rule is signature-preserving and capability-neutral.
 */
const EDIT_RULES = [
    // Tweak a `.slice(0, N)` context window up or down by a bounded step.
    {
        find: /\.slice\(\s*0\s*,\s*(\d+)\s*\)/,
        replace: (match, variant) => {
            const current = Number(/(\d+)\s*\)/.exec(match)?.[1] ?? '30');
            const step = (variant % 2 === 0 ? 1 : -1) * (10 + (variant % 3) * 5);
            const next = clampWindow(current + step);
            return match.replace(/0\s*,\s*\d+/, `0, ${next}`);
        },
        summary: (variant) => `adjusted context slice window (variant ${variant})`,
    },
    // Adjust a retry / attempt budget literal (e.g. `maxRetries = 3`).
    {
        find: /\b(maxRetries|retries|maxAttempts|attempts|retryBudget|budget)\b(\s*[:=]\s*)(\d+)/,
        replace: (match, variant) => {
            const m = /(\d+)\s*$/.exec(match);
            const current = Number(m?.[1] ?? '3');
            const delta = variant % 2 === 0 ? 1 : -1;
            const next = Math.max(0, Math.min(16, current + delta));
            return match.replace(/\d+\s*$/, String(next));
        },
        summary: (variant) => `adjusted retry/attempt budget (variant ${variant})`,
    },
    // Nudge a numeric threshold literal (memory/score policy), bounded to [0,1].
    {
        find: /\b(threshold|cutoff|minScore|weight|decay|temperature)\b(\s*[:=]\s*)(0?\.\d+|1(?:\.0+)?|0)\b/,
        replace: (match, variant) => {
            const m = /(0?\.\d+|1(?:\.0+)?|0)\s*$/.exec(match);
            const current = Number(m?.[1] ?? '0.5');
            const step = (variant % 2 === 0 ? 0.05 : -0.05) * (1 + (variant % 2));
            const next = Math.max(0, Math.min(1, Math.round((current + step) * 100) / 100));
            return match.replace(/(0?\.\d+|1(?:\.0+)?|0)\s*$/, String(next));
        },
        summary: (variant) => `nudged numeric threshold (variant ${variant})`,
    },
    // Perturb a quoted planner/reviewer phrase by appending a directive variant.
    {
        find: /(['"`])((?:step|plan|decompose|review|consider|first|then|focus)[^'"`]{0,80}?)\1/i,
        replace: (match, variant) => {
            const phrases = [
                ' Prefer the smallest viable change.',
                ' Verify assumptions before acting.',
                ' Surface the riskiest unknown first.',
            ];
            const add = phrases[variant % phrases.length];
            const quote = match[0];
            const inner = match.slice(1, -1).replace(/\s+$/, '');
            return `${quote}${inner}${add}${quote}`;
        },
        summary: (variant) => `refined planner/reviewer phrasing (variant ${variant})`,
    },
];
/**
 * The default mutator: deterministic, seeded, dependency-free. It applies the
 * first matching bounded edit (in a seeded rotation) to the parent file. If no
 * edit rule matches, it appends a tracking comment — a safe, signature-neutral
 * no-op so the surface still differs and the file still passes the scanner.
 */
export class DeterministicMutator {
    seed;
    constructor(seed = 0) {
        this.seed = seed;
    }
    async generateMutation(input) {
        const { parentCode, surface } = input;
        // The sibling nonce (child index) makes same-surface siblings explore
        // DIFFERENT edits (e.g. retry budget +1 vs −1), so a generation covers both
        // directions instead of one — fixing the "budget never grows upward" bug
        // found in ADR-103. Deterministic ⇒ reproducible.
        const variant = hash(this.seed, surface, parentCode.length, input.nonce ?? 0) % 6;
        const start = hash(this.seed, surface) % EDIT_RULES.length;
        for (let i = 0; i < EDIT_RULES.length; i++) {
            const rule = EDIT_RULES[(start + i) % EDIT_RULES.length];
            if (!rule.find.test(parentCode))
                continue;
            const code = parentCode.replace(rule.find, (m) => rule.replace(m, variant));
            if (code !== parentCode) {
                return { code, summary: rule.summary(variant) };
            }
        }
        // No structural edit matched — emit a signature-neutral tracking comment.
        const note = `\n// darwin: ${surface} perturbation v${variant} (seed ${this.seed})\n`;
        return {
            code: parentCode.replace(/\s*$/, '') + note,
            summary: `appended ${surface} tracking note (no structural edit available)`,
        };
    }
}
/**
 * Distil a parent's run traces into compact failure summaries for the mutator.
 * A trace "failed" if it exited non-zero, timed out, or tripped a safety block.
 * Pure and deterministic — order-preserving, no wall-clock, no I/O.
 */
export function summarizeFailedTraces(traces) {
    const out = [];
    for (const t of traces) {
        const failed = t.exitCode !== 0 || t.timedOut || t.blockedActions.length > 0;
        if (!failed)
            continue;
        const why = t.blockedActions.length > 0
            ? `blocked: ${t.blockedActions.join(', ')}`
            : t.timedOut
                ? 'timed out'
                : `exit ${t.exitCode}`;
        const tail = (t.stderr || t.stdout || '').trim().split('\n').pop()?.slice(0, 160) ?? '';
        out.push(`task ${t.taskId}: ${why}${tail ? ` — ${tail}` : ''}`);
    }
    return out;
}
/**
 * Deterministically pick one of the seven surfaces from `(generation+index+seed)`.
 * Same inputs ⇒ same surface (reproducibility, ADR-070 §seed).
 */
export function pickSurface(generation, index, seed) {
    const i = hash(generation, index, seed) % SURFACES.length;
    return SURFACES[i];
}
/**
 * Recombine two parents into a child (genetic crossover, ADR-089). The child is
 * parentA's directory with a deterministic, non-empty PROPER subset of surface
 * files replaced by parentB's versions — so it inherits some surfaces from each.
 *
 * Recombination only — no code is generated — so every adopted file already
 * passed the gate when its parent was built; we re-run `validateGeneratedCode`
 * defensively and skip any file that would fail (the child keeps parentA's), so
 * the child always still passes `inspectVariant`.
 *
 * The archive is a strict tree (one `parentId`): we record `parentA` as the tree
 * parent and name `parentB` in the summary, so every tree invariant holds.
 */
export async function createCrossoverVariant(parentA, parentB, workRoot, generation, index, seed = 0, surfacesFromB) {
    const id = `g${generation}_x${index}`;
    const dir = join(workRoot, 'variants', id);
    await copyVariantDir(parentA.dir, dir);
    // Which surfaces come from B: an explicit epistatic block (ADR-093 topology-
    // aware crossover) when supplied, else a deterministic random bit-subset.
    let fromB;
    if (surfacesFromB && surfacesFromB.length > 0) {
        fromB = [...new Set(surfacesFromB)].filter((s) => SURFACES.includes(s));
        if (fromB.length >= SURFACES.length)
            fromB = fromB.slice(0, SURFACES.length - 1);
    }
    else {
        const bits = hash(seed, generation, index, parentA.id, parentB.id, 'crossover');
        fromB = SURFACES.filter((_, i) => ((bits >> i) & 1) === 1);
        // Force a PROPER, non-empty recombination: never all-A and never all-B.
        if (fromB.length === 0)
            fromB = [SURFACES[bits % SURFACES.length]];
        if (fromB.length === SURFACES.length)
            fromB = fromB.slice(0, SURFACES.length - 1);
    }
    const adopted = [];
    for (const surface of fromB) {
        const fileName = FILE_BY_SURFACE[surface];
        let codeB;
        try {
            codeB = await readFile(join(parentB.dir, fileName), 'utf8');
        }
        catch {
            continue; // parentB lacks the file — keep parentA's
        }
        if (validateGeneratedCode(codeB).length > 0)
            continue; // defensive: skip unsafe
        await writeFile(join(dir, fileName), codeB, 'utf8');
        adopted.push(surface);
    }
    return {
        id,
        parentId: parentA.id,
        generation,
        dir,
        mutationSurface: adopted[0] ?? parentA.mutationSurface,
        mutationSummary: adopted.length > 0
            ? `crossover: surfaces [${adopted.join(', ')}] from ${parentB.id} onto ${parentA.id}`
            : `crossover: no safe surface adopted from ${parentB.id} (identical to ${parentA.id})`,
        createdAt: new Date().toISOString(),
    };
}
/**
 * Recursively copy a variant directory using `node:fs/promises` only (never a
 * shell). The destination is created fresh; only the parent's files are copied,
 * so no extraneous entry can leak in.
 */
export async function copyVariantDir(src, dest) {
    // Defensive: a child whose id collides with its parent's would make src===dest
    // (cp throws EINVAL). Never copy a directory onto itself.
    if (resolve(src) === resolve(dest))
        return;
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true, dereference: true, force: true });
}
/**
 * Create a child variant from `parent`: copy its directory, pick one surface
 * deterministically, regenerate that surface's file via `gen`, validate the
 * generated code BEFORE writing, and return the resulting `HarnessVariant`.
 *
 * If `validateGeneratedCode` reports any violation, the mutation is DISCARDED
 * and the parent's surface file is left untouched (a safe no-op). The child
 * directory therefore always still passes `inspectVariant`.
 */
export async function createChildVariant(parent, workRoot, generation, index, gen = new DeterministicMutator(), seed = 0, context = {}) {
    const id = `g${generation}_v${index}`;
    const dir = join(workRoot, 'variants', id);
    // 1) Copy the parent directory verbatim (no shell, no extra files).
    await copyVariantDir(parent.dir, dir);
    // 2) Pick the single surface to mutate, deterministically.
    const surface = pickSurface(generation, index, seed);
    const fileName = FILE_BY_SURFACE[surface];
    const filePath = join(dir, fileName);
    const parentCode = await readFile(filePath, 'utf8');
    // 3) Generate a candidate mutation for that one file. The reflection context
    //    (parent score + failures) lets an LLM generator target real weaknesses;
    //    the DeterministicMutator ignores it and stays byte-reproducible.
    const { code, summary } = await gen.generateMutation({
        parentCode,
        surface,
        repoSummary: context.repoSummary ?? '',
        parentScore: context.parentScore ?? 0,
        failedTraces: context.failedTraces ?? [],
        nonce: index, // sibling-diversity nonce (ADR-104)
    });
    // 4) Gate: validate BEFORE writing. Violations are discarded, never written.
    const violations = validateGeneratedCode(code);
    let mutationSummary;
    if (violations.length > 0) {
        // Discard: leave the parent's file unchanged (safe no-op mutation).
        mutationSummary = `mutation rejected by validator; surface unchanged (${violations.join('; ')})`;
    }
    else if (code === parentCode) {
        mutationSummary = `${summary} (no-op: identical to parent)`;
    }
    else {
        await writeFile(filePath, code, 'utf8');
        mutationSummary = summary;
    }
    return {
        id,
        parentId: parent.id,
        generation,
        dir,
        mutationSurface: surface,
        mutationSummary,
        createdAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=mutator.js.map