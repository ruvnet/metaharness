/**
 * Adapter from the `rvface-wasm` wasm-bindgen output to `RvFaceEngine`.
 *
 * `web/build-wasm.sh` (cargo -> wasm-bindgen --target web -> wasm-opt)
 * drops `rvface_wasm.js` + `rvface_wasm_bg.wasm` into `src/wasm/`
 * (git-ignored). The import below is a real Vite-resolved dynamic import,
 * so the built app bundles the glue + wasm asset; if the module is absent
 * `loadWasmFactory()` returns null and `main.ts` shows an error state
 * (there is no mock fallback).
 *
 * Binding surface (see `crates/rvface-wasm/src/lib.rs`):
 *   default init(): Promise<void>                 — wasm-bindgen init
 *   RvFace.new(det, lmk, emb, lmkManifest, embManifest, backend)
 *       -> Promise<RvFace>                        — backend "cpu" | "webgpu"
 *   rvface.backend: "cpu" | "webgpu"              — the backend that actually
 *                                                   initialized (webgpu falls
 *                                                   back to cpu, never fails)
 *   rvface.analyze(rgba, w, h, maxFaces) -> Promise<Float32Array>
 *   rvface.similarity(a, b) -> number (0..100)
 *   rvface.free()
 *
 * `analyze` returns one flat Float32Array (no serde round-trip, ADR-0005):
 *   [ nFaces, then per face:
 *     x1, y1, x2, y2, score, yaw, pitch, roll,    (8)
 *     136 landmark floats (x0,y0,...),            (136)
 *     embLen, embLen embedding floats ]
 */

import type {
  BackendKind,
  EngineFactory,
  FaceResult,
  RvFaceEngine,
  WeightBundle,
} from './engine';

/** Shape of the wasm-bindgen glue module we consume. */
interface WasmModule {
  default: (input?: unknown) => Promise<unknown>;
  RvFace: {
    // A static method literally named "new" (wasm-bindgen async ctor),
    // not a construct signature — hence the quotes.
    'new'(
      detector: Uint8Array,
      landmark: Uint8Array,
      embedder: Uint8Array,
      landmarkManifest: string,
      embedderManifest: string,
      backend: string,
    ): Promise<WasmRvFace>;
  };
}

interface WasmRvFace {
  readonly backend: string;
  analyze(
    rgba: Uint8Array,
    width: number,
    height: number,
    maxFaces: number,
  ): Promise<Float32Array>;
  similarity(a: Float32Array, b: Float32Array): number;
  free(): void;
}

/** Floats per face before the variable-length embedding: box+score+pose+landmarks+embLen. */
const FACE_HEADER = 8;
const LANDMARK_FLOATS = 136;

/** Unpacks the flat `analyze` payload documented above. */
function unpackFaces(packed: Float32Array): FaceResult[] {
  const faces: FaceResult[] = [];
  let o = 0;
  const n = packed[o++] ?? 0;
  for (let i = 0; i < n; i++) {
    const box: [number, number, number, number] = [
      packed[o] ?? 0,
      packed[o + 1] ?? 0,
      packed[o + 2] ?? 0,
      packed[o + 3] ?? 0,
    ];
    const score = packed[o + 4] ?? 0;
    const pose = {
      yaw: packed[o + 5] ?? 0,
      pitch: packed[o + 6] ?? 0,
      roll: packed[o + 7] ?? 0,
    };
    o += FACE_HEADER;
    const landmarks = packed.slice(o, o + LANDMARK_FLOATS);
    o += LANDMARK_FLOATS;
    const embLen = packed[o++] ?? 0;
    const embedding = packed.slice(o, o + embLen);
    o += embLen;
    faces.push({ box, score, landmarks, pose, embedding });
  }
  return faces;
}

class WasmEngine implements RvFaceEngine {
  readonly kind = 'wasm' as const;
  readonly backend: BackendKind;

  constructor(private readonly inner: WasmRvFace) {
    this.backend = inner.backend === 'webgpu' ? 'webgpu' : 'cpu';
  }

  async analyze(
    rgba: Uint8Array,
    width: number,
    height: number,
    maxFaces: number,
  ): Promise<FaceResult[]> {
    const packed = await this.inner.analyze(rgba, width, height, maxFaces);
    return unpackFaces(packed);
  }

  similarity(a: Float32Array, b: Float32Array): number {
    return this.inner.similarity(a, b);
  }

  dispose(): void {
    this.inner.free();
  }
}

/**
 * Load the wasm glue. Returns null (never throws) when the module could
 * not be loaded — the caller surfaces the error state.
 */
export async function loadWasmFactory(): Promise<EngineFactory | null> {
  let mod: WasmModule;
  try {
    mod = (await import('./wasm/rvface_wasm.js')) as unknown as WasmModule;
  } catch (err) {
    console.error('rvface wasm module failed to load:', err);
    return null;
  }

  return {
    kind: 'wasm',
    async create(
      backend: BackendKind,
      weights: WeightBundle,
      onProgress?: (msg: string) => void,
    ): Promise<RvFaceEngine> {
      onProgress?.('initializing wasm module…');
      await mod.default();
      onProgress?.(`creating RvFace (requested backend: ${backend})…`);
      const inner = await mod.RvFace.new(
        weights.detector,
        weights.landmark,
        weights.embedder,
        weights.landmarkManifest,
        weights.embedderManifest,
        backend,
      );
      const engine = new WasmEngine(inner);
      if (engine.backend !== backend) {
        onProgress?.(`backend "${backend}" unavailable — wasm fell back to "${engine.backend}"`);
      }
      return engine;
    },
  };
}
