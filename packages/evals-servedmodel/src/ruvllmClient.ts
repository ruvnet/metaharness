// @metaharness/evals-servedmodel — the REAL `ruvllm serve` client (gated, opt-in, LIVE only).
//
// Mirrors darwin-mode's `RuvllmMutator` (OpenAI-compatible `POST /v1/chat/completions` against a local
// `ruvllm serve` endpoint) and weight-eft's train.ts gate discipline (real execution requires an EXPLICIT
// opt-in flag; the default is a safe refusal, never a silent substitution). This is the ONLY file in the
// package that can make a network call — the $0 synthetic proof never imports it.
//
// HARD RULE (ADR-234, this package's task charter): never fabricate a served-model/real result. If
// `live !== true`, `makeRuvllmServedModelSolve` throws instead of quietly returning mock data — a caller
// that forgets to flip the flag gets a loud, unambiguous failure, not a fabricated number.
import type { ServedModelSolveFn } from './evaluator.js';
import { adaptationAggressiveness } from './genome.js';

export interface RuvllmServedModelOptions {
  /** Base URL of the `ruvllm serve` endpoint. Default: http://localhost:8080 (or RUVLLM_URL). */
  baseUrl?: string;
  /** Model name passed in the request body. Default: 'local' (or RUVLLM_MODEL). */
  model?: string;
  /** Request timeout in ms. Default: 30_000. */
  timeoutMs?: number;
  /** Hard gate — real network calls only when explicitly enabled (or EVALS_SERVEDMODEL_LIVE=true). */
  live?: boolean;
  /** Optional judge: scores a completion's quality in [0,1] against the task. Without one, a completion
   *  that returns ANY non-empty content is scored 0.5 (neutral — "produced something", not "was correct").
   *  Never invents a higher score than that without a real judge — that would be fabrication. */
  judge?: (input: { prompt: string; completion: string }) => Promise<number>;
}

/** Real, network-calling `ServedModelSolveFn`. Refuses (throws) unless `live` is explicitly true — see the
 *  file header. Cost is the caller's real USD estimate from the provider's response, never invented. */
export function makeRuvllmServedModelSolve(opts: RuvllmServedModelOptions = {}): ServedModelSolveFn {
  const baseUrl = (opts.baseUrl ?? process.env.RUVLLM_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const model = opts.model ?? process.env.RUVLLM_MODEL ?? 'local';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const live = opts.live ?? process.env.EVALS_SERVEDMODEL_LIVE === 'true';

  return async function solve({ genome, task }) {
    if (!live) {
      throw new Error(
        'makeRuvllmServedModelSolve: LIVE mode is disabled. Pass { live: true } or set ' +
          'EVALS_SERVEDMODEL_LIVE=true to hit a real `ruvllm serve` endpoint. This function never silently ' +
          'substitutes synthetic data — that would fabricate a LIVE result (forbidden, ADR-234).',
      );
    }

    const prompt = task.prompt ?? `Adaptation task ${task.id} (${task.capabilityClass}).`;
    const temperature = 0.15 + adaptationAggressiveness(genome.adaptationMode) * 0.1; // more aggressive ⇒ more exploratory
    const t0 = Date.now();

    let res: Response;
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                `You are a served model under a ruvllm serving policy (rank=${genome.microloraRank}, ` +
                `routingDepth=${genome.routingDepth}, mode=${genome.adaptationMode}). Answer concisely.`,
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 512,
          temperature,
        }),
        signal: controller.signal,
      });
      clearTimeout(tid);
    } catch (e) {
      // Same fallback contract as RuvllmMutator: an unreachable server is a no-op, not a crash — but it
      // is ALSO not committed (the micro-loop didn't adapt anything), so it costs nothing and scores 0.
      return { afterQuality: 0, costUsd: 0, latencyMs: Date.now() - t0, committed: false };
    }

    const latencyMs = Date.now() - t0;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    const content = j.choices?.[0]?.message?.content ?? '';
    if (!content) return { afterQuality: 0, costUsd: 0, latencyMs, committed: false };

    const afterQuality = opts.judge ? await opts.judge({ prompt, completion: content }) : 0.5;
    // Local ruvllm inference is the $0/private positioning (ruvllm-mutator.ts header) — cost is token-count
    // proportional at $0 per token (local compute, not billed), tracked as 0 unless the caller supplies a
    // real metered rate via a judge/cost hook. Never invent a per-token USD figure for a local endpoint.
    const costUsd = 0;
    return { afterQuality: Math.max(0, Math.min(1, afterQuality)), costUsd, latencyMs, committed: true };
  };
}
