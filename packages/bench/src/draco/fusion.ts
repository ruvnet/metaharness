// SPDX-License-Identifier: MIT
//
// DRACO M2 — OpenRouter fusion client (ADR-037 §2).
//
// The research harness routes each pipeline stage to a DIFFERENT model class
// via OpenRouter, then fuses. Fusion's whole point: the adversarial
// fact-checker runs on a different model FAMILY than the synthesizer, so a
// single model's blind spot cannot pass its own work.
//
// This module is the routing + provenance layer. It is dependency-injected
// (the OpenRouter HTTP call is passed in) so the full pipeline is testable
// OFFLINE with a mock — no live API key needed for unit tests. The live path
// reads OPENROUTER_API_KEY from the environment (sourced from GCP Secret
// Manager via the publish-time gate; see scripts/validate-gcp-secrets.mjs and
// ADR-018/iter-145 REQUIRED_SECRETS).
//
// NOTHING here computes or claims a DRACO score — that is M3 (deterministic
// scorer) + M4 (LLM-judge). M2 produces the FUSED ANSWER + provenance only.

/** The six DRACO pipeline stages, in execution order (ADR-037 §2). */
export const FUSION_STAGES = [
  'decompose',   // question → sub-queries
  'search',      // collect sources
  'grade',       // grade source quality
  'synthesize',  // write the dossier (load-bearing)
  'verify',      // adversarial fact-check — DIFFERENT model family
  'cite',        // normalise citations
] as const;

export type FusionStage = (typeof FUSION_STAGES)[number];

/** OpenRouter model id per stage, e.g. { synthesize: 'anthropic/claude-opus-4', ... }. */
export type FusionModelMap = Record<FusionStage, string>;

/**
 * A reasonable default model assignment. The KEY invariant DRACO measures:
 * `verify` MUST be a different model family than `synthesize` (fusion). The
 * helper `assertFusionDistinct` enforces it.
 */
export const DEFAULT_FUSION_MODELS: FusionModelMap = {
  decompose: 'anthropic/claude-haiku-4.5',
  search: 'anthropic/claude-haiku-4.5',
  grade: 'anthropic/claude-sonnet-4',
  synthesize: 'anthropic/claude-opus-4',
  verify: 'openai/gpt-5', // DIFFERENT family than synthesize — fusion's point
  cite: 'anthropic/claude-haiku-4.5',
};

/** Extract the provider/family prefix of an OpenRouter model id (before the '/'). */
export function modelFamily(modelId: string): string {
  const slash = modelId.indexOf('/');
  return slash === -1 ? modelId : modelId.slice(0, slash);
}

/**
 * Fusion is only "fusion" if the verifier is a different model family than the
 * synthesizer. Throws otherwise — a config that verifies with the same family
 * is single-model-with-extra-steps, not fusion, and would silently inflate the
 * DRACO score. ADR-037 §2.
 */
export function assertFusionDistinct(models: FusionModelMap): void {
  const synth = modelFamily(models.synthesize);
  const verify = modelFamily(models.verify);
  if (synth === verify) {
    throw new Error(
      `DRACO fusion requires the verifier (${models.verify}) to be a DIFFERENT model family ` +
        `than the synthesizer (${models.synthesize}); both are "${synth}". ` +
        `A same-family verifier is single-model-with-extra-steps, not fusion (ADR-037 §2).`,
    );
  }
}

/** One OpenRouter chat message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The injected transport: given a model id + messages, returns the assistant
 * text + token usage. The live implementation POSTs to OpenRouter; tests pass
 * a mock. Keeping this an interface is what makes the pipeline offline-testable.
 */
export interface OpenRouterTransport {
  (modelId: string, messages: ChatMessage[]): Promise<{ text: string; tokens: number }>;
}

/** Provenance for one stage: which model ran it + tokens spent. */
export interface StageProvenance {
  stage: FusionStage;
  model: string;
  family: string;
  tokens: number;
}

export interface FusionResult {
  questionId: string;
  /** The fused dossier text (synthesize stage, after verify feedback). */
  answer: string;
  /** Per-stage provenance — which model handled each stage. */
  provenance: StageProvenance[];
  /** Total tokens across all stages. */
  totalTokens: number;
}

/**
 * Build the live OpenRouter transport. Reads OPENROUTER_API_KEY from env (the
 * GCP-secret-gated key). Uses the global fetch (Node 20+). Exported separately
 * so the pure pipeline above stays transport-agnostic + testable.
 */
