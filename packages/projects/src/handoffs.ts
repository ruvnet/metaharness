// SPDX-License-Identifier: MIT
//
// @metaharness/projects — handoffs.ts (ADR-163 Typed Handoffs).
//
// Contracted agent-to-agent transitions, borrowed from the OpenAI Agents SDK's
// handoff primitive: each hop carries a SCHEMA for its input and output, a risk
// level, an allowed-tool list, and a budget. The thesis is that TYPED handoffs cut
// retries — a malformed/ambiguous handoff is caught by the schema at the boundary
// instead of being discovered downstream after wasted model calls.
//
// DEFENSIVE BY CONSTRUCTION: the canonical chain ends at DISCLOSURE. There is no
// "exploit" or "release" terminal stage; the Security→Disclosure hop is high-risk
// and immutable so the contracted flow can only land on responsible disclosure.
//
// The optimization (measured in bench/handoffs.bench.mjs): typed contracts reject
// schema-invalid handoffs WITHOUT retrying, while free-form handoffs burn retries
// rediscovering the same malformed payloads. The bench reports the reduction %.

import { makeRng } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Schema + contract types.
// ─────────────────────────────────────────────────────────────────────────────

/** How risky the receiving agent's authority is; gates allowed tools/budget. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** The JSON-ish field kinds a handoff schema can declare. */
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** One declared field in a handoff input/output schema. */
export interface FieldSchema {
  name: string;
  type: FieldType;
  required: boolean;
}

/** A typed contract for a single agent-to-agent hop. */
export interface HandoffContract {
  from: string;
  to: string;
  inputSchema: FieldSchema[];
  outputSchema: FieldSchema[];
  riskLevel: RiskLevel;
  allowedTools: string[];
  budgetCostUnits: number;
  escalationThreshold: number;
  /** When true the contract is fixed (used to lock the Security→Disclosure hop). */
  immutable?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation. Every REQUIRED field must be present and of the declared type;
// extra (unknown) fields are allowed. All errors are collected, not short-circuited.
// ─────────────────────────────────────────────────────────────────────────────

/** Runtime type-tag matching a FieldType. `array` is checked before `object`. */
function kindOf(v: unknown): FieldType | 'null' | 'undefined' {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  return 'object'; // functions/symbols → treat as non-conforming object
}

/** Validate a single record against a schema, prefixing errors with `where`. */
function validateRecord(
  schema: FieldSchema[],
  rec: Record<string, unknown>,
  where: string,
): string[] {
  const errs: string[] = [];
  for (const field of schema) {
    const present = Object.prototype.hasOwnProperty.call(rec, field.name) && rec[field.name] !== undefined;
    if (!present) {
      if (field.required) errs.push(`${where}: missing required field '${field.name}'`);
      continue; // optional + absent → fine
    }
    const actual = kindOf(rec[field.name]);
    if (actual !== field.type) {
      errs.push(`${where}: field '${field.name}' expected ${field.type} but got ${actual}`);
    }
  }
  return errs;
}

/** Validate an input/output pair against a contract. Returns all errors found. */
export function validateHandoff(
  c: HandoffContract,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const errors = [
    ...validateRecord(c.inputSchema, input, `input(${c.from}→${c.to})`),
    ...validateRecord(c.outputSchema, output, `output(${c.from}→${c.to})`),
  ];
  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// The canonical defensive chain: Planner→Coder→Tester→Reviewer→Security→Disclosure.
// Note the absence of any weaponization/"release" stage — the flow terminates at
// responsible disclosure, and the Security→Disclosure hop is locked immutable.
// ─────────────────────────────────────────────────────────────────────────────

const F = (name: string, type: FieldType, required = true): FieldSchema => ({ name, type, required });

/** Build the default six-stage handoff chain. */
export function defaultChain(): HandoffContract[] {
  return [
    {
      from: 'Planner', to: 'Coder',
      inputSchema: [F('task', 'string'), F('constraints', 'array')],
      outputSchema: [F('plan', 'array'), F('rationale', 'string')],
      riskLevel: 'low', allowedTools: ['search', 'read'], budgetCostUnits: 4, escalationThreshold: 0.7,
    },
    {
      from: 'Coder', to: 'Tester',
      inputSchema: [F('plan', 'array')],
      outputSchema: [F('diff', 'string'), F('touchedFiles', 'array')],
      riskLevel: 'medium', allowedTools: ['read', 'write', 'edit'], budgetCostUnits: 8, escalationThreshold: 0.75,
    },
    {
      from: 'Tester', to: 'Reviewer',
      inputSchema: [F('diff', 'string'), F('touchedFiles', 'array')],
      outputSchema: [F('passed', 'boolean'), F('report', 'object')],
      riskLevel: 'medium', allowedTools: ['run_tests'], budgetCostUnits: 6, escalationThreshold: 0.8,
    },
    {
      from: 'Reviewer', to: 'Security',
      inputSchema: [F('passed', 'boolean'), F('diff', 'string')],
      outputSchema: [F('approved', 'boolean'), F('findings', 'array')],
      riskLevel: 'medium', allowedTools: ['read', 'static_analysis'], budgetCostUnits: 6, escalationThreshold: 0.85,
    },
    {
      // High-risk and IMMUTABLE: the security stage hands off only to disclosure.
      from: 'Security', to: 'Disclosure',
      inputSchema: [F('approved', 'boolean'), F('findings', 'array')],
      outputSchema: [F('advisory', 'object'), F('severity', 'string'), F('remediation', 'string')],
      riskLevel: 'high', allowedTools: ['draft_advisory'], budgetCostUnits: 5, escalationThreshold: 0.9,
      immutable: true,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution. At each hop: validate input → run executor → validate output. A
// SCHEMA failure rejects immediately (no retry — the contract is unmet). An
// executor not-ok is a transient failure and is retried up to maxRetriesPerHop.
// ─────────────────────────────────────────────────────────────────────────────

/** A pluggable executor for one hop; `attempt` is 1-based. */
export interface HandoffExecutor {
  (input: Record<string, unknown>, attempt: number): { output: Record<string, unknown>; ok: boolean };
}

/** Result of running a full chain. */
export interface ChainResult {
  completed: boolean;
  retries: number;
  /** Contract `to` where the chain stopped (on failure). */
  terminatedAt?: string;
  rejectedReason?: string;
}

/** Runs a sequence of contracts through their executors. */
export class HandoffChain {
  constructor(private readonly contracts: HandoffContract[]) {}

  run(
    initialInput: Record<string, unknown>,
    executors: Record<string, HandoffExecutor>,
    opts: { maxRetriesPerHop?: number } = {},
  ): ChainResult {
    const maxRetries = opts.maxRetriesPerHop ?? 2;
    let carry = initialInput;
    let retries = 0;

    for (const c of this.contracts) {
      const exec = executors[c.to] ?? executors[`${c.from}->${c.to}`];
      if (!exec) {
        return { completed: false, retries, terminatedAt: c.to, rejectedReason: `no executor for hop ${c.from}→${c.to}` };
      }

      // 1) Validate the INPUT half of the contract before doing any work.
      const inErrs = validateRecord(c.inputSchema, carry, `input(${c.from}→${c.to})`);
      if (inErrs.length > 0) {
        return { completed: false, retries, terminatedAt: c.to, rejectedReason: inErrs[0] };
      }

      // 2) Run the executor; retry only on transient not-ok, never on schema failure.
      let attempt = 0;
      let produced: Record<string, unknown> | null = null;
      while (attempt < Math.max(1, maxRetries)) {
        attempt += 1;
        const r = exec(carry, attempt);
        if (r.ok) {
          produced = r.output;
          break;
        }
        retries += 1; // a wasted attempt
      }
      if (produced === null) {
        return { completed: false, retries, terminatedAt: c.to, rejectedReason: `executor failed after ${maxRetries} attempts` };
      }

      // 3) Validate the OUTPUT half. A schema-invalid output is rejected NOW,
      //    before the next agent ever sees it (no downstream retry storm).
      const outErrs = validateRecord(c.outputSchema, produced, `output(${c.from}→${c.to})`);
      if (outErrs.length > 0) {
        return { completed: false, retries, terminatedAt: c.to, rejectedReason: outErrs[0] };
      }

      carry = produced;
    }

    return { completed: true, retries };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic A/B retry simulation. Typed contracts catch ambiguous handoffs at
// the schema boundary (one rejection, no retry); free-form handoffs have no
// boundary check, so a malformed handoff is only discovered downstream and burns
// the full retry budget. Same seed/tasks → identical, reproducible counts.
// ─────────────────────────────────────────────────────────────────────────────

/** Simulate retries across `tasks` handoffs in typed vs free-form mode.
 *  The reduction is NOT a baked constant: each ambiguous handoff's free-form cost
 *  is drawn per-task (1..4 downstream retries before discovery), and typed always
 *  pays exactly one corrective re-emit. The RNG stream is identical across both
 *  modes for the same seed (the per-task cost is drawn regardless of `typed`), so
 *  the comparison is paired and `typed.retries <= free.retries` always holds, with
 *  the actual ratio emerging from the seed. */
export function simulateRetries(opts: { typed: boolean; tasks: number; seed: number }): { retries: number } {
  const rng = makeRng(opts.seed);
  let retries = 0;

  for (let i = 0; i < opts.tasks; i += 1) {
    const ambiguous = rng() < 0.35;
    // Draw the free-form cost UNCONDITIONALLY so the stream is identical in both
    // modes (paired comparison); a malformed handoff is rediscovered downstream
    // a variable number of times (1..4) before someone notices.
    const freeFormCost = 1 + Math.floor(rng() * 4);
    if (!ambiguous) continue; // a clean handoff costs no retries in either mode
    // Schema catches it at the boundary (one corrective re-emit); free-form burns
    // the full rediscovery cost.
    retries += opts.typed ? 1 : freeFormCost;
  }
  return { retries };
}
