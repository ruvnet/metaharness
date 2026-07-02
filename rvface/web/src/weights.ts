/**
 * Weight fetching. Safetensors files are served from `/models/` —
 * i.e. `web/public/models/` in dev (git-ignored; populated by
 * `python3 tools/fetch_and_convert.py` then copying/symlinking
 * `rvface/models/*.safetensors` in). Their absence is not an error:
 * mock mode needs no weights.
 */

import type { WeightBundle } from './engine';

export const WEIGHT_FILES = {
  detector: 'detector-slim320.safetensors',
  landmark: 'landmark-mfn68.safetensors',
  embedder: 'embedder-mfn.safetensors',
} as const;

export interface WeightProgress {
  /** Which file. */
  name: string;
  /** Bytes received so far. */
  received: number;
  /** Total bytes, or null when the server sent no Content-Length. */
  total: number | null;
}

/** Streaming fetch of one file with progress callbacks. */
async function fetchWithProgress(
  url: string,
  name: string,
  onProgress?: (p: WeightProgress) => void,
): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Dev servers happily return index.html for missing files; reject that.
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) throw new Error(`${url}: not found (got HTML)`);

  const lenHeader = res.headers.get('content-length');
  const total = lenHeader ? parseInt(lenHeader, 10) : null;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.({ name, received: buf.length, total: buf.length });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ name, received, total });
  }

  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Fetch all three weight files from `/models/`. Returns null if any file
 * is missing/unreachable — the caller then runs the mock engine, which
 * needs no weights.
 */
export async function loadWeights(
  onProgress?: (p: WeightProgress) => void,
  baseUrl = 'models/',
): Promise<WeightBundle | null> {
  try {
    const [detector, landmark, embedder] = await Promise.all([
      fetchWithProgress(baseUrl + WEIGHT_FILES.detector, 'detector', onProgress),
      fetchWithProgress(baseUrl + WEIGHT_FILES.landmark, 'landmark', onProgress),
      fetchWithProgress(baseUrl + WEIGHT_FILES.embedder, 'embedder', onProgress),
    ]);
    return { detector, landmark, embedder };
  } catch {
    return null;
  }
}

/** Empty bundle for engines that need no weights (the mock). */
export function emptyWeights(): WeightBundle {
  return {
    detector: new Uint8Array(0),
    landmark: new Uint8Array(0),
    embedder: new Uint8Array(0),
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
