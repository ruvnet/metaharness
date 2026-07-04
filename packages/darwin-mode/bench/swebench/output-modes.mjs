// SPDX-License-Identifier: MIT
//
// ADR-232 — Cost-aware output-mode decoder policy for the Fable escalation stack.
//
// Thesis: output tokens cannot be hidden in image/prompt-cache tokens — the model MUST generate
// them, and Fable's output price ($50/M) is 5× its input price. So the strongest cost lever on the
// hard-tail Fable rung (ADR-205 handoff, FABLE-REPORT.md) is to make Fable write LESS / LATER /
// NOT AT ALL, and to optimize cost-per-ACCEPTED-task, never input alone.
//
// This module is PURE, dependency-free, and unit-tested (output-modes.test.mjs). It carries no I/O
// beyond the opt-in local artifact logger (§7 observability), which writes OUTSIDE the model path.
// It is wired into solve-agentic.mjs behind the additive `--output-modes` flag; a default run never
// touches it, so existing solve behaviour is byte-identical.

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 0. Token estimation. chars/4 is the standard cheap proxy; good enough for budget enforcement and
//    modeled-replay (the gateway `max_tokens` is the real enforced cap — this only decides WHICH cap).
// ────────────────────────────────────────────────────────────────────────────────────────────────
/** @param {string} s @returns {number} */
export function estTokens(s) { return s ? Math.ceil(String(s).length / 4) : 0; }

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 1. Output modes + budgets (the general decoder policy — §10).
//    `OutputMode` is the GENERAL enum. `FableOutputMode` (below) is the narrower, loop-scoped enum
//    that STRUCTURALLY EXCLUDES full_prose — Fable inside an agent turn must never be asked for prose.
// ────────────────────────────────────────────────────────────────────────────────────────────────
/** @typedef {"verdict_only"|"patch_only"|"capsule"|"json_delta"|"full_prose"} OutputMode */
/** @typedef {"verdict_only"|"minimal_patch"|"need_context"|"blocked"} FableOutputMode */
/** @typedef {"renderer_prose"|"cheap_model_prose"|"template_fill"} TerminalOutputMode */

// GOVERNANCE SWITCH (refinement §6). NOT prompt-configurable. Only flippable by a signed runtime
// policy or an ADR-version bump — NEVER by a prompt/task field. This is the security property that
// stops an agent smuggling prose back into the loop with "explain your reasoning": assertFableLoopMode
// reads this constant, and no task field can set it. Keeping it `false` is the whole thesis.
export const FABLE_FULL_PROSE_ALLOWED = false;

/** The only legal Fable loop-turn modes. */
export const FABLE_LOOP_MODES = Object.freeze(['verdict_only', 'minimal_patch', 'need_context', 'blocked']);

/**
 * assertFableLoopMode(mode) — the hard runtime guard (refinement §2/§6, verbatim contract). Throws on
 * any non-Fable-loop mode. "Fable full_prose is forbidden inside the loop" — a formatting/verbosity
 * decision, not an intelligence one, so it is enforced structurally, not by prompt.
 * @param {string} mode
 */
export function assertFableLoopMode(mode) {
  if (FABLE_FULL_PROSE_ALLOWED) return mode; // governance override — signed-policy only, default false
  if (!FABLE_LOOP_MODES.includes(mode)) {
    throw new Error(`Fable full_prose is forbidden inside the loop: ${mode}`);
  }
  return mode;
}

/** @type {Record<OutputMode, number>} */
export const outputBudgets = Object.freeze({
  verdict_only: 200,
  patch_only: 1200,
  capsule: 800,
  json_delta: 600,
  full_prose: 2500,
});

/** @type {Record<FableOutputMode, number>} */
export const fableOutputBudgets = Object.freeze({
  verdict_only: 200,   // {verdict, blocking_issues, minimal_patch?}
  minimal_patch: 1200, // a unified-diff / search-replace edit, nothing else
  need_context: 120,   // a single tool request to fetch more context — never prose
  blocked: 80,         // a terse give-up token so the cascade can route elsewhere
});

