// SPDX-License-Identifier: MIT
//
// RuvllmMutator — local ruvllm server backend for Darwin Mode (ADR-259).
//
// Implements the `CodeGenerator` interface against a local `ruvllm serve` endpoint
// (OpenAI-compatible `POST /v1/chat/completions`). This makes evolution **fully local,
// air-gapped, and zero-API-cost** — no `OPENROUTER_API_KEY`, no public network. On-thesis
// for the "runs anywhere / cost optimizer" positioning.
//
// NOTE on value (honest, per ADR-087): the mutator is NOT the quality lever — the
// deterministic and frontier-LLM mutators both hit the 0.985 scorer ceiling. So
// RuvllmMutator's benefit is *operational* (local/free/private), not higher scores.
//
// Zero runtime dependencies; uses Node's built-in fetch (Node ≥ 18). Falls back to a
// safe no-op (returns the parent code unchanged) if the server is unreachable — the
// same contract as OpenRouterMutator, so a down server never breaks the evolution loop.
/** Strip a single ```fenced``` block if the model wrapped its output. */
function unfence(text) {
    const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
    return (m ? m[1] : text).trim() + '\n';
}
export class RuvllmMutator {
    baseUrl;
    model;
    maxTokens;
    temperature;
    timeoutMs;
    constructor(opts = {}) {
        this.baseUrl = (opts.baseUrl ?? process.env.RUVLLM_URL ?? 'http://localhost:8080').replace(/\/$/, '');
        this.model = opts.model ?? process.env.RUVLLM_MODEL ?? 'local';
        this.maxTokens = opts.maxTokens ?? 2000;
        this.temperature = opts.temperature ?? 0.4;
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }
    async generateMutation(input) {
        const sys = 'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — ' +
            'no prose, no fences. HARD RULES: keep every exported name and signature identical; ' +
            'introduce NO new capabilities, imports, network, filesystem, shell, or env access; ' +
            'no new dependencies; pure refactor/tuning only. Make a small, plausibly score-improving ' +
            `change to the "${input.surface}" surface.`;
        const user = `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
            (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
            (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
            `\n--- current file ---\n${input.parentCode}\n--- end ---\n` +
            'Return the improved full file.';
        let res;
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), this.timeoutMs);
            res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                }),
                signal: controller.signal,
            });
            clearTimeout(tid);
        }
        catch (e) {
            return { code: input.parentCode, summary: `ruvllm:${this.baseUrl} unreachable (${e.message}) — no-op` };
        }
        const j = (await res.json());
        const content = j.choices?.[0]?.message?.content;
        if (!content)
            return { code: input.parentCode, summary: `ruvllm:${this.model} no content — no-op` };
        return { code: unfence(content), summary: `ruvllm:${this.model} regenerated ${input.surface}` };
    }
}
//# sourceMappingURL=ruvllm-mutator.js.map