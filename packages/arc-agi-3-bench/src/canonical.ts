import { createHash, randomUUID } from 'node:crypto';

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalize(value: unknown, path = '$'): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined) continue;
      output[key] = canonicalize(item, `${path}.${key}`);
    }
    return output;
  }
  throw new TypeError(`${path} is not canonical JSON`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function newRequestId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function assertSha256(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}
