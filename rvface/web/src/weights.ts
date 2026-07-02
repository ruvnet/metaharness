/**
 * Weight + manifest fetching. Files are served from `/models/` — i.e.
 * `web/public/models/` (git-ignored), populated by `web/build-wasm.sh`
 * (which copies the converted safetensors + manifests from `models/`,
 * themselves produced by `python3 tools/fetch_and_convert.py`).
 *
 * Missing files are a hard error: the UI runs only the real engine, so
 * `loadWeights` throws with actionable instructions instead of degrading.
 */

import type { WeightBundle } from './engine';

export const WEIGHT_FILES = {
  detector: 'detector-slim320.safetensors',
  landmark: 'landmark-mfn68.safetensors',
  embedder: 'embedder-mfn.safetensors',
} as const;

export const MANIFEST_FILES = {
  landmark: 'landmark-mfn68.manifest.json',
  embedder: 'embedder-mfn.manifest.json',
} as const;

export interface WeightProgress {
  /** Which file. */
  name: string;
  /** Bytes received so far. */
  received: number;
  /** Total bytes, or null when the server sent no Content-Length. */
  total: number | null;
}

/** Fetch + validate one file; dev servers return index.html for misses. */
async function fetchRaw(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) throw new Error(`${url}: not found (got HTML)`);
  return res;
}

/** Streaming fetch of one binary file with progress callbacks. */
async function fetchWithProgress(
  url: string,
  name: string,
  onProgress?: (p: WeightProgress) => void,
): Promise<Uint8Array> {
  const res = await fetchRaw(url);

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
 * Fetch the three weight files and the two arch manifests from `/models/`.
 * Throws (with setup instructions) when any file is missing/unreachable.
 */
export async function loadWeights(
  onProgress?: (p: WeightProgress) => void,
  baseUrl = 'models/',
): Promise<WeightBundle> {
  try {
    const [detector, landmark, embedder, landmarkManifest, embedderManifest] = await Promise.all([
      fetchWithProgress(baseUrl + WEIGHT_FILES.detector, 'detector', onProgress),
      fetchWithProgress(baseUrl + WEIGHT_FILES.landmark, 'landmark', onProgress),
      fetchWithProgress(baseUrl + WEIGHT_FILES.embedder, 'embedder', onProgress),
      fetchRaw(baseUrl + MANIFEST_FILES.landmark).then((r) => r.text()),
      fetchRaw(baseUrl + MANIFEST_FILES.embedder).then((r) => r.text()),
    ]);
    return { detector, landmark, embedder, landmarkManifest, embedderManifest };
  } catch (err) {
    throw new Error(
      `model files missing from /models/ (${err instanceof Error ? err.message : err}). ` +
        'Fix: python3 tools/fetch_and_convert.py, then ./web/build-wasm.sh ' +
        '(it copies models/*.safetensors + manifests into web/public/models/).',
    );
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
