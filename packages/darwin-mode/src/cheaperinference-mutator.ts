// SPDX-License-Identifier: MIT
//
// Cheaper Inference-backed CodeGenerator (ADR-071 §contract) — the LLM mutator that
// "slots in behind the SAME validateGeneratedCode gate" as the DeterministicMutator.
// It asks a model to regenerate ONE surface file, improving it while preserving
// exported signatures and introducing NO new capabilities (so it survives the
// safety gate in createChildVariant). Real Cheaper Inference calls; no fabrication.
//
// Cheaper Inference is an OpenAI-compatible gateway. Key: CHEAPER_INFERENCE_API_KEY
// env, or falls back to /tmp/.cikey. Model: env DARWIN_MUTATOR_MODEL (default
// gpt-5.4-mini; model ids are bare, e.g. claude-sonnet-5 or deepseek-v4-flash).

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeGenerator } from './mutator.js';
import type { MutationSurface } from './types.js';
import type { MutatorTelemetry } from './openrouter-mutator.js';

function apiKey(): string {
  const env = (process.env.CHEAPER_INFERENCE_API_KEY || '').trim();
  if (env) return env;
  // Dev-convenience fallback: a key file in the OS temp dir. Use os.tmpdir() so
  // it resolves cross-platform (path-guard: `/tmp` is Linux-only).
  const keyFile = join(tmpdir(), '.cikey');
  try {
    return readFileSync(keyFile, 'utf8').trim();
  } catch {
    throw new Error(`CheaperInferenceMutator: no CHEAPER_INFERENCE_API_KEY (env or ${keyFile})`);
  }
}

/** Strip a fenced code block if the model wrapped its output. */
function unfence(text: string): string {
  const m = text.match(/```(?:[a-zA-Z0-9]+)?\n([\s\S]*?)\n```/);
  return (m ? m[1] : text).trim() + '\n';
}

export interface CheaperInferenceMutatorOptions {
  model?: string;
  /** Per-call cost/latency cap. */
  maxTokens?: number;
  temperature?: number;
}

export class CheaperInferenceMutator implements CodeGenerator {
  readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  readonly telemetry: MutatorTelemetry = { calls: 0, promptTokens: 0, completionTokens: 0, costUSD: 0 };

  constructor(opts: CheaperInferenceMutatorOptions = {}) {
    this.model = opts.model ?? process.env.DARWIN_MUTATOR_MODEL ?? 'gpt-5.4-mini';
    this.maxTokens = opts.maxTokens ?? 2000;
    this.temperature = opts.temperature ?? 0.4;
  }

  async generateMutation(input: {
    parentCode: string;
    surface: MutationSurface;
    repoSummary: string;
    parentScore: number;
    failedTraces: string[];
  }): Promise<{ code: string; summary: string }> {
    const sys =
      'You improve ONE file of an AI agent harness. Output ONLY the full replacement file — no prose, no fences. ' +
      'HARD RULES: keep every exported name and signature identical; introduce NO new capabilities, imports, network, ' +
      'filesystem, shell, or env access; no new dependencies; pure refactor/tuning only (it must pass a static safety ' +
      'validator that rejects added capabilities). Make a small, plausibly score-improving change to the "' +
      input.surface + '" surface.';
    const user =
      `Surface: ${input.surface}\nParent score: ${input.parentScore}\n` +
      (input.repoSummary ? `Repo: ${input.repoSummary}\n` : '') +
      (input.failedTraces.length ? `Recent failures:\n${input.failedTraces.slice(0, 5).join('\n')}\n` : '') +
      `\n--- current file ---\n${input.parentCode}\n--- end ---\nReturn the improved full file.`;

    let res: Response;
    try {
      res = await fetch('https://api.cheaperinference.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          max_tokens: this.maxTokens,
          temperature: this.temperature,
        }),
      });
    } catch (e) {
      // Network failure → safe no-op (return parent unchanged; the gate sees identity).
      return { code: input.parentCode, summary: `cheaperinference:${this.model} unreachable (${(e as Error).message}) — no-op` };
    }
    const j: any = await res.json();
    if (!j.choices?.[0]?.message?.content) {
      return { code: input.parentCode, summary: `cheaperinference:${this.model} no content — no-op` };
    }
    this.telemetry.calls += 1;
    if (j.usage) {
      this.telemetry.promptTokens += j.usage.prompt_tokens ?? 0;
      this.telemetry.completionTokens += j.usage.completion_tokens ?? 0;
      this.telemetry.costUSD += j.usage.cost ?? 0;
    }
    return {
      code: unfence(j.choices[0].message.content),
      summary: `cheaperinference:${this.model} regenerated ${input.surface}`,
    };
  }
}
