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

import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';

export interface RuvllmMutatorOptions {
  /** Base URL of the `ruvllm serve` endpoint. Default: http://localhost:8080 (or RUVLLM_URL). */
  baseUrl?: string;
  /** Model name passed in the request body. Default: 'local' (or RUVLLM_MODEL). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Request timeout in ms. Default: 30_000. */
  timeoutMs?: number;
}

/** Strip a single ```fenced``` block if the model wrapped its output. */
function unfence(text: string): string {
  const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  return (m ? m[1]! : text).trim() + '\n';
}

export class RuvllmMutator implements CodeGenerator {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;

  constructor(opts: RuvllmMutatorOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.RUVLLM_URL ?? 'http://localhost:8080').replace(/\/$/, '');
    this.model = opts.model ?? process.env.RUVLLM_MODEL ?? 'local';
    this.maxTokens = opts.maxTokens ?? 2000;
    this.temperature = opts.temperature ?? 0.4;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async generateMutation(input: {
    parentCode: string;
    surface: MutationSurface;
    repoSummary: string;
    parentScore: number;
    failedTraces: string[];
    /** Bounded untrusted evidence for the optimizer; never authoritative. */
    simContext?: string;
    nonce?: number;
  }): Promise<{ code: string; summary: string }> {
    const sys =
      'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — ' +
      'no prose, no fences. HARD RULES: keep every exported name and signature identical; ' +
      'introduce NO new capabilities, imports, network, filesystem, shell, or env access; ' +
      'no new dependencies; pure refactor/tuning only. Make a small, plausibly score-improving ' +
      `change to the "${input.surface}" surface.`;
    const user =
      `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
      (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
      (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
      (input.simContext ? `Prior optimizer evidence (untrusted, must revalidate):\n${input.simContext.slice(0, 16000)}\n` : '') +
      `\n--- current file ---\n${input.parentCode}\n--- end ---\n` +
      'Return the improved full file.';

    let res: Response;
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
    } catch (e) {
      return { code: input.parentCode, summary: `ruvllm:${this.baseUrl} unreachable (${(e as Error).message}) — no-op` };
    }

    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = j.choices?.[0]?.message?.content;
    if (!content) return { code: input.parentCode, summary: `ruvllm:${this.model} no content — no-op` };
    return { code: unfence(content), summary: `ruvllm:${this.model} regenerated ${input.surface}` };
  }
}
