// @metaharness/horizon — loader for the Rust wasm32 control core
// (crate/, built by scripts/build-wasm.mjs into wasm/horizon_core.wasm).
//
// The core is a PURE function: one export, `hz_eval(json) -> json`, dispatching
// on `op`. There is no host import and no ambient authority — it parses a
// request, computes, and returns bytes. That purity is the point: the halt
// state lives in TypeScript (so a session is resumable) and the classifier has
// nothing to reach for (so it is safe to run on adversarial input).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(here, '..', 'wasm', 'horizon_core.wasm');

// Stateless codecs — one shared pair beats allocating per call.
const ENC = new TextEncoder();
const DEC = new TextDecoder();

export class HorizonCore {
  private instance!: WebAssembly.Instance;
  private memView: Uint8Array | null = null;
  private memBuf: ArrayBuffer | null = null;

  private mem(): Uint8Array {
    const buf = this.exports.memory.buffer;
    if (buf !== this.memBuf || this.memView === null) {
      this.memBuf = buf;
      this.memView = new Uint8Array(buf);
    }
    return this.memView;
  }

  static async load(wasmPath: string = WASM_PATH): Promise<HorizonCore> {
    const core = new HorizonCore();
    const bytes = readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    core.instance = instance;
    return core;
  }

  private get exports() {
    return this.instance.exports as {
      memory: WebAssembly.Memory;
      hz_alloc(n: number): number;
      hz_eval(ptr: number, len: number): number;
    };
  }

  private readPacked(ptr: number): string {
    const mem = this.mem();
    const len =
      mem[ptr] | (mem[ptr + 1] << 8) | (mem[ptr + 2] << 16) | (mem[ptr + 3] << 24);
    return DEC.decode(mem.subarray(ptr + 4, ptr + 4 + len));
  }

  /** Evaluate a request object; returns the parsed response object. */
  eval<T = unknown>(request: unknown): T {
    const json = JSON.stringify(request);
    const src = ENC.encode(json);
    const inPtr = this.exports.hz_alloc(src.length); // may detach the buffer
    this.mem().set(src, inPtr);
    const outPtr = this.exports.hz_eval(inPtr, src.length);
    return JSON.parse(this.readPacked(outPtr)) as T;
  }
}