/** full_prose is a TERMINAL RENDERER mode only — never a Fable loop-turn mode. */
export const FABLE_FORBIDDEN_MODES = Object.freeze(['full_prose']);

/**
 * chooseOutputMode(task) — GENERAL decoder policy (§10). Any stage of the cascade can call it.
 * @param {{needsCodeChange?:boolean,isReview?:boolean,isAgentHandoff?:boolean,isReport?:boolean}} task
 * @returns {OutputMode}
 */
export function chooseOutputMode(task = {}) {
  if (task.needsCodeChange) return 'patch_only';
  if (task.isReview) return 'verdict_only';
  if (task.isAgentHandoff) return 'capsule';
  if (task.isReport) return 'json_delta';
  return 'full_prose';
}

/**
 * chooseFableMode(task) — the LOOP-SCOPED decoder policy. Guarantees a FableOutputMode and thus can
 * never return full_prose. This is the function the cascade wires into the Fable rung so it is
 * structurally impossible to request prose from Fable within a turn (§1 of the refinements).
 * @param {{isReview?:boolean,needsCodeChange?:boolean,needsContext?:boolean,giveUp?:boolean}} task
 * @returns {FableOutputMode}
 */
export function chooseFableMode(task = {}) {
  if (task.giveUp) return 'blocked';
  if (task.needsContext) return 'need_context';
  if (task.isReview) return 'verdict_only';   // review turns: emit a verdict, not a rewrite
  // default for Fable in a coding loop is a minimal patch — never narration, never full_prose.
  return 'minimal_patch';
}

/** Back-compat alias for assertFableLoopMode (both names are part of the normative interface). */
export const assertFableMode = assertFableLoopMode;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// PRIORITY HIERARCHY (refinement §5) — the objective function, in strict order. The optimizer targets
// #4 (cost per accepted task) SUBJECT TO #1–#3 as HARD GATES. "≥60% fewer Fable output tokens is NOT
// the objective — it is a constraint that only matters AFTER correctness and the defect/receipt
// invariants pass." Exported so the ADR, the scorer, and the replay all cite one source.
// ────────────────────────────────────────────────────────────────────────────────────────────────
export const PRIORITY_HIERARCHY = Object.freeze([
  { rank: 1, goal: 'correctness', kind: 'hard-gate' },
  { rank: 2, goal: 'no_latent_defects', kind: 'hard-gate' },
  { rank: 3, goal: 'receipt_completeness', kind: 'hard-gate' },
  { rank: 4, goal: 'cost_per_accepted_task', kind: 'optimize' },
  { rank: 5, goal: 'latency', kind: 'optimize' },
  { rank: 6, goal: 'token_reduction', kind: 'constraint' },
]);

/** Map a mode → the gateway `max_tokens` cap. The budget IS the wire cap (the real enforcement).
 *  Fable-only modes (minimal_patch/need_context/blocked) resolve from fableOutputBudgets; the shared
 *  general modes resolve from outputBudgets. verdict_only is identical (200) in both. */
