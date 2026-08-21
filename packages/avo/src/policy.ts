// SPDX-License-Identifier: MIT

import type { CapabilityPolicy } from './ports.js';
import type { ActionKind, PolicyDecision, VariationAction, VariationState } from './types.js';

export interface GovernedPolicyOptions {
  version: string;
  allowedActions: ActionKind[];
  approvalActions?: ActionKind[];
  allowedCommands?: RegExp[];
  writablePaths?: RegExp[];
  riskByAction?: Partial<Record<ActionKind, number>>;
}

/** Immutable, default-deny policy. It has no API for widening itself at runtime. */
export class GovernedCapabilityPolicy implements CapabilityPolicy {
  readonly version: string;
  private readonly allowed: ReadonlySet<ActionKind>;
  private readonly approval: ReadonlySet<ActionKind>;
  private readonly commands: readonly RegExp[];
  private readonly paths: readonly RegExp[];
  private readonly risks: Readonly<Partial<Record<ActionKind, number>>>;

  constructor(options: GovernedPolicyOptions) {
    this.version = options.version;
    this.allowed = new Set(options.allowedActions);
    this.approval = new Set(options.approvalActions ?? ['execute', 'commit']);
    this.commands = Object.freeze([...(options.allowedCommands ?? [])]);
    this.paths = Object.freeze([...(options.writablePaths ?? [])]);
    this.risks = Object.freeze({ ...options.riskByAction });
    Object.freeze(this);
  }

  authorize(action: VariationAction, state: Readonly<VariationState>): PolicyDecision {
    const riskCharge = this.risks[action.kind] ?? 0;
    const deny = (reason: string): PolicyDecision => ({
      verdict: 'deny', reason, policyVersion: this.version, riskCharge: 0,
    });
    if (!this.allowed.has(action.kind)) return deny(`action ${action.kind} is outside the capability envelope`);
    if (state.budget.riskUsed + riskCharge > state.budget.riskBudget) return deny('risk budget exhausted');
    if (action.kind === 'edit' && !this.paths.some((pattern) => matches(pattern, action.path))) {
      return deny(`write path is outside the bounded workspace policy: ${action.path}`);
    }
    if (action.kind === 'execute' && !this.commands.some((pattern) => matches(pattern, action.command))) {
      return deny('command is not allowlisted');
    }
    return {
      verdict: this.approval.has(action.kind) ? 'require-approval' : 'allow',
      reason: this.approval.has(action.kind) ? 'explicit approval required' : 'inside immutable capability envelope',
      policyVersion: this.version,
      riskCharge,
    };
  }
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
