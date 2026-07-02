/**
 * Engine contract — the integration seam between the UI and the
 * rvFACE pipeline. Mirrors the wasm API of ADR-0005; `engine-mock.ts`
 * implements it today, `engine-wasm.ts` adapts the real wasm-pack
 * output to it later. The UI only ever talks to `RvFaceEngine`.
 */

export type BackendKind = 'cpu' | 'webgpu';

/** Which implementation is behind the interface (shown in the status badge). */
export type EngineKind = 'mock' | 'wasm';

export interface Pose {
  /** Degrees. Positive yaw = face turned to its left (image right). */
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FaceResult {
  /** Pixel-space [x1, y1, x2, y2] in the analyzed image. */
  box: [number, number, number, number];
  /** Detector confidence, 0..1. */
  score: number;
  /** 68 landmarks, packed [x0, y0, x1, y1, ...] — 136 floats, pixel space. */
  landmarks: Float32Array;
  /** Head pose solved from the landmarks. */
  pose: Pose;
  /** L2-normalized feature embedding (upstream IRN-50 style). */
  embedding: Float32Array;
}

export interface RvFaceEngine {
  /** Backend that actually initialized (wasm may fall back webgpu -> cpu). */
  readonly backend: BackendKind;
  /** Which implementation this is. */
  readonly kind: EngineKind;
  /**
   * Full pipeline: detect -> landmarks -> pose -> align -> embed.
   * `rgba` is tightly-packed RGBA8, `width * height * 4` bytes.
   * Faces are returned sorted by score, at most `maxFaces`.
   */
  analyze(
    rgba: Uint8Array,
    width: number,
    height: number,
    maxFaces: number,
  ): Promise<FaceResult[]>;
  /** Upstream similarity: (dot(a, b) + 1) * 50, 0..100, match > 75. */
  similarity(a: Float32Array, b: Float32Array): number;
  /** Release backend resources (GPU buffers, wasm memory). */
  dispose(): void;
}

/** Raw safetensors bytes for the three networks, fetched by `weights.ts`. */
export interface WeightBundle {
  detector: Uint8Array;
  landmark: Uint8Array;
  embedder: Uint8Array;
}

export interface EngineFactory {
  /** Which implementation this factory produces. */
  readonly kind: EngineKind;
  /**
   * Initialize an engine. Must resolve even if the requested backend is
   * unavailable — implementations fall back to CPU and report the live
   * backend via `engine.backend` (ADR-0005: never hard-fail for lack of GPU).
   */
  create(
    backend: BackendKind,
    weights: WeightBundle,
    onProgress?: (msg: string) => void,
  ): Promise<RvFaceEngine>;
}

/** Upstream verdict threshold (score > 75 = same person). */
export const MATCH_THRESHOLD = 75;
