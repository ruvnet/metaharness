// SPDX-License-Identifier: MIT
//
// Optional in-browser embeddings via Transformers.js (MiniLM). This is the
// implemented form of the `semantic` term reserved in ADR-023: it RECOMMENDS,
// it never generates. It is:
//
//   - lazy: the ~25 MB model + onnxruntime are dynamically imported, so they
//     are a separate chunk that never loads unless the user opts in. The
//     default Repo→Harness path stays on the deterministic lexical proxy, so
//     CI, e2e, and the Pages deploy never download a model.
//   - WebGPU-first, WASM-fallback: picks the fastest backend the browser has.
//   - deterministic-enough: embeddings are mean-pooled + L2-normalised and the
//     cosine score is ROUNDED (round3) before it enters the weighted formula,
//     so float jitter does not flip a ranking. Greedy inference, no sampling.
//
// The model is `Xenova/all-MiniLM-L6-v2` — 384-dim, the canonical lightweight
// sentence embedder, fetched from the HF hub and cached in the browser.

import type { Archetype, RepoProfile } from './repo';

export type EmbeddingBackend = 'webgpu' | 'wasm';

export interface EmbedOptions {
  backend?: EmbeddingBackend;
  onProgress?: (p: { status: string; progress?: number; file?: string }) => void;
}

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>;

let extractorPromise: Promise<Extractor> | null = null;

/** True when the browser exposes WebGPU. */
export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/** Lazily load (and cache) the feature-extraction pipeline. Heavy import. */
export async function loadEmbedder(opts: EmbedOptions = {}): Promise<Extractor> {
  if (!extractorPromise) {
    const backend = opts.backend ?? (hasWebGPU() ? 'webgpu' : 'wasm');
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Always fetch from the hub (no bundled local models); browser caches it.
      env.allowLocalModels = false;
      const extractor = (await pipeline('feature-extraction', MODEL_ID, {
        device: backend,
        progress_callback: opts.onProgress,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as unknown as Extractor;
      return extractor;
    })();
  }
  return extractorPromise;
}

/** Embed a batch of texts → L2-normalised mean-pooled vectors. */
export async function embed(texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  const extractor = await loadEmbedder(opts);
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

// --- pure helpers (unit-tested, no model) ----------------------------------

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Round to 3 decimals — the determinism guard for the semantic term. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The text used to represent a repo for embedding. */
export function profileText(profile: RepoProfile): string {
  return [profile.name, profile.languages.join(' '), profile.tokens.join(' ')].join(' ').slice(0, 4000);
}

/** The text used to represent an archetype. */
export function archetypeText(a: Archetype): string {
  return `${a.label}. ${a.description} ${a.keywords.join(' ')}`;
}

/**
 * Compute per-archetype semantic similarity in [0,1], rounded for stability.
 * Returns a map archetype.id -> score that can be passed straight into
 * `scoreArchetypes(profile, semantic)`.
 */
export async function semanticScores(
  profile: RepoProfile,
  archetypes: Archetype[],
  opts: EmbedOptions = {},
): Promise<Record<string, number>> {
  const texts = [profileText(profile), ...archetypes.map(archetypeText)];
  const vecs = await embed(texts, opts);
  const q = vecs[0]!;
  const out: Record<string, number> = {};
  archetypes.forEach((a, i) => {
    out[a.id] = round3(clamp01(cosine(q, vecs[i + 1]!)));
  });
  return out;
}
