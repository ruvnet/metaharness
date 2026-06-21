// SPDX-License-Identifier: MIT
//
// OpenRouter-backed CodeGenerator (ADR-071 §contract) — the LLM mutator that
// "slots in behind the SAME validateGeneratedCode gate" as the DeterministicMutator.
// It asks a model to regenerate ONE surface file, improving it while preserving
// exported signatures and introducing NO new capabilities (so it survives the
// safety gate in createChildVariant). Real OpenRouter calls; no fabrication.
//
// Key: OPENROUTER_API_KEY env, or falls back to /tmp/.orkey. Model: env
// DARWIN_MUTATOR_MODEL (default google/gemini-2.5-flash — the measured best
// quality-per-dollar code model on TypeScript, the mutator's output language;
// see ADR-085 polyglot benchmark. NOTE: do NOT default to haiku-4.5 if the
// harness ever emits a compiled language — it fails to compile Rust/C++/C there).
import { readFileSync } from 'node:fs';
function apiKey() {
    const env = (process.env.OPENROUTER_API_KEY || '').trim();
    if (env)
        return env;
    try {
        return readFileSync('/tmp/.orkey', 'utf8').trim();
    }
    catch {
        throw new Error('OpenRouterMutator: no OPENROUTER_API_KEY (env or /tmp/.orkey)');
    }
}
/** Strip a fenced code block if the model wrapped its output. */
function unfence(text) {
    const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
    return (m ? m[1] : text).trim() + '\n';
}
export class OpenRouterMutator {
    model;
    maxTokens;
    temperature;
    telemetry = { calls: 0, promptTokens: 0, completionTokens: 0, costUSD: 0 };
    constructor(opts = {}) {
        this.model = opts.model ?? process.env.DARWIN_MUTATOR_MODEL ?? 'google/gemini-2.5-flash';
        this.maxTokens = opts.maxTokens ?? 2000;
        this.temperature = opts.temperature ?? 0.4;
    }
    async generateMutation(input) {
        const sys = 'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — no prose, no fences. ' +
            'HARD RULES: keep every exported name and signature identical; introduce NO new capabilities, imports, network, ' +
            'filesystem, shell, or env access; no new dependencies; pure refactor/tuning only (it must pass a static safety ' +
            'validator that rejects added capabilities). Make a small, plausibly score-improving change to the "' +
            input.surface + '" surface.';
        const user = `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
            (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
            (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
            `\n--- current file ---\n${input.parentCode}\n--- end ---\nReturn the improved full file.`;
        let res;
        try {
            res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                }),
            });
        }
        catch (e) {
            // Network failure → safe no-op (return parent unchanged; the gate sees identity).
            return { code: input.parentCode, summary: `openrouter:${this.model} unreachable (${e.message}) — no-op` };
        }
        const j = await res.json();
        if (!j.choices?.[0]?.message?.content) {
            return { code: input.parentCode, summary: `openrouter:${this.model} no content — no-op` };
        }
        this.telemetry.calls += 1;
        if (j.usage) {
            this.telemetry.promptTokens += j.usage.prompt_tokens ?? 0;
            this.telemetry.completionTokens += j.usage.completion_tokens ?? 0;
            this.telemetry.costUSD += j.usage.cost ?? 0;
        }
        return {
            code: unfence(j.choices[0].message.content),
            summary: `openrouter:${this.model} regenerated ${input.surface}`,
        };
    }
}
//# sourceMappingURL=openrouter-mutator.js.map