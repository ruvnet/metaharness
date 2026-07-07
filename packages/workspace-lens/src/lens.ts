// SPDX-License-Identifier: MIT
//
// WorkspaceLens — the runtime engine. Loads a fitted LensArtifact and, given a captured hidden state
// h_l, computes lens_l(h) = unembed(J_l · h) → workspace tokens. The intermediate J-projection z_l =
// J_l · h (the activation mapped into final-layer coordinates) is also exposed, because the vectorized
// safety triggers compare z_l to concept directions rather than decoding the whole vocabulary.

import type { LensArtifact, HiddenState, WorkspaceReadout, WorkspaceToken } from './types.js';
import { matVec, softmax, entropy, topKIndices } from './linalg.js';

export class WorkspaceLens {
  private readonly byLayer: Map<number, readonly (readonly number[])[]>;

  private constructor(readonly artifact: LensArtifact) {
    this.byLayer = new Map(artifact.layers.map((l) => [l.layer, l.jacobian]));
    this.validate();
  }

  /** Build a lens from an in-memory artifact (validated eagerly so a bad artifact fails at load). */
  static fromArtifact(artifact: LensArtifact): WorkspaceLens {
    return new WorkspaceLens(artifact);
  }

  /**
   * Load a fitted lens from a JSON file. (Binary/registry formats — e.g. a Neuronpedia pre-fit — are a
   * follow-up; the on-disk contract is just a serialized `LensArtifact`.) Kept out of the constructor so
   * the core stays sync + I/O-free for hot-path use.
   */
  static async fromFile(path: string): Promise<WorkspaceLens> {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path, 'utf-8');
    return new WorkspaceLens(JSON.parse(raw) as LensArtifact);
  }

  /**
   * Load a fitted lens over HTTP — fetch a serialized `LensArtifact` JSON from any URL (a CDN, an
   * artifact store, a raw gist). The typical deploy path: fit a lens offline, publish the artifact,
   * `fromUrl` it at startup. Inject `fetchImpl` for tests or non-global-fetch runtimes (defaults to the
   * global `fetch`). Fails loudly on a non-2xx response so a bad URL never silently yields a broken lens.
   */
  static async fromUrl(url: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<WorkspaceLens> {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`WorkspaceLens.fromUrl: ${url} → HTTP ${res.status}`);
    return new WorkspaceLens((await res.json()) as LensArtifact);
  }

  /**
   * Convenience: load a lens by NAME from a registry base URL (e.g. a CDN of community pre-fit lenses).
   * No registry is hardcoded — the caller supplies `baseUrl`, and the artifact is fetched from
   * `${baseUrl}/${name}.json`. Keeps the package free of any assumed/embedded endpoint.
   */
  static async fromRegistry(
    name: string,
    opts: { baseUrl: string; fetchImpl?: typeof fetch },
  ): Promise<WorkspaceLens> {
    // Strip trailing slashes with a linear loop (NOT a `/\/+$/` regex — that backtracks on many-slash
    // input, a ReDoS the CodeQL js/redos-on-library-input query flags).
    let base = opts.baseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    return WorkspaceLens.fromUrl(`${base}/${encodeURIComponent(name)}.json`, { fetchImpl: opts.fetchImpl });
  }

  get modelId(): string { return this.artifact.modelId; }
  get lensId(): string { return this.artifact.lensId; }
  get dModel(): number { return this.artifact.dModel; }
  /** Layer indices this lens can read, ascending. */
  get layers(): number[] { return [...this.byLayer.keys()].sort((a, b) => a - b); }

  private validate(): void {
    const { dModel, unembed, vocab, layers } = this.artifact;
    if (dModel <= 0) throw new Error('lens artifact: dModel must be positive');
    if (vocab.length === 0) throw new Error('lens artifact: empty vocab');
    if (unembed.length !== vocab.length) {
      throw new Error(`lens artifact: unembed rows ${unembed.length} != vocab ${vocab.length}`);
    }
    if (unembed[0]?.length !== dModel) {
      throw new Error(`lens artifact: unembed cols ${unembed[0]?.length} != dModel ${dModel}`);
    }
    if (layers.length === 0) throw new Error('lens artifact: no fitted layers');
    for (const l of layers) {
      if (l.jacobian.length !== dModel || l.jacobian[0]?.length !== dModel) {
        throw new Error(`lens artifact: layer ${l.layer} jacobian is not ${dModel}×${dModel}`);
      }
    }
  }

  /** True if the lens has a fitted operator for this layer. */
  hasLayer(layer: number): boolean { return this.byLayer.has(layer); }

  /**
   * z_l = J_l · h — the activation projected into final-layer coordinates. This is the quantity the
   * Jacobian Lens corrects for (vs. logit-lens reading h directly). Throws if the layer is un-fitted or
   * the width is wrong.
   */
  project(state: HiddenState): number[] {
    const j = this.byLayer.get(state.layer);
    if (!j) throw new Error(`lens has no fitted operator for layer ${state.layer}`);
    if (state.h.length !== this.dModel) {
      throw new Error(`hidden state width ${state.h.length} != dModel ${this.dModel}`);
    }
    return matVec(j, state.h);
  }

  /**
   * Full readout: lens_l(h) = unembed(J_l · h), returned as the top-k workspace tokens + the readout
   * entropy. `topK` bounds the returned tokens; the entropy is over the FULL distribution.
   */
  readout(state: HiddenState, topK = 10): WorkspaceReadout {
    const z = this.project(state);
    const logits = matVec(this.artifact.unembed, z);
    const probs = softmax(logits);
    const idx = topKIndices(logits, topK);
    const tokens: WorkspaceToken[] = idx.map((vi, rank) => ({
      token: this.artifact.vocab[vi],
      rank,
      logit: logits[vi],
      prob: probs[vi],
    }));
    return { layer: state.layer, position: state.position, tokens, entropy: entropy(probs) };
  }
}
