/**
 * Adapter from the future `rvface-wasm` wasm-pack output to `RvFaceEngine`.
 *
 * The wasm-pack build (`wasm-pack build crates/rvface-wasm --target web
 * --out-dir ../../web/src/wasm`) will drop `rvface_wasm.js` +
 * `rvface_wasm_bg.wasm` into `src/wasm/` (git-ignored). Until then the
 * dynamic import fails and `loadWasmFactory()` returns null — callers fall
 * back to the mock with a visible notice.
 *
 * Expected module surface (ADR-0005):
 *   default init(): Promise<void>              — wasm-bindgen init
 *   RvFace.new(det, lmk, emb, backend) -> Promise<RvFace>
 *   rvface.backend: "cpu" | "webgpu"           — the backend that actually
 *                                                initialized (gpu may fall
 *                                                back to cpu)
 *   rvface.analyze(rgba, w, h, maxFaces) -> JsValue (faces array)
 *   rvface.similarity(f1, f2) -> number (0..100)
 *   rvface.free()
 */

import type {
  BackendKind,
  EngineFactory,
  FaceResult,
  RvFaceEngine,
  WeightBundle,
} from './engine';

/** Shape of the wasm-bindgen glue module we expect. */
interface WasmModule {
  default: (input?: unknown) => Promise<unknown>;
  RvFace: {
    new: (
      detector: Uint8Array,
      landmark: Uint8Array,
      embedder: Uint8Array,
      backend: string,
    ) => Promise<WasmRvFace>;
  };
}

interface WasmRvFace {
  readonly backend: string;
  analyze(rgba: Uint8Array, width: number, height: number, maxFaces: number): unknown;
  similarity(a: Float32Array, b: Float32Array): number;
  free(): void;
}

interface WasmFace {
  box: number[];
  score: number;
  landmarks: number[] | Float32Array;
  pose: { yaw: number; pitch: number; roll: number };
  embedding: number[] | Float32Array;
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
    const raw = (await Promise.resolve(
      this.inner.analyze(rgba, width, height, maxFaces),
    )) as WasmFace[];
    return raw.map((f) => ({
      box: [f.box[0] ?? 0, f.box[1] ?? 0, f.box[2] ?? 0, f.box[3] ?? 0] as [
        number,
        number,
        number,
        number,
      ],
      score: f.score,
      landmarks: f.landmarks instanceof Float32Array ? f.landmarks : new Float32Array(f.landmarks),
      pose: f.pose,
      embedding: f.embedding instanceof Float32Array ? f.embedding : new Float32Array(f.embedding),
    }));
  }

  similarity(a: Float32Array, b: Float32Array): number {
    return this.inner.similarity(a, b);
  }

  dispose(): void {
    this.inner.free();
  }
}

/**
 * Try to load the wasm glue. Returns null (never throws) when the module
 * has not been built yet.
 */
export async function loadWasmFactory(): Promise<EngineFactory | null> {
  let mod: WasmModule;
  try {
    // Opaque specifier + @vite-ignore: the module is git-ignored build
    // output that may not exist, so Vite must neither resolve nor warn
    // about it at bundle time.
    const glue: string = './wasm/rvface_wasm.js';
    const url = new URL(glue, import.meta.url).href;
    mod = (await import(/* @vite-ignore */ url)) as WasmModule;
  } catch {
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
