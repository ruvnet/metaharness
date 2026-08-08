// SPDX-License-Identifier: MIT
//
// RefineMutator — the evidence-backed CRUD proposer (ADR-246 §2.1).
//
// Implements the `CodeGenerator` interface as the ADR-071-anticipated LLM-backed
// generator, with the refine-specific contracts:
//
//   - ONE minimal, bounded edit to ONE surface file — never a wholesale rewrite.
//   - EVIDENCE OR NO-OP: the summary MUST cite the trace IDs that motivated the
//     edit; with no citable evidence the parent is returned unchanged (the
//     anti-ADR-226 guard — mutations are grounded in observed failure, not
//     free-floating advice).
//   - SAME GATE, UNCHANGED: every candidate is run through `validateGeneratedCode`
//     here (defense in depth — `createChildVariant` re-checks); a violation is
//     discarded, never repaired.
//   - SIBLING DIVERSITY (ADR-104): same-surface siblings with distinct nonces
//     produce distinct edits, both offline and via the endpoint prompt.
//
// Dependency-free: uses Node's built-in fetch (Node ≥ 18), mirroring
// RuvllmMutator's client + no-op-on-unreachable contract, so a down endpoint
// never breaks the evolution loop. With NO endpoint configured it falls back to
// a deterministic, bounded, evidence-tagged annotation edit.
import { validateGeneratedCode } from './safety.js';
/** Strip a single ```fenced``` block if the model wrapped its output. */
function unfence(text) {
    const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
    return (m ? m[1] : text).trim() + '\n';
}
/**
 * Parse citable evidence IDs from failed-trace lines. A line's ID is its
 * leading token up to ':' when that token matches /^[\w.-]+$/ (e.g.
 * 'trace-42: null deref' → 'trace-42'); any other non-blank line is citable as
 * 'trace-<lineIndex>'. Blank lines carry no evidence.
 */
export function parseEvidenceIds(failedTraces) {
    const ids = [];
    failedTraces.forEach((line, i) => {
        // Blank means no visible content: strip whitespace AND zero-width/invisible
        // characters (U+200B–U+200D, U+FEFF, U+2060) so invisible-only "evidence"
        // cannot defeat the evidence-or-no-op guard.
        if (!line || line.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').trim().length === 0)
            return;
        const head = line.split(':', 1)[0].trim();
        ids.push(/^[\w.-]+$/.test(head) ? head : `trace-${i}`);
    });
    return ids;
}
/** The rotated offline annotation variants (distinct edit per nonce, ADR-104). */
const ANNOTATION_VARIANTS = [
    'reviewed against failing trace',
    're-reviewed against failing trace; smallest viable fix pending',
    'cross-checked against failing trace; bounded follow-up queued',
];
export class RefineMutator {
    endpoint;
    model;
    timeoutMs;
    constructor(opts = {}) {
        this.endpoint = opts.endpoint?.replace(/\/$/, '');
        this.model = opts.model ?? 'local';
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }
    async generateMutation(input) {
        const { parentCode, surface } = input;
        const nonce = input.nonce ?? 0;
        // ── Evidence or no-op (ADR-246 §2.1, anti-ADR-226 guard). ──
        const evidence = parseEvidenceIds(input.failedTraces);
        if (evidence.length === 0) {
            return { code: parentCode, summary: 'refine: no-op (no citable evidence)' };
        }
        const cited = evidence.slice(0, 5).join(',');
        // ── Propose exactly one bounded candidate edit. ──
        let candidate;
        let rationale;
        if (this.endpoint) {
            const remote = await this.propose(input, evidence, nonce);
            if ('noop' in remote)
                return { code: parentCode, summary: remote.noop };
            candidate = remote.code;
            rationale = `endpoint-proposed minimal edit`;
        }
        else {
            // Deterministic offline fallback: a single bounded, evidence-tagged
            // annotation near the top of the file, rotated by nonce so same-surface
            // siblings differ (ADR-104). Signature-neutral by construction.
            const note = `// refine(${evidence[0]}): ${ANNOTATION_VARIANTS[nonce % ANNOTATION_VARIANTS.length]}\n`;
            candidate = note + parentCode;
            rationale = `annotated ${surface} with evidence tag (offline, nonce ${nonce})`;
        }
        // ── Same gate, unchanged: validate BEFORE anything touches disk. ──
        if (validateGeneratedCode(candidate).length > 0) {
            return { code: parentCode, summary: 'refine: discarded (safety)' };
        }
        return {
            code: candidate,
            summary: `refine[${surface}]: ${rationale} (evidence: ${cited})`,
        };
    }
    /** POST the refine prompt to the OpenAI-compatible endpoint. Any transport,
     *  timeout, or shape failure ⇒ a safe no-op (mirrors RuvllmMutator). */
    async propose(input, evidence, nonce) {
        const sys = 'You refine ONE file of an AI agent harness with ONE minimal bounded edit — never a rewrite. ' +
            'Output ONLY the full replacement file, no prose, no fences. HARD RULES: keep every exported ' +
            'name and signature identical; introduce NO new capabilities, imports, network, filesystem, ' +
            'shell, or env access. The edit MUST be motivated by the cited failing-trace evidence.';
        const user = `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
            `Evidence IDs: ${evidence.join(', ')}\n` +
            `Failing traces:\n${input.failedTraces.slice(0, 5).join('\n')}\n` +
            `Sibling nonce: ${nonce} — siblings with DIFFERENT nonces must take DIFFERENT edit directions; ` +
            `pick the direction indexed by this nonce.\n` +
            `\n--- current file ---\n${input.parentCode}\n--- end ---\n` +
            'Return the minimally-edited full file.';
        let res;
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            res = await fetch(`${this.endpoint}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
                    temperature: 0.2,
                }),
                signal: controller.signal,
            });
        }
        catch (e) {
            return { noop: `refine: ${this.endpoint} unreachable (${e.message}) — no-op` };
        }
        finally {
            clearTimeout(tid);
        }
        if (!res.ok) {
            return { noop: `refine: ${this.endpoint} unreachable (HTTP ${res.status}) — no-op` };
        }
        let content;
        try {
            const j = (await res.json());
            content = j.choices?.[0]?.message?.content;
        }
        catch {
            content = undefined;
        }
        if (!content)
            return { noop: `refine: ${this.endpoint} unreachable/malformed response — no-op` };
        return { code: unfence(content) };
    }
}
//# sourceMappingURL=refine-mutator.js.map