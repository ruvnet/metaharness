// @metaharness/oo-agents — loader + host bridge for the Rust wasm32 cell VM
// (crate/, built by scripts/build-wasm.mjs into wasm/ooa_cell_vm.wasm).
//
// The VM is the sandbox: no filesystem, no network, no clock, fuel-bounded.
// Its ONE window to the world is the `ooa_host_call` import, which this module
// answers from the bound agent object — `self.method(args)` dispatches a
// capability, `self.field` reads state. The whole bridge speaks JSON, so
// everything crossing the boundary is inspectable and loggable.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CellOutcome {
  kind: 'result' | 'signal' | 'error';
  value?: unknown;
  message?: string;
  prints: string[];
}

export interface HostBinding {
  /** Read a state field; throw for unknown fields. */
  getField(name: string): unknown;
  /** Invoke a capability method; throw on error (message reaches the model). */
  callMethod(name: string, args: unknown[]): unknown;
}

const here = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(here, '..', 'wasm', 'ooa_cell_vm.wasm');

// Codecs are stateless for encode/decode — one shared pair beats allocating a
// fresh TextEncoder/TextDecoder on every host call (a hot path: one round-trip
// per `self.method()` the model writes).
const ENC = new TextEncoder();
const DEC = new TextDecoder();

export class CellVm {
  private instance!: WebAssembly.Instance;
  private binding: HostBinding | null = null;
  // Cached view over wasm linear memory. `ooa_alloc`/`memory.grow` can detach
  // the underlying ArrayBuffer, invalidating the view — `mem()` rebuilds it
  // only when the buffer identity changes, so the steady state allocates none.
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

  static async load(wasmPath: string = WASM_PATH): Promise<CellVm> {
    const vm = new CellVm();
    const bytes = readFileSync(wasmPath);
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: {
        ooa_host_call: (ptr: number, len: number): number => vm.hostCall(ptr, len),
      },
    });
    vm.instance = instance;
    return vm;
  }

  private get exports() {
    return this.instance.exports as {
      memory: WebAssembly.Memory;
      ooa_alloc(n: number): number;
      ooa_reset(): void;
      ooa_run_cell(ptr: number, len: number, fuel: bigint): number;
    };
  }

  private readPacked(ptr: number): string {
    const mem = this.mem();
    const len =
      mem[ptr] | (mem[ptr + 1] << 8) | (mem[ptr + 2] << 16) | (mem[ptr + 3] << 24);
    // subarray is a view (no copy); decoded immediately, before any wasm call
    // that could grow/detach the buffer.
    return DEC.decode(mem.subarray(ptr + 4, ptr + 4 + len));
  }

  private writePacked(json: string): number {
    const bytes = ENC.encode(json);
    const ptr = this.exports.ooa_alloc(4 + bytes.length); // may detach the buffer
    const mem = this.mem();
    mem[ptr] = bytes.length & 0xff;
    mem[ptr + 1] = (bytes.length >> 8) & 0xff;
    mem[ptr + 2] = (bytes.length >> 16) & 0xff;
    mem[ptr + 3] = (bytes.length >> 24) & 0xff;
    mem.set(bytes, ptr + 4);
    return ptr;
  }

  private hostCall(ptr: number, len: number): number {
    const mem = this.mem();
    const req = DEC.decode(mem.subarray(ptr, ptr + len));
    let resp: string;
    try {
      const parsed = JSON.parse(req) as { field?: string; method?: string; args?: unknown[] };
      if (!this.binding) throw new Error('no agent bound to the VM');
      if (parsed.field !== undefined) {
        resp = JSON.stringify({ ok: this.binding.getField(parsed.field) ?? null });
      } else if (parsed.method !== undefined) {
        resp = JSON.stringify({
          ok: this.binding.callMethod(parsed.method, parsed.args ?? []) ?? null,
        });
      } else {
        resp = JSON.stringify({ error: 'bad host request' });
      }
    } catch (e) {
      resp = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    return this.writePacked(resp);
  }

  /** Fresh REPL namespace, bound to an agent (a new agentic method call). */
  reset(binding: HostBinding): void {
    this.binding = binding;
    this.exports.ooa_reset();
  }

  /** Run one cell; namespace persists until the next reset(). */
  runCell(source: string, fuel = 0n): CellOutcome {
    const src = ENC.encode(source);
    const inPtr = this.exports.ooa_alloc(src.length); // may detach the buffer
    this.mem().set(src, inPtr);
    const outPtr = this.exports.ooa_run_cell(inPtr, src.length, fuel);
    const parsed = JSON.parse(this.readPacked(outPtr)) as CellOutcome;
    return parsed;
  }
}