export function modeToMaxTokens(mode) {
  if (mode in outputBudgets) return outputBudgets[mode];
  if (mode in fableOutputBudgets) return fableOutputBudgets[mode];
  throw new Error(`unknown output mode "${mode}"`);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Effective-cost scorer. effective_cost = in*inPrice + out*outPrice + retries*expectedRetryCost.
//    Prices are OpenRouter $/M (verified in agent-registry.mjs + FABLE-REPORT.md §4). Optimize
//    cost-per-ACCEPTED-task, never input alone (see costPerAccepted).
// ────────────────────────────────────────────────────────────────────────────────────────────────
/** @type {Record<string,{inPerM:number,outPerM:number}>} */
export const PRICES = Object.freeze({
  'anthropic/claude-fable-5': { inPerM: 10.0, outPerM: 50.0 },
  'anthropic/claude-opus-4.8': { inPerM: 5.0, outPerM: 25.0 },
  'anthropic/claude-sonnet-5': { inPerM: 2.0, outPerM: 10.0 },
  'anthropic/claude-haiku-4.5': { inPerM: 1.0, outPerM: 5.0 },
  'deepseek/deepseek-v4-pro': { inPerM: 0.28, outPerM: 0.42 },
  'deepseek/deepseek-v4-flash': { inPerM: 0.09, outPerM: 0.18 },
  'deepseek/deepseek-chat': { inPerM: 0.14, outPerM: 0.28 },
  'z-ai/glm-4.6': { inPerM: 0.40, outPerM: 1.75 },
});

export function priceFor(model) {
  return PRICES[model] || null;
}

/**
 * effectiveCost — the scorer. All token counts are absolute (not per-M).
 * @param {{inputTokens?:number,outputTokens?:number,retries?:number,expectedRetryCost?:number,
 *          price?:{inPerM:number,outPerM:number},model?:string}} a
 * @returns {number} USD
 */
export function effectiveCost({ inputTokens = 0, outputTokens = 0, retries = 0, expectedRetryCost = 0, price, model } = {}) {
  const p = price || (model ? priceFor(model) : null);
  if (!p) throw new Error('effectiveCost needs a price table or a known model');
  return (inputTokens / 1e6) * p.inPerM + (outputTokens / 1e6) * p.outPerM + retries * expectedRetryCost;
}

/**
 * costPerAccepted — the objective the whole policy optimizes. NOT input alone; NOT raw cost. Cost
 * divided by the number of ACCEPTED tasks. Returns Infinity when nothing was accepted.
 * @param {number} totalCost @param {number} acceptedCount
 */
export function costPerAccepted(totalCost, acceptedCount) {
  return acceptedCount > 0 ? totalCost / acceptedCount : Infinity;
}

/**
 * accepted(m) — the ANTI-PATHOLOGICAL-WIN gate (refinement §4). A run only counts as accepted when
 * it resolved AND carries no latent defect AND has full receipt coverage. A run that "saves 70%" by
 * accepting a thinner output that later fails does NOT count as accepted, so it cannot lower
 * cost-per-accepted-task. This is the mechanism that makes the priority hierarchy (§5) enforceable.
 * @typedef {{resolved:boolean,totalCostUsd:number,fableOutputTokens:number,retries:number,contractViolations:number,latentDefect:boolean,receiptCoverage:number}} EvalMetrics
 * @param {EvalMetrics} m
 */
export function accepted(m) {
  return !!m && m.resolved === true && m.latentDefect === false && m.receiptCoverage === 1;
}

/**
 * costPerAcceptedTask — sum(totalCostUsd over ALL runs) / count(runs where accepted(m)). The
 * denominator counts only genuinely-accepted runs (not merely resolved), so a pathological cheap
 * win that later fails inflates cost-per-accepted rather than lowering it.
 * @param {EvalMetrics[]} runs
 */
export function costPerAcceptedTask(runs) {
  const total = runs.reduce((s, m) => s + (m.totalCostUsd || 0), 0);
  const acc = runs.filter(accepted).length;
  return acc > 0 ? total / acc : Infinity;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// GOVERNANCE / AUDIT LAYER (refinement §3 pre-merge) — makes the contract DURABLE + erosion-DETECTABLE.
// ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * AcceptanceClass — the lagged-truth split (same verifier-vs-realized-outcome discipline as
 * ADR-231 / ADR-0026). The PRIMARY scorer stays strict + objective (harness-accepted); the SHADOW
 * business metric (user-accepted, delayed/noisy) is logged as the calibration check that keeps the
 * harness metric honest — it catches the Goodhart trap where output passes internal tests but is too
 * terse/confusing to be operationally usable. Harness metric drives optimization NOW; user metric is
 * the drift check, not yet the optimizer target.
 * @typedef {"harness_accepted"|"user_accepted"|"latent_defect_found"|"rolled_back"} AcceptanceClass
 * @typedef {{class:AcceptanceClass, totalCostUsd:number, latentDefect?:boolean, receiptCoverage?:number}} ClassifiedRun
 */

/** PRIMARY (optimizer target): totalCostUsd / count(harness_accepted && !latentDefect && receipt===1). */
export function costPerHarnessAccepted(runs) {
  const total = runs.reduce((s, r) => s + (r.totalCostUsd || 0), 0);
  const n = runs.filter((r) => r.class === 'harness_accepted' && r.latentDefect !== true && r.receiptCoverage === 1).length;
  return n > 0 ? total / n : Infinity;
}

/** SHADOW (calibration only, not the optimizer target yet): totalCostUsd / count(user_accepted && !rolled_back).
 *  rolled_back is a distinct AcceptanceClass, so counting user_accepted already excludes rollbacks. */
export function costPerUserAccepted(runs) {
  const total = runs.reduce((s, r) => s + (r.totalCostUsd || 0), 0);
  const n = runs.filter((r) => r.class === 'user_accepted').length;
  return n > 0 ? total / n : Infinity;
}

/**
 * fableAuditLine — the immutable, append-only audit record for ONE Fable call. Shipping this per call
 * is what makes contract erosion DETECTABLE (not merely forbidden): a JSONL scan / SQL over these rows
 * flags any Fable call whose mode escaped the allowed set. `full_prose_allowed` echoes the governance
 * constant so a flipped switch is visible in the audit trail.
 * @param {{mode:string,inputTokens:number,outputTokens:number,contractOk:boolean,receiptId:string}} c
 */
export function fableAuditLine(c) {
  return {
    model: 'fable',
    mode: c.mode,
    full_prose_allowed: FABLE_FULL_PROSE_ALLOWED,
    input_tokens: c.inputTokens | 0,
    output_tokens: c.outputTokens | 0,
    contract_ok: c.contractOk !== false,
    receipt_id: c.receiptId || null,
  };
}

/**
 * detectErosion — the ship-in-CI erosion query, as code (JSONL-scan equivalent of the SQL in the ADR).
 * Returns the OFFENDING rows: any fable call whose mode is not in the allowed set. Non-empty === the
 * runtime contract was violated. Mirrors:
 *   select * from model_calls where model='fable' and mode not in
 *     ('verdict_only','minimal_patch','need_context','blocked');
 * @param {Array<{model?:string,mode?:string}>} auditRows
 */
export function detectErosion(auditRows) {
  return (auditRows || []).filter((r) => r && r.model === 'fable' && !FABLE_LOOP_MODES.includes(r.mode));
}

// The 4-line MERGE CRITERION (refinement §3), as a machine-checkable contract for the PR gate + ADR.
export const MERGE_CRITERION = Object.freeze([
  'No Fable prose in-loop.',
  'No accepted run without receipt.',
  'No cost win counted without acceptance.',
  'No modeled claim reported as live result.',
]);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Output-contract enforcement. Each mode → allowed/forbidden sections + a validator that REJECTS
//    a violating output and returns the retry LADDER action. Retry order (refinement §3) never burns
//    a premium Fable retry first: repair-local → cheap-normalize → smaller-contract → Fable-last.
// ────────────────────────────────────────────────────────────────────────────────────────────────
/** @type {Record<string,{maxTokens:number,forbid:RegExp[],requireJson:boolean,jsonKeys?:string[]}>} */
export const CONTRACTS = Object.freeze({
  verdict_only: {
    maxTokens: outputBudgets.verdict_only, requireJson: true,
    jsonKeys: ['verdict'],
    // No prose narration, no markdown headers, no code fences around the JSON.
    forbid: [/^#{1,6}\s/m, /\bLet me\b/i, /\bI'll\b/i, /Here('|’)s\b/i],
  },
  minimal_patch: {
    maxTokens: fableOutputBudgets.minimal_patch, requireJson: false,
    // A patch turn is a diff or a search/replace edit — never an essay ABOUT the diff.
    forbid: [/\bLet me explain\b/i, /^\s*Here is (?:the|my) (?:fix|patch|solution)\b/im, /^#{1,6}\s.*\n[\s\S]{400,}/m],
  },
  patch_only: {
    maxTokens: outputBudgets.patch_only, requireJson: false,
    forbid: [/\bLet me explain\b/i, /^\s*Here is (?:the|my) (?:fix|patch|solution)\b/im],
  },
  capsule: {
    maxTokens: outputBudgets.capsule, requireJson: true,
    jsonKeys: ['goal', 'state', 'changed_files', 'open_risks', 'next_action', 'confidence'],
    forbid: [/\bchain of thought\b/i, /\breasoning trace\b/i],
  },
  json_delta: {
    maxTokens: outputBudgets.json_delta, requireJson: true,
    forbid: [/^#{1,6}\s/m],
  },
  need_context: {
    maxTokens: fableOutputBudgets.need_context, requireJson: true, jsonKeys: ['tool'],
    forbid: [/\bbecause\b[\s\S]{200,}/i],
  },
  blocked: {
    maxTokens: fableOutputBudgets.blocked, requireJson: false, forbid: [],
  },
  full_prose: {
    maxTokens: outputBudgets.full_prose, requireJson: false, forbid: [],
  },
});

/** Cheap local repair: strip code fences / a `>>>` prefix / leading prose before the first `{`.
 *  This is retry-ladder step (1) — no model call, no tokens spent. */
export function repairFormatLocal(text, { requireJson } = {}) {
  if (typeof text !== 'string') return { text: '', changed: false };
  let t = text.replace(/^>>>\s*/gm, '').trim();
  const fence = t.match(/^```(?:json|diff|python|[a-z]*)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) t = fence[1].trim();
  if (requireJson) {
    const first = t.indexOf('{'); const last = t.lastIndexOf('}');
    if (first > 0 && last > first) t = t.slice(first, last + 1);
  }
  return { text: t, changed: t !== text };
}

/**
 * validateOutput — REJECTS an output that violates its contract and returns the next retry action.
 * @param {string} text @param {OutputMode|FableOutputMode} mode
 * @param {{firstAttempt?:boolean}} opts — firstAttempt=true means we have not yet tried a local repair
 * @returns {{ok:boolean, violations:string[], action:'accept'|'repair_local'|'cheap_normalize'|'retry_smaller_contract'|'retry_fable', tokens:number}}
 */
export function validateOutput(text, mode, opts = {}) {
  const c = CONTRACTS[mode];
  if (!c) throw new Error(`no contract for mode "${mode}"`);
  const tokens = estTokens(text);
  const violations = [];
  if (tokens > c.maxTokens) violations.push(`over_budget:${tokens}>${c.maxTokens}`);
  for (const re of c.forbid) if (re.test(text)) violations.push(`forbidden_section:${re}`);
  if (c.requireJson) {
    const parsed = tryParseJson(text);
    if (!parsed) violations.push('not_json');
    else if (c.jsonKeys) for (const k of c.jsonKeys) if (!(k in parsed)) violations.push(`missing_key:${k}`);
  }
  if (violations.length === 0) return { ok: true, violations, action: 'accept', tokens };
  // Retry LADDER (§3) — a FORMATTING/SCHEMA violation is never an intelligence problem, so Fable is
  // never re-invoked here. Order: (1) local format repair (free) → (2) cheap-model normalize →
  // (3) smaller contract. `retry_fable` is emitted ONLY for a semantic failure, which is not a
  // validateOutput concern — the caller drives that from parseVerdict (verdict=revise/escalate).
  let action;
  if (opts.firstAttempt !== false && (violations.includes('not_json') || violations.some((v) => v.startsWith('forbidden_section')))) {
    action = 'repair_local';       // free, no tokens
  } else if (violations.every((v) => /^not_json$|^forbidden_section/.test(v))) {
    action = 'cheap_normalize';     // cheap model reshapes the format
  } else {
    action = 'retry_smaller_contract'; // over_budget / missing_key → shrink the schema, still not Fable
  }
  return { ok: false, violations, action, tokens };
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  try { const o = JSON.parse(t); return (o && typeof o === 'object') ? o : null; } catch { /* try substring */ }
  const first = t.indexOf('{'); const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) { try { const o = JSON.parse(t.slice(first, last + 1)); return (o && typeof o === 'object') ? o : null; } catch { /**/ } }
  return null;
}
export { tryParseJson };

/**
 * handleContractViolation — the non-Fable repair chain (refinement §3, verbatim contract). "Formatting
 * failure is not an intelligence problem": Fable is NEVER re-invoked to fix malformed JSON / over-budget
 * output. Order: local repair → cheap-model normalize → smaller contract → throw. Fable is re-invoked
 * ONLY when the SEMANTIC task failed (verdict=revise/escalate), which is a different code path.
 *
 * @typedef {{ok:true,parsed:unknown}|{ok:false,reason:'malformed_json'|'schema_violation'|'over_budget'}} ContractResult
 * @param {ContractResult} result — the initial parse/validate outcome
 * @param {string} raw — the raw model output
 * @param {{tryLocalRepair?:(raw:string)=>ContractResult, cheapNormalize?:(raw:string)=>Promise<ContractResult>, retryWithSmallerContract?:(raw:string)=>Promise<ContractResult>}} deps
 * @returns {Promise<unknown>}
 */
export async function handleContractViolation(result, raw, deps = {}) {
  if (result.ok) return result.parsed;
  const tryLocalRepair = deps.tryLocalRepair || defaultTryLocalRepair;
  const cheapNormalize = deps.cheapNormalize || (async () => ({ ok: false, reason: 'malformed_json' }));
  const retryWithSmallerContract = deps.retryWithSmallerContract || (async () => ({ ok: false, reason: 'schema_violation' }));
  const local = tryLocalRepair(raw); if (local.ok) return local.parsed;
  const normalized = await cheapNormalize(raw); if (normalized.ok) return normalized.parsed;
  const smaller = await retryWithSmallerContract(raw); if (smaller.ok) return smaller.parsed;
  throw new Error('Contract failed after non-Fable repairs');
}

/** Default local repair used by handleContractViolation: strip fences/prefix and re-parse JSON. */
export function defaultTryLocalRepair(raw) {
  const { text } = repairFormatLocal(raw, { requireJson: true });
  const parsed = tryParseJson(text);
  return parsed ? { ok: true, parsed } : { ok: false, reason: 'malformed_json' };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Draft-cheap / verify-expensive (the strongest lever). A cheap model (glm/deepseek) DRAFTS; Fable
//    emits a small VERDICT JSON with an INVARIANT checklist baked in — decisions, not vibes. The
//    invariant checklist is what protects against budget-induced under-specification (refinement §2):
//    a short verdict is still forced to answer each invariant, so a hidden failure cannot slip an
//    "accept" past the schema.
// ────────────────────────────────────────────────────────────────────────────────────────────────
export const VERDICT_INVARIANTS = Object.freeze([
  'tests_pass',            // the repo's own tests pass with this patch applied
  'no_public_api_change',  // no signature/behaviour change to a public API
  'no_security_regression',// no new injection / auth / path-traversal surface
  'minimal_diff',          // the diff is the smallest that fixes the issue
  'acceptance_criterion',  // the issue's stated acceptance criterion is met
]);

/** Build the verify-expensive prompt: cheap draft in, invariant-gated verdict out. */
export function buildVerdictPrompt(problem, draftPatch, testTrace = '') {
  return [
    'You are the VERIFY rung. A cheap model produced the DRAFT PATCH below. Do NOT rewrite it as prose.',
    'Emit ONLY a JSON verdict of this exact shape (no markdown, no explanation outside the JSON):',
    '{"verdict":"accept|revise|escalate","invariants":{' + VERDICT_INVARIANTS.map((i) => `"${i}":true|false`).join(',') + '},"blocking_issues":[],"minimal_patch":"<a corrected minimal unified diff, ONLY if verdict!=accept>"}',
    'Rules: verdict="accept" is ALLOWED only when every invariant is true. If any invariant is false it MUST appear in blocking_issues. Judge by the invariants, not by vibes.',
    '',
    `ISSUE:\n${String(problem).slice(0, 4000)}`,
    '',
    `DRAFT PATCH:\n${String(draftPatch).slice(0, 6000)}`,
    testTrace ? `\nTEST TRACE:\n${String(testTrace).slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * parseVerdict — parse + LATENT-DEFECT gate (§2). An "accept" whose invariants are not all-true, or
 * whose false invariants are not listed as blocking_issues, is DOWNGRADED to "revise" — a short
 * output cannot launder a hidden failure past the checklist.
 * @param {string} raw
 * @returns {{verdict:'accept'|'revise'|'escalate', invariants:Record<string,boolean>, blocking_issues:string[], minimal_patch:string, downgraded:boolean, reason?:string}}
 */
export function parseVerdict(raw) {
  const o = tryParseJson(raw) || {};
  let verdict = /^(accept|revise|escalate)$/.test(o.verdict) ? o.verdict : 'revise';
  const invariants = (o.invariants && typeof o.invariants === 'object') ? o.invariants : {};
  const blocking = Array.isArray(o.blocking_issues) ? o.blocking_issues : [];
  const minimal_patch = typeof o.minimal_patch === 'string' ? o.minimal_patch : '';
  let downgraded = false; let reason;
  if (verdict === 'accept') {
    const failed = VERDICT_INVARIANTS.filter((i) => invariants[i] === false);
    const missing = VERDICT_INVARIANTS.filter((i) => !(i in invariants));
    if (failed.length) { verdict = 'revise'; downgraded = true; reason = `accept with failing invariants: ${failed.join(',')}`; }
    else if (missing.length) { verdict = 'revise'; downgraded = true; reason = `accept with unanswered invariants: ${missing.join(',')}`; }
  }
  return { verdict, invariants, blocking_issues: blocking, minimal_patch, downgraded, reason };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 5. Continuation-verifier gate. Before each expensive Fable turn a CHEAP check decides whether the
//    premium turn is worth it. Schema (refinement §4): brutal + cheap.
//      { "continue_fable": bool, "next": "run_tests|cheap_repair|stop|need_context", "reason": "≤20 words" }
// ────────────────────────────────────────────────────────────────────────────────────────────────
export const CONTINUATION_NEXT = Object.freeze(['run_tests', 'cheap_repair', 'stop', 'need_context']);

export function buildContinuationPrompt(state) {
  return [
    'You gate an EXPENSIVE Fable turn. Decide if it is worth spending. Emit ONLY this JSON:',
    '{"continue_fable":true|false,"next":"run_tests|cheap_repair|stop|need_context","reason":"<=20 words"}',
    '',
    `STATE:\n${String(state).slice(0, 2000)}`,
  ].join('\n');
}

/** Parse the gate output; coerce to the strict schema. */
export function parseContinuation(raw) {
  const o = tryParseJson(raw) || {};
  const next = CONTINUATION_NEXT.includes(o.next) ? o.next : 'stop';
  const cont = o.continue_fable === true && next !== 'stop';
  const reason = String(o.reason || '').split(/\s+/).slice(0, 20).join(' ');
  return { continue_fable: cont, next, reason };
}

/**
 * decideContinuationHeuristic — a $0 cheap fallback gate (no model call). Early-stops failed
 * trajectories: repeated identical test failures / thrash → don't spend the Fable turn.
 * @param {{consecutiveTestFails?:number, repeatedEdits?:number, madeProgress?:boolean, needContext?:boolean, step?:number, maxSteps?:number}} s
 */
export function decideContinuationHeuristic(s = {}) {
  if (s.needContext) return { continue_fable: false, next: 'need_context', reason: 'missing context; fetch before spending fable turn' };
  if ((s.consecutiveTestFails || 0) >= 3 && !s.madeProgress) return { continue_fable: false, next: 'cheap_repair', reason: 'thrashing on same failure; hand to cheap repair' };
  if ((s.repeatedEdits || 0) >= 3) return { continue_fable: false, next: 'stop', reason: 'repeated no-op edits; stop the trajectory' };
  if (s.maxSteps && s.step != null && s.step >= s.maxSteps - 1) return { continue_fable: false, next: 'run_tests', reason: 'budget nearly exhausted; verify current patch' };
  return { continue_fable: true, next: 'run_tests', reason: 'progress plausible; proceed' };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 6. Capsule protocol — the default inter-agent handoff (≤800 tok). Fable never emits a full
//    reasoning trace between agents; it emits a capsule.
// ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {{goal?:string,state?:string[],changed_files?:string[],open_risks?:string[],next_action?:string,confidence?:number}} c
 */
export function buildCapsule(c = {}) {
  const capsule = {
    goal: String(c.goal || '').slice(0, 240),
    state: (Array.isArray(c.state) ? c.state : []).slice(0, 5).map((s) => String(s).slice(0, 160)),
    changed_files: (Array.isArray(c.changed_files) ? c.changed_files : []).slice(0, 20),
    open_risks: (Array.isArray(c.open_risks) ? c.open_risks : []).slice(0, 8).map((s) => String(s).slice(0, 160)),
    next_action: String(c.next_action || '').slice(0, 200),
    confidence: typeof c.confidence === 'number' ? Math.max(0, Math.min(1, c.confidence)) : 0.5,
  };
  return capsule;
}

/** Validate a capsule fits the budget + shape. Returns {ok, tokens, violations}. */
export function validateCapsule(capsule) {
  const text = JSON.stringify(capsule);
  const tokens = estTokens(text);
  const violations = [];
  if (tokens > outputBudgets.capsule) violations.push(`over_budget:${tokens}>${outputBudgets.capsule}`);
  if (!capsule || typeof capsule !== 'object') violations.push('not_object');
  else {
    for (const k of ['goal', 'state', 'changed_files', 'open_risks', 'next_action', 'confidence']) if (!(k in capsule)) violations.push(`missing_key:${k}`);
    if (Array.isArray(capsule.state) && capsule.state.length > 5) violations.push('state_over_5_bullets');
  }
  return { ok: violations.length === 0, tokens, violations };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 7. Observability preserved (the flagged risk). Full artifacts (diffs, tool outputs, verifier
//    scores, capsules, receipts) are logged OUTSIDE the model path — we never ask Fable to narrate
//    them. This keeps 100% debug-artifact receipt coverage while the model stays terse.
//    The logger is the ONLY I/O in this module and is opt-in (a dir must be passed).
// ────────────────────────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

/**
 * makeArtifactLogger(dir, fs) — returns { log(kind, payload) => receipt, receipts }.
 * `fs` is injected (default node:fs) so the logger is unit-testable without touching disk.
 * A receipt is { id, kind, sha256, bytes, ts } — the model path only ever sees the receipt id,
 * never the payload, so terseness and full observability coexist.
 */
export function makeArtifactLogger(dir, fsImpl) {
  const receipts = [];
  const log = (kind, payload) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const id = `${kind}-${sha256.slice(0, 12)}`;
    const receipt = { id, kind, sha256, bytes: Buffer.byteLength(body), ts: Date.now() };
    if (dir && fsImpl) {
      try { fsImpl.mkdirSync(dir, { recursive: true }); fsImpl.writeFileSync(`${dir}/${id}.txt`, body); } catch { /* logging must never break the solve */ }
    }
    receipts.push(receipt);
    return receipt;
  };
  return { log, receipts };
}

/** receiptCoverage — the §6 live-gate metric: fraction of artifact KINDS that produced a receipt. */
export function receiptCoverage(receipts, expectedKinds) {
  if (!expectedKinds || !expectedKinds.length) return 1;
  const seen = new Set(receipts.map((r) => r.kind));
  return expectedKinds.filter((k) => seen.has(k)).length / expectedKinds.length;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 8. Recommended stage table (ADR-232). Exported so the cascade + replay agree on one source.
// ────────────────────────────────────────────────────────────────────────────────────────────────
export const STAGE_TABLE = Object.freeze([
  { stage: 'Localize', model: 'glm/deepseek', mode: 'json_delta', note: 'file-list only — never prose' },
  { stage: 'Draft', model: 'cheap', mode: 'patch_only', note: 'cheap unified-diff draft' },
  { stage: 'Test', model: 'tools', mode: 'json_delta', note: 'run the repo tests — no model output' },
  { stage: 'Review', model: 'fable', mode: 'verdict_only', note: 'verdict JSON <300 tok, invariant-gated' },
  { stage: 'Repair', model: 'fable', mode: 'minimal_patch', note: 'minimal diff ONLY on failure' },
  { stage: 'Final', model: 'cheap/renderer', mode: 'full_prose', note: 'template-fill — NOT Fable' },
]);
