import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VectorMetric } from './types.js';

const ID_MAX = 256;
const PRECISION = 1e12;

export function round(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('numeric aggregation produced a non-finite value');
  const result = Math.round(value * PRECISION) / PRECISION;
  if (!Number.isFinite(result)) throw new RangeError('numeric aggregation exceeded the finite range');
  return Object.is(result, -0) ? 0 : result;
}

export function floorWeight(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError('weight must be finite');
  const result = Math.floor(value * PRECISION) / PRECISION;
  return Object.is(result, -0) ? 0 : result;
}

export function assertIdentifier(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty identifier of at most ${ID_MAX} printable characters`);
  }
}

export function assertTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe-integer Unix timestamp in milliseconds`);
  }
}

export function assertVector(vector: readonly number[], dimension: number, name = 'embedding'): void {
  if (!Array.isArray(vector) || vector.length !== dimension) {
    throw new TypeError(`${name} must contain exactly ${dimension} values`);
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new TypeError(`${name} must contain only finite values`);
  }
}

export function vectorNorm(vector: readonly number[]): number {
  let scale = 0;
  let sumSquares = 1;
  for (const value of vector) {
    const magnitude = Math.abs(value);
    if (magnitude === 0) continue;
    if (scale < magnitude) {
      const ratio = scale / magnitude;
      sumSquares = 1 + sumSquares * ratio * ratio;
      scale = magnitude;
    } else {
      const ratio = magnitude / scale;
      sumSquares += ratio * ratio;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sumSquares);
}

export function normalized(vector: readonly number[], metric: VectorMetric): number[] {
  if (metric === 'euclidean') return vector.map(round);
  const scale = vector.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scale <= Number.EPSILON) throw new RangeError('embedding must have non-zero magnitude');
  const scaledNorm = Math.sqrt(vector.reduce((sum, value) => sum + (value / scale) ** 2, 0));
  return vector.map((value) => round((value / scale) / scaledNorm));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const scaleA = a.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  const scaleB = b.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scaleA <= Number.EPSILON || scaleB <= Number.EPSILON) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] / scaleA;
    const bv = b[i] / scaleB;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb)));
}

export function similarity(a: readonly number[], b: readonly number[], metric: VectorMetric): number {
  if (metric === 'cosine') return cosine(a, b);
  if (metric === 'dot') {
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
    return Math.max(-1, Math.min(1, dot));
  }
  const deltas = a.map((value, index) => value - b[index]);
  const distance = vectorNorm(deltas);
  return 2 / (1 + distance) - 1;
}

export function bucketStart(timestamp: number, bucketSizeMs: number): number {
  return Math.floor(timestamp / bucketSizeMs) * bucketSizeMs;
}

export function activeSince(now: number, windowMs: number): number {
  return Math.max(0, now - windowMs);
}

export function decay(ageMs: number, halfLifeMs: number): number {
  return 2 ** (-Math.max(0, ageMs) / halfLifeMs);
}

export function assertIdentityHashKey(key: string | Uint8Array): Uint8Array {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : new Uint8Array(key);
  if (bytes.byteLength < 32) throw new RangeError('identityHashKey must contain at least 32 bytes');
  return bytes;
}

export function digestOpaque(domain: string, value: string, key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(`metaharness.field-memory\0${domain}\0${value}`, 'utf8')
    .digest('hex');
}

export function hmacSha256(value: string, key: Uint8Array): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function secureHexEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(a) || !/^[a-f0-9]{64}$/u.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not allow non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new TypeError(`canonical JSON does not allow ${typeof value}`);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareText);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
