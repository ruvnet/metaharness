/**
 * MOCK engine — stands in for the wasm module until `rvface-wasm` is built.
 *
 * It is deliberately deterministic: the "detection" places a plausible box
 * via a luminance-centroid heuristic, the 68 landmarks are synthesized in a
 * face-like arrangement inside that box, and the embedding is derived from
 * image statistics — so the same image always produces the same embedding
 * (similarity 100) while different images diverge.
 */

import type {
  BackendKind,
  EngineFactory,
  FaceResult,
  RvFaceEngine,
  WeightBundle,
} from './engine';

const EMBEDDING_DIM = 512;

/** splitmix64-ish 32-bit mixer for deterministic pseudo-randomness. */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

interface ImageStats {
  /** Luminance-weighted centroid (pixels). */
  cx: number;
  cy: number;
  meanLuma: number;
  /** Left/right and top/bottom luminance asymmetry, roughly -1..1. */
  asymX: number;
  asymY: number;
  /** 8x8 grid of per-cell mean R, G, B and luma (256 floats). */
  grid: Float32Array;
}

/** One sampled pass over the pixels; O(samples), reused for box + embedding. */
function computeStats(rgba: Uint8Array, width: number, height: number): ImageStats {
  const GRID = 8;
  const grid = new Float32Array(GRID * GRID * 4);
  const counts = new Uint32Array(GRID * GRID);

  // Sample on a stride so huge images stay cheap (~64k samples max).
  const targetSamples = 65536;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / targetSamples)));

  let sumL = 0;
  let sumLX = 0;
  let sumLY = 0;
  let sumLeft = 0;
  let sumRight = 0;
  let sumTop = 0;
  let sumBottom = 0;
  let n = 0;

  for (let y = 0; y < height; y += stride) {
    const gy = Math.min(GRID - 1, Math.floor((y * GRID) / height));
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;

      sumL += l;
      sumLX += l * x;
      sumLY += l * y;
      if (x < width / 2) sumLeft += l;
      else sumRight += l;
      if (y < height / 2) sumTop += l;
      else sumBottom += l;
      n++;

      const gx = Math.min(GRID - 1, Math.floor((x * GRID) / width));
      const cell = (gy * GRID + gx) * 4;
      grid[cell] = grid[cell]! + r;
      grid[cell + 1] = grid[cell + 1]! + g;
      grid[cell + 2] = grid[cell + 2]! + b;
      grid[cell + 3] = grid[cell + 3]! + l;
      counts[gy * GRID + gx] = counts[gy * GRID + gx]! + 1;
    }
  }

  for (let c = 0; c < GRID * GRID; c++) {
    const k = counts[c]! || 1;
    for (let ch = 0; ch < 4; ch++) grid[c * 4 + ch] = grid[c * 4 + ch]! / k;
  }

  const total = sumL || 1;
  const half = total / 2 || 1;
  return {
    cx: sumLX / total,
    cy: sumLY / total,
    meanLuma: sumL / (n || 1),
    asymX: (sumRight - sumLeft) / half,
    asymY: (sumBottom - sumTop) / half,
    grid,
  };
}

/**
 * 68 landmark positions in a normalized face box (x, y in 0..1),
 * arranged like the iBUG-68 layout: jaw(17), brows(5+5), nose(4+5),
 * eyes(6+6), mouth(12+8).
 */
function synthesizeLandmarks(
  bx: number,
  by: number,
  bw: number,
  bh: number,
  yawDeg: number,
): Float32Array {
  const pts: number[] = [];
  const push = (nx: number, ny: number) => {
    // A little horizontal shear with yaw so the gizmo and dots agree.
    const shear = (yawDeg / 90) * 0.08 * (ny - 0.5);
    pts.push(bx + (nx + shear) * bw, by + ny * bh);
  };

  // Jaw: 17 points on a U-shaped arc.
  for (let i = 0; i < 17; i++) {
    const t = i / 16; // 0..1 left ear -> right ear
    const a = Math.PI * (1 - t); // pi..0
    push(0.5 + 0.45 * Math.cos(a), 0.52 + 0.46 * Math.sin(a));
  }
  // Eyebrows: 5 left, 5 right.
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    push(0.16 + t * 0.24, 0.3 - Math.sin(t * Math.PI) * 0.05);
  }
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    push(0.6 + t * 0.24, 0.25 + (0.3 - 0.25) * (1 - Math.sin(t * Math.PI)) - 0.0);
  }
  // Nose bridge: 4 points down the middle.
  for (let i = 0; i < 4; i++) push(0.5, 0.38 + i * 0.055);
  // Nose base: 5 points.
  for (let i = 0; i < 5; i++) push(0.41 + (i / 4) * 0.18, 0.585 + Math.sin((i / 4) * Math.PI) * 0.02);
  // Left eye: 6 points on an ellipse.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI;
    push(0.31 + 0.07 * Math.cos(a), 0.4 + 0.03 * Math.sin(a));
  }
  // Right eye: 6 points.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI;
    push(0.69 + 0.07 * Math.cos(a), 0.4 + 0.03 * Math.sin(a));
  }
  // Outer mouth: 12 points on an ellipse.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 2 * Math.PI;
    push(0.5 + 0.16 * Math.cos(a), 0.74 + 0.06 * Math.sin(a));
  }
  // Inner mouth: 8 points.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * 2 * Math.PI;
    push(0.5 + 0.1 * Math.cos(a), 0.74 + 0.025 * Math.sin(a));
  }

  return new Float32Array(pts); // 68 * 2 = 136
}

