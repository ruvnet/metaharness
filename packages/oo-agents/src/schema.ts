// @metaharness/oo-agents — typed I/O contracts. NOOA derives contracts from
// Python type annotations; TypeScript erases types at runtime, so the clone
// carries a small explicit schema DSL instead (validated at the same place
// NOOA validates: when an agentic method's result comes back, with the
// validation error fed to the model for the auto-retry loop).

export type Schema =
  | { type: 'null' }
  | { type: 'boolean' }
  | { type: 'number'; min?: number; max?: number }
  | { type: 'string'; enum?: string[] }
  | { type: 'array'; items?: Schema }
  | { type: 'object'; properties?: Record<string, Schema>; required?: string[] };

/** Validate `v` against `s`; returns null on success or a human-readable path
 *  + reason the model can act on (this string IS the retry prompt payload). */
export function validate(v: unknown, s: Schema, path = '$'): string | null {
  switch (s.type) {
    case 'null':
      return v === null ? null : `${path}: expected null, got ${kind(v)}`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${path}: expected boolean, got ${kind(v)}`;
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v))
        return `${path}: expected number, got ${kind(v)}`;
      if (s.min !== undefined && v < s.min) return `${path}: ${v} < min ${s.min}`;
      if (s.max !== undefined && v > s.max) return `${path}: ${v} > max ${s.max}`;
      return null;
    }
    case 'string': {
      if (typeof v !== 'string') return `${path}: expected string, got ${kind(v)}`;
      if (s.enum && !s.enum.includes(v))
        return `${path}: "${v}" not in enum [${s.enum.join(', ')}]`;
      return null;
    }
    case 'array': {
      if (!Array.isArray(v)) return `${path}: expected array, got ${kind(v)}`;
      if (s.items) {
        for (let i = 0; i < v.length; i++) {
          const err = validate(v[i], s.items, `${path}[${i}]`);
          if (err) return err;
        }
      }
      return null;
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        return `${path}: expected object, got ${kind(v)}`;
      const o = v as Record<string, unknown>;
      for (const req of s.required ?? []) {
        if (!(req in o)) return `${path}: missing required field "${req}"`;
      }
      if (s.properties) {
        for (const [k, sub] of Object.entries(s.properties)) {
          if (k in o) {
            const err = validate(o[k], sub, `${path}.${k}`);
            if (err) return err;
          }
        }
      }
      return null;
    }
  }
}

function kind(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Render a schema as a compact contract string for the model context. */
export function describe(s: Schema): string {
  switch (s.type) {
    case 'null':
    case 'boolean':
    case 'number':
      return s.type;
    case 'string':
      return 'enum' in s && s.enum ? `string(${s.enum.join('|')})` : 'string';
    case 'array':
      return `array<${s.items ? describe(s.items) : 'any'}>`;
    case 'object': {
      const props = Object.entries(s.properties ?? {})
        .map(([k, v]) => `${k}${(s.required ?? []).includes(k) ? '' : '?'}: ${describe(v)}`)
        .join(', ');
      return `{ ${props} }`;
    }
  }
}
