// @metaharness/evals-toolcall — the SCHEMA-AWARE VERIFIER STACK.
//
// The verifier returns an AGREEMENT signal used by routing (escalate on disagreement) + calibration. It is
// deliberately NOT a generic "critic says yes" model — ADR-226 measured that read-only strong advice added
// ZERO marginal resolves at 5.4x cost. The useful lever is EXECUTOR policy + real checks over the produced
// call and its declared tool schema: required-arg presence, argument type consistency, enum-domain membership,
// multi-sample agreement — mostly deterministic, cheap, and schema-appropriate. Each check returns [0,1]
// agreement; the mode selects which check(s) run.
import type { Category, VerificationMode } from './genome.js';
import type { ToolCall } from './normalizer.js';

/** Minimal JSON-schema-ish description of one tool's parameters (the subset BFCL cares about). */
export interface ToolSchema {
  name: string;
  /** paramName → declared type ('string'|'number'|'integer'|'boolean'|'array'|'object'). */
  properties?: Record<string, { type?: string; enum?: unknown[] }>;
  required?: string[];
}

export interface VerifyInput {
  category: Category;
  query: string;
  /** The normalized candidate call. */
  call: ToolCall | null;
  /** The declared schema for the called tool (when available). */
  schema?: ToolSchema;
  /** Additional sampled calls (for multiSample / self-consistency agreement). */
  samples?: (ToolCall | null)[];
}

export interface VerifyResult {
  /** [0,1] — how much the verifier stack agrees the call is sound. */
  agreement: number;
  /** True when the stack actively disagrees (agreement below a floor) → a routing escalation trigger. */
  disagrees: boolean;
  checksRun: string[];
}

/** Injectable executable verifier for the live run (e.g. a dry-run of the tool in a sandbox). The default is
 *  a structural approximation so the adapter runs at $0 for replay; a real check is strictly better. */
export type ExecChecker = (call: ToolCall, schema?: ToolSchema) => number | undefined;

export function makeVerifier(opts: { exec?: ExecChecker } = {}) {
  return function verify(mode: VerificationMode, input: VerifyInput): VerifyResult {
    if (mode === 'none' || input.call === null) {
      return { agreement: input.call === null ? 0 : 0.5, disagrees: input.call === null, checksRun: [] };
    }
    const checks: string[] = [];
    const scores: number[] = [];

    if (mode === 'multiSample') {
      scores.push(selfConsistency(input.call, input.samples ?? []));
      checks.push('multiSample');
    }
    if (mode === 'schemaCheck') {
      const s = opts.exec?.(input.call, input.schema);
      scores.push(s ?? requiredArgsPresent(input.call, input.schema));
      checks.push(opts.exec ? 'schema~exec' : 'schema~structural');
    }
    if (mode === 'typeCheck') {
      scores.push(typeConsistency(input.call, input.schema));
      checks.push('typeCheck');
    }
    if (mode === 'enumCheck') {
      scores.push(enumMembership(input.call, input.schema));
      checks.push('enumCheck');
    }
    const agreement = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.5;
    return { agreement, disagrees: agreement < 0.34, checksRun: checks };
  };
}

/** Fraction of samples whose (name+args) match the chosen call — self-consistency agreement. */
function selfConsistency(call: ToolCall, samples: (ToolCall | null)[]): number {
  const key = (c: ToolCall) => `${c.name}(${JSON.stringify(sortedArgs(c.args))})`;
  const target = key(call);
  const all = [call, ...samples.filter((s): s is ToolCall => s !== null)];
  if (all.length <= 1) return 0.5;
  const agree = all.filter((s) => key(s) === target).length;
  return agree / all.length;
}

/** All required params present (and, under a schema, no obviously-unknown params). */
function requiredArgsPresent(call: ToolCall, schema?: ToolSchema): number {
  if (!schema) return call.name ? 0.6 : 0.2;
  const req = schema.required ?? [];
  const present = req.filter((r) => r in call.args).length;
  if (req.length === 0) return 0.7;
  const frac = present / req.length;
  return 0.35 + 0.6 * frac; // [0.35, 0.95]
}

/** Declared-type vs supplied-type consistency for the args present. */
function typeConsistency(call: ToolCall, schema?: ToolSchema): number {
  const props = schema?.properties;
  if (!props) return 0.5;
  const entries = Object.entries(call.args);
  if (entries.length === 0) return 0.5;
  let ok = 0, checked = 0;
  for (const [k, v] of entries) {
    const t = props[k]?.type;
    if (!t) continue;
    checked++;
    if (typeMatches(t, v)) ok++;
  }
  if (checked === 0) return 0.5;
  return 0.3 + 0.65 * (ok / checked);
}

/** Enum-typed args must be inside their declared domain. */
function enumMembership(call: ToolCall, schema?: ToolSchema): number {
  const props = schema?.properties;
  if (!props) return 0.5;
  let ok = 0, checked = 0;
  for (const [k, v] of Object.entries(call.args)) {
    const en = props[k]?.enum;
    if (!en) continue;
    checked++;
    if (en.some((e) => JSON.stringify(e) === JSON.stringify(v))) ok++;
  }
  if (checked === 0) return 0.5;
  return ok / checked;
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return true;
  }
}

function sortedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) out[k] = args[k];
  return out;
}