/** Deterministic pseudo-embedding expanded from the 8x8 color grid. */
function synthesizeEmbedding(stats: ImageStats): Float32Array {
  // Z-score the grid per channel across cells first: the embedding then
  // encodes the image's *relative* spatial structure rather than its
  // common-mode brightness, so different photos actually diverge while
  // the same photo stays bit-identical.
  const raw = stats.grid;
  const g = new Float32Array(raw.length);
  const cells = raw.length / 4;
  for (let ch = 0; ch < 4; ch++) {
    let mean = 0;
    for (let c = 0; c < cells; c++) mean += raw[c * 4 + ch]!;
    mean /= cells;
    let varSum = 0;
    for (let c = 0; c < cells; c++) {
      const d = raw[c * 4 + ch]! - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / cells) || 1e-6;
    for (let c = 0; c < cells; c++) g[c * 4 + ch] = (raw[c * 4 + ch]! - mean) / std;
  }

  const e = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    // Mix a handful of grid cells per output dim with signed hash weights.
    let acc = 0;
    for (let k = 0; k < 4; k++) {
      const h = mix32(i * 4 + k + 0x9e37);
      const src = h % g.length;
      const sign = (h & 0x10000) !== 0 ? 1 : -1;
      const w = 0.5 + ((h >>> 20) & 0xff) / 255;
      acc += sign * w * g[src]!;
    }
    e[i] = acc;
  }
  // L2 normalize, like the real embedder output.
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += e[i]! * e[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) e[i] = e[i]! / norm;
  return e;
}

class MockEngine implements RvFaceEngine {
  readonly kind = 'mock' as const;

  constructor(readonly backend: BackendKind) {}

  async analyze(
    rgba: Uint8Array,
    width: number,
    height: number,
    maxFaces: number,
  ): Promise<FaceResult[]> {
    if (maxFaces < 1 || width < 8 || height < 8) return [];
    if (rgba.length < width * height * 4) {
      throw new Error(`rgba buffer too small: ${rgba.length} < ${width * height * 4}`);
    }

    const stats = computeStats(rgba, width, height);

    // "Detection": box around the luminance centroid, pulled toward center,
    // sized ~55% of the short side — a plausible portrait framing.
    const side = Math.min(width, height) * 0.55;
    const cx = 0.5 * (stats.cx + width / 2);
    const cy = 0.5 * (stats.cy + height / 2);
    const x1 = Math.max(0, Math.min(width - side, cx - side / 2));
    const y1 = Math.max(0, Math.min(height - side, cy - side / 2));
    const y2 = Math.min(height, y1 + side * 1.15);
    const box: [number, number, number, number] = [x1, y1, x1 + side, y2];

    // Deterministic pose from luminance asymmetry.
    const yaw = Math.max(-35, Math.min(35, stats.asymX * 40));
    const pitch = Math.max(-25, Math.min(25, -stats.asymY * 25));
    const roll = Math.max(-15, Math.min(15, (stats.meanLuma / 255 - 0.5) * 20));

    const score = 0.86 + (mix32(Math.round(stats.meanLuma * 100)) % 1000) / 10000;

    const face: FaceResult = {
      box,
      score,
      landmarks: synthesizeLandmarks(box[0], box[1], box[2] - box[0], box[3] - box[1], yaw),
      pose: { yaw, pitch, roll },
      embedding: synthesizeEmbedding(stats),
    };
    return [face];
  }

  similarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) throw new Error('embedding length mismatch');
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
    return Math.max(0, Math.min(100, (dot + 1) * 50));
  }

  dispose(): void {
    /* nothing to free */
  }
}

export const mockFactory: EngineFactory = {
  kind: 'mock',
  async create(
    backend: BackendKind,
    _weights: WeightBundle, // the mock needs no weights
    onProgress?: (msg: string) => void,
  ): Promise<RvFaceEngine> {
    onProgress?.(`mock engine ready (backend "${backend}" simulated)`);
    return new MockEngine(backend);
  },
};
