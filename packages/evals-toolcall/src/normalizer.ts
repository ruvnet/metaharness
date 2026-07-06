// @metaharness/evals-toolcall — the TOOL-CALL NORMALIZER.
//
// Extracts + canonicalizes the function call from a solver's raw output so call-match scoring is fair (a call
// buried in prose, `"5"` vs `5`, or arg-key ordering, should not be scored wrong). ArgFormat-aware. Returns
// null when no call of the expected shape can be extracted — that null is the CALL-INVALID signal (a no-op)
// the routing + scoring layers act on.
import type { ArgFormat } from './genome.js';

/** A parsed, canonical function call. `args` keys are canonicalized; values canonicalized per ArgFormat. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface NormalizedCall {
  /** Canonical call, or null if none could be extracted (call-invalid → no-op). */
  value: ToolCall | null;
  /** True if the raw output actually presented a call in the expected shape. */
  formatValid: boolean;
}

// Match a `name(...)` functional-call form on a single logical span. No backtracking-prone nesting: capture
// the callee ident and the parenthesized body lazily to the first close paren at depth handled below.
const FUNC_RE = /^([A-Za-z_][\w.]*)\s*\(([\s\S]*)\)\s*$/;

/** Pull a call out of raw model output, then canonicalize per argFormat. Accepts three shapes, cheapest
 *  first: a JSON object `{name, arguments}` / `{name, args}`; a fenced ```json block; or `func(a=1, b="x")`. */
export function normalizeCall(raw: string, format: ArgFormat, normalize: boolean): NormalizedCall {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { value: null, formatValid: false };

  const parsed = parseCall(trimmed);
  if (!parsed) return { value: null, formatValid: false };
  if (!parsed.name) return { value: null, formatValid: false };

  if (!normalize) {
    // No canonicalization — keep args verbatim (still a structurally valid call).
    return { value: { name: parsed.name, args: parsed.args }, formatValid: true };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.args)) args[k.trim()] = canonValue(v, format);
  return { value: { name: parsed.name.trim(), args }, formatValid: true };
}

/** Try the three accepted call shapes. Returns the raw (un-canonicalized) name + args, or null. */
function parseCall(text: string): ToolCall | null {
  // 1) fenced ```json … ``` → unwrap and fall through to JSON.
  const fenced = text.match(/```(?:json|tool_call)?([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : text;

  // 2) a JSON object anywhere in the (last) body span.
  const jsonObj = extractJsonObject(body);
  if (jsonObj) {
    const name = typeof jsonObj.name === 'string' ? jsonObj.name
      : typeof (jsonObj as any).function === 'string' ? (jsonObj as any).function : '';
    const rawArgs = (jsonObj as any).arguments ?? (jsonObj as any).args ?? (jsonObj as any).parameters ?? {};
    let argObj: Record<string, unknown> = {};
    if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) argObj = rawArgs as Record<string, unknown>;
    else if (typeof rawArgs === 'string') { try { const p = JSON.parse(rawArgs); if (p && typeof p === 'object') argObj = p; } catch { /* keep empty */ } }
    if (name) return { name, args: argObj };
  }

  // 3) `func(a=1, b="x")` functional form on the last non-empty line.
  const lastLine = body.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const m = lastLine.match(FUNC_RE);
  if (m) {
    const name = m[1];
    const args = parseKeywordArgs(m[2]);
    return { name, args };
  }
  return null;
}

/** Find the first balanced `{...}` span and JSON.parse it. Linear scan (no catastrophic backtracking). */
function extractJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { const p = JSON.parse(s.slice(start, i + 1)); return p && typeof p === 'object' && !Array.isArray(p) ? p : null; }
        catch { return null; }
      }
    }
  }
  return null;
}

/** Parse `a=1, b="x", c=true` into an object. Values are left as strings/parsed literals for canonValue. */
function parseKeywordArgs(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // split on top-level commas only (respect quotes + brackets)
  const parts: string[] = [];
  let depth = 0, inStr: string | null = null, cur = '';
  for (const ch of body) {
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    if (ch === ']' || ch === '}' || ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const vRaw = part.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = litValue(vRaw);
  }
  return out;
}

/** Parse a single literal token: quoted string, number, bool, null, or bare string. */
function litValue(v: string): unknown {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === 'None') return null;
  try { const p = JSON.parse(v); return p; } catch { return v; }
}

/** Canonicalize ONE arg value per the argFormat strictness ladder. */
function canonValue(v: unknown, format: ArgFormat): unknown {
  switch (format) {
    case 'loose':
      // string-compare everything — trims strings, stringifies non-strings.
      return typeof v === 'string' ? v.trim() : v;
    case 'json':
      // structural equality via canonical JSON form (handled at compare time).
      return v;
    case 'typed': {
      // coerce numeric strings → numbers, bool-ish strings → bools.
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        if (t === 'true') return true;
        if (t === 'false') return false;
        return t;
      }
      return v;
    }
    case 'coerced': {
      // aggressive: typed coercion + case/space-insensitive strings.
      if (typeof v === 'string') {
        const t = v.trim();
        if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
        if (t === 'true') return true;
        if (t === 'false') return false;
        return t.toLowerCase().replace(/\s+/g, ' ');
      }
      return v;
    }
  }
}

/** Canonical, order-independent JSON form of a value for structural comparison. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Call-match scorer over normalized calls (the deterministic grader). A call matches iff the function name
 *  is identical AND every gold arg matches (canonicalized per format); extra non-gold args fail under strict
 *  schema. Gold is canonicalized the SAME way so `5` vs `"5"` never spuriously fails under `typed`/`coerced`. */
export function callMatch(predicted: ToolCall | null, gold: ToolCall, format: ArgFormat, strict = true): boolean {
  if (predicted === null) return false;
  if (predicted.name.trim() !== gold.name.trim()) return false;

  const goldArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(gold.args)) goldArgs[k.trim()] = canonValue(v, format);
  const predArgs = predicted.args;

  for (const [k, gv] of Object.entries(goldArgs)) {
    if (!(k in predArgs)) return false;
    if (stableStringify(predArgs[k]) !== stableStringify(gv)) return false;
  }
  if (strict) {
    for (const k of Object.keys(predArgs)) if (!(k in goldArgs)) return false;
  }
  return true;
}
