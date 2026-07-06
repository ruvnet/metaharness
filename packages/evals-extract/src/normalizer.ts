// @metaharness/evals-extract — the FIELD / JSON NORMALIZER + json-schema validator.
//
// Extracts + canonicalizes a structured object from an extractor's raw output so field-correctness scoring is
// fair (a valid object buried in prose, or "0.50" vs ".5" in a numeric field, should not be scored wrong).
// Schema-aware. Returns `schemaValid: false` when no object matching the schema shape can be extracted — that
// is the SCHEMA-INVALID signal (a no-op) the routing + scoring layers act on. Deterministic + $0.
import type { SchemaStrictness } from './genome.js';

/** A minimal, deterministic JSON-schema subset — enough for the extraction verifier without a validator dep. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: 'string' | 'number' | 'integer' | 'boolean' }>;
  required: string[];
  /** When false, keys not in `properties` make the object schema-invalid (under strict strictness). */
  additionalProperties?: boolean;
}

export interface NormalizedExtraction {
  /** Canonical extracted object, or null if none could be parsed (format-invalid → no-op). */
  value: Record<string, unknown> | null;
  /** True if raw output parsed into a JSON object at all (regardless of schema conformance). */
  formatValid: boolean;
  /** True if the parsed object validates against the schema under the active strictness. */
  schemaValid: boolean;
}

// Pull the first balanced `{ ... }` span out of a raw output (extractors often wrap JSON in prose/fences).
// Linear scan over braces — no backtracking regex, no ReDoS surface.
function extractJsonSpan(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return raw.slice(start, i + 1); }
  }
  return null;
}

/** Parse + normalize + schema-validate one raw extraction. */
export function normalizeExtraction(
  raw: string,
  schema: JsonSchema,
  strictness: SchemaStrictness,
  normalize: boolean,
): NormalizedExtraction {
  const span = extractJsonSpan((raw ?? '').trim());
  if (!span) return { value: null, formatValid: false, schemaValid: false };

  let parsed: unknown;
  try { parsed = JSON.parse(span); } catch { return { value: null, formatValid: false, schemaValid: false }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, formatValid: false, schemaValid: false };
  }

  const obj = parsed as Record<string, unknown>;
  const value = normalize ? normalizeFields(obj, schema, strictness) : obj;
  const schemaValid = validateSchema(value, schema, strictness);
  return { value, formatValid: true, schemaValid };
}

/** Canonicalize field values per the declared property types (coerce numeric strings, trim, lower booleans). */
export function normalizeFields(
  obj: Record<string, unknown>,
  schema: JsonSchema,
  strictness: SchemaStrictness,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = schema.properties[k];
    if (!p) {
      // keep unknown keys unless a strict-additional policy will reject them at validate time
      if (strictness !== 'strictAdditional') out[k] = v;
      continue;
    }
    out[k] = canonValue(v, p.type, strictness);
  }
  return out;
}

function canonValue(v: unknown, type: JsonSchema['properties'][string]['type'], strictness: SchemaStrictness): unknown {
  // `strict`/`strictAdditional` do NOT coerce — a wrong-typed field must stay wrong (and fail validation).
  const coerce = strictness === 'lenient' || strictness === 'coerce';
  switch (type) {
    case 'string':
      return typeof v === 'string' ? v.trim() : coerce ? String(v) : v;
    case 'number':
    case 'integer': {
      if (typeof v === 'number') return type === 'integer' ? Math.trunc(v) : canonNumber(v);
      if (coerce && typeof v === 'string') {
        const n = Number(v.replace(/[, $]/g, ''));
        if (!Number.isNaN(n)) return type === 'integer' ? Math.trunc(n) : canonNumber(n);
      }
      return v;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (coerce && typeof v === 'string') {
        if (/^true$/i.test(v.trim())) return true;
        if (/^false$/i.test(v.trim())) return false;
      }
      return v;
  }
}

function canonNumber(n: number): number {
  return n === 0 ? 0 : n; // normalize -0 → 0
}

/** Deterministic schema validation over the minimal subset. Strictness modulates additionalProperties. */
export function validateSchema(obj: Record<string, unknown>, schema: JsonSchema, strictness: SchemaStrictness): boolean {
  for (const req of schema.required) if (!(req in obj)) return false;
  const forbidExtra = strictness === 'strictAdditional' || (schema.additionalProperties === false && strictness !== 'lenient');
  for (const [k, v] of Object.entries(obj)) {
    const p = schema.properties[k];
    if (!p) { if (forbidExtra) return false; else continue; }
    if (!typeMatches(v, p.type)) return false;
  }
  return true;
}

export function typeMatches(v: unknown, type: JsonSchema['properties'][string]['type']): boolean {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'number': return typeof v === 'number' && !Number.isNaN(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
  }
}

/** Field-correctness: every property declared in the schema matches the gold object exactly (post-normalize).
 *  This is the deterministic extraction grader for closed-form fields. Open-ended fields (free text) get an
 *  injected LLM judge instead — never fabricate a judge verdict. */
export function fieldMatch(predicted: Record<string, unknown> | null, gold: Record<string, unknown>, schema: JsonSchema): boolean {
  if (predicted === null) return false;
  for (const key of Object.keys(schema.properties)) {
    if (!deepEqual(predicted[key], gold[key])) return false;
  }
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Canonical JSON string of an extraction (stable key order) — used for self-consistency comparison. */
export function canonicalJson(obj: Record<string, unknown> | null): string | null {
  if (obj === null) return null;
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
}
