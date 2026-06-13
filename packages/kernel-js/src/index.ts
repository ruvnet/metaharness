// SPDX-License-Identifier: MIT

export interface KernelInfo {
  version: string;
  git_sha: string;
  target: string;
}

export interface McpServerSpec {
  name: string;
  command?: string[];
  url?: string;
  env?: Array<[string, string]>;
}

interface KernelBackend {
  kernelInfo(): KernelInfo;
  mcpValidate(specJson: string): string | null;
  version(): string;
  backend: 'native' | 'wasm';
}

let _cached: KernelBackend | null = null;

async function loadNative(): Promise<KernelBackend | null> {
  try {
    const plat = `${process.platform}-${process.arch}`;
    const map: Record<string, string> = {
      'darwin-arm64': '@ruflo/kernel-darwin-arm64',
      'darwin-x64': '@ruflo/kernel-darwin-x64',
      'linux-x64': '@ruflo/kernel-linux-x64-gnu',
      'linux-arm64': '@ruflo/kernel-linux-arm64-gnu',
      'win32-x64': '@ruflo/kernel-win32-x64-msvc',
    };
    const pkg = map[plat];
    if (!pkg) return null;
    const mod: any = await import(pkg);
    return {
      kernelInfo: () => mod.kernelInfo(),
      mcpValidate: (s: string) => mod.mcpValidate(s) ?? null,
      version: () => mod.version(),
      backend: 'native',
    };
  } catch {
    return null;
  }
}

async function loadWasm(): Promise<KernelBackend> {
  const mod: any = await import('../pkg/ruflo_kernel_wasm.js');
  if (typeof mod.default === 'function') {
    await mod.default();
  }
  return {
    kernelInfo: () => mod.kernelInfo(),
    mcpValidate: (s: string) => mod.mcpValidate(s) ?? null,
    version: () => mod.version(),
    backend: 'wasm',
  };
}

/**
 * Load the kernel. Prefers native, falls back to wasm. Cached.
 */
export async function loadKernel(): Promise<KernelBackend> {
  if (_cached) return _cached;
  const native = await loadNative();
  _cached = native ?? (await loadWasm());
  return _cached;
}