export function openRouterTransport(opts: {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
} = {}): OpenRouterTransport {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  const baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
  const doFetch = opts.fetchImpl ?? fetch;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is required for the live DRACO fusion transport. ' +
        'Source it from GCP Secret Manager (REQUIRED_SECRETS=OPENROUTER_API_KEY) — ' +
        'never hardcode it. For offline tests, inject a mock OpenRouterTransport instead.',
    );
  }
  return async (modelId, messages) => {
    const res = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: modelId, messages }),
    });
    if (!res.ok) {
      throw new Error(`OpenRouter ${modelId} → HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      tokens: json.usage?.total_tokens ?? 0,
    };
  };
}

/**
 * Run the fusion pipeline for one DRACO question. Pure w.r.t. the transport:
 * every model call goes through `transport`, so a test can drive the whole
 * 6-stage flow with a deterministic mock. Records provenance per stage.
 *
 * This produces the fused ANSWER + provenance. Scoring is M3/M4 — not here.
 */
export async function fuseResearch(
  question: { id: string; prompt: string },
  models: FusionModelMap,
  transport: OpenRouterTransport,
  opts: { enforceFusion?: boolean } = {},
): Promise<FusionResult> {
  // enforceFusion defaults to true (a real fusion run REQUIRES an independent
  // verifier). The single-model HARNESS arm of the ablation runs the same
  // 6-stage pipeline with one model on every stage — intentionally NOT fusion —
  // so it opts out (enforceFusion:false) to measure "structure without fusion".
  if (opts.enforceFusion !== false) assertFusionDistinct(models);
  const provenance: StageProvenance[] = [];
  let totalTokens = 0;

  // Helper to run a stage + record provenance.
  const run = async (stage: FusionStage, messages: ChatMessage[]): Promise<string> => {
    const { text, tokens } = await transport(models[stage], messages);
    provenance.push({ stage, model: models[stage], family: modelFamily(models[stage]), tokens });
    totalTokens += tokens;
    return text;
  };

  const subQueries = await run('decompose', [
    { role: 'system', content: 'Decompose the research question into independent searchable sub-queries. Return one per line.' },
    { role: 'user', content: question.prompt },
  ]);
  const sources = await run('search', [
    { role: 'system', content: 'For each sub-query, list the primary sources you would consult, with URLs.' },
    { role: 'user', content: subQueries },
  ]);
  const graded = await run('grade', [
    { role: 'system', content: 'Grade each source for authority, recency, and independence. Drop weak ones.' },
    { role: 'user', content: sources },
  ]);
  let answer = await run('synthesize', [
    { role: 'system', content: 'Write the dossier strictly from the graded evidence. Every non-obvious claim carries a citation. Show disagreements rather than averaging them.' },
    { role: 'user', content: `Question: ${question.prompt}\n\nGraded sources:\n${graded}` },
  ]);
  const verdict = await run('verify', [
    { role: 'system', content: 'Adversarially verify each load-bearing claim in the dossier against its cited source. Label each SUPPORTED, WEAK, or UNSUPPORTED. Flag any citation you cannot confirm.' },
    { role: 'user', content: answer },
  ]);
  // Fuse: fold the verifier's feedback back into the synthesis. This is the
  // load-bearing OUTPUT — the strong synthesizer owns the dossier. A downstream
  // stage may REFINE it but must never be allowed to silently discard it.
  const folded = await run('synthesize', [
    { role: 'system', content: 'Revise the dossier to address the verifier feedback: drop or soften UNSUPPORTED claims, strengthen WEAK ones, remove unconfirmable citations. Return the FULL revised dossier — do not summarise or shorten it.' },
    { role: 'user', content: `Dossier:\n${answer}\n\nVerifier feedback:\n${verdict}` },
  ]);
  answer = folded;

  // Citation normalisation is a REFINEMENT pass, not a rewrite. A (often
  // cheaper) cite model that returns a fraction of the dossier has summarised
  // or truncated it, not normalised it — in that case keep the folded dossier.
  // Without this guard a weak final stage collapses the whole answer (observed
  // live: fusion coverage 0.70 → 0.10 when cite=haiku re-emitted the dossier).
  const cited = await run('cite', [
    { role: 'system', content: 'Normalise every citation in the dossier below to a consistent format. Return the ENTIRE dossier verbatim with ONLY the citations reformatted — do NOT summarise, shorten, or omit any section.' },
    { role: 'user', content: answer },
  ]);
  // Adopt the cite output only if it preserved the dossier (≥70% of length).
  answer = cited.length >= folded.length * 0.7 ? cited : folded;

  return { questionId: question.id, answer, provenance, totalTokens };
}
