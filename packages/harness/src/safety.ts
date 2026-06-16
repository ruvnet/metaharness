// SPDX-License-Identifier: MIT
//
// Safety layer (ADR-047): policy rules + risk scoring. Default-deny on tools, in
// keeping with the ADR-022 MCP posture — an action is allowed only if it clears
// the rules AND its scored risk is within budget.

/** A proposed action the harness is about to take. */
export interface Action {
  /** What the action does, e.g. "write_file", "shell", "http". */
  tool: string;
  /** Free-form arguments; matched against rules and risk signals. */
  args?: Record<string, unknown>;
}

/** A policy rule. `match` returns true if the rule applies to the action. */
export interface PolicyRule {
  id: string;
  effect: 'allow' | 'deny';
  match: (a: Action) => boolean;
  /** Risk contribution (0..1) added when this rule matches (deny rules dominate). */
  risk?: number;
}

export interface PolicyDecision {
  allow: boolean;
  /** Scored risk, 0..1. */
  risk: number;
  reasons: string[];
}

/**
 * Policy gate. Evaluation is **default-deny**: an action must match at least one
 * `allow` rule and no `deny` rule. Risk is the max risk contribution among
 * matched rules, so a single high-risk signal cannot be averaged away.
 */
export class PolicyGate {
  private readonly rules: PolicyRule[];
  /** Risk above this is blocked even for allow-listed tools. */
  private readonly riskCeiling: number;

  constructor(rules: PolicyRule[] = [], riskCeiling = 1) {
    this.rules = rules;
    this.riskCeiling = riskCeiling;
  }

  add(rule: PolicyRule): this {
    this.rules.push(rule);
    return this;
  }

  evaluate(action: Action): PolicyDecision {
    const matched = this.rules.filter((r) => safeMatch(r, action));
    const denies = matched.filter((r) => r.effect === 'deny');
    const allows = matched.filter((r) => r.effect === 'allow');
    const risk = matched.reduce((m, r) => Math.max(m, r.risk ?? 0), 0);
    const reasons: string[] = [];

    if (denies.length) reasons.push(`denied by ${denies.map((r) => r.id).join(', ')}`);
    if (!allows.length) reasons.push(`no allow rule matched tool "${action.tool}" (default-deny)`);
    if (risk > this.riskCeiling) reasons.push(`risk ${risk} > ceiling ${this.riskCeiling}`);

    const allow = denies.length === 0 && allows.length > 0 && risk <= this.riskCeiling;
    if (allow) reasons.push(`allowed by ${allows.map((r) => r.id).join(', ')}`);
    return { allow, risk, reasons };
  }
}

function safeMatch(rule: PolicyRule, action: Action): boolean {
  try {
    return rule.match(action);
  } catch {
    // A throwing matcher must never silently allow — treat as non-match.
    return false;
  }
}

/** Allow a fixed set of tools at a given risk. Common starting policy. */
export function allowTools(ids: string[], risk = 0.1): PolicyRule {
  const set = new Set(ids);
  return { id: `allow:${ids.join('|')}`, effect: 'allow', match: (a) => set.has(a.tool), risk };
}

/** Deny a fixed set of tools outright (deny dominates allow). */
export function denyTools(ids: string[], risk = 1): PolicyRule {
  const set = new Set(ids);
  return { id: `deny:${ids.join('|')}`, effect: 'deny', match: (a) => set.has(a.tool), risk };
}
