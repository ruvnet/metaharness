// SPDX-License-Identifier: MIT

import type { AuditSink, McpLane, ToolPolicyConfig } from './types.js';
import { opaqueAuditHash } from './audit.js';

export const ACTOR_TOOLS = [
  'arc_start',
  'arc_observe',
  'arc_act',
  'arc_supervise',
  'arc_checkpoint',
  'arc_resume',
  'arc_status',
  'arc_receipts_verify',
  'arc_render',
  'arc_memory_query',
  'arc_memory_commit',
  'arc_graph_frontier',
  'arc_execute_guarded_plan',
] as const;

export const BOSS_TOOLS = [
  'arc_supervisor_case',
  'arc_supervisor_directive_commit',
] as const;

export const DEFAULT_TOOL_POLICY: ToolPolicyConfig = {
  toolTimeoutMs: 10_000,
  maxToolCallsPerMinute: 120,
};

export const MAX_TOOL_TIMEOUT_MS = 300_000;
export const MAX_TOOL_CALLS_PER_MINUTE = 100_000;

function validateToolPolicy(config: ToolPolicyConfig): ToolPolicyConfig {
  const bounds: Readonly<Record<keyof ToolPolicyConfig, number>> = {
    toolTimeoutMs: MAX_TOOL_TIMEOUT_MS,
    maxToolCallsPerMinute: MAX_TOOL_CALLS_PER_MINUTE,
  };
  for (const [name, maximum] of Object.entries(bounds) as
    [keyof ToolPolicyConfig, number][]) {
    const value = config[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
    }
  }
  return Object.freeze({ ...config });
}

const TOOLS_BY_LANE: Record<McpLane, ReadonlySet<string>> = {
  actor: new Set(ACTOR_TOOLS),
  boss: new Set(BOSS_TOOLS),
};

interface RateWindow {
  startedAt: number;
  count: number;
}

export class ToolPolicyGate {
  private readonly windows = new Map<string, RateWindow>();
  readonly config: ToolPolicyConfig;

  constructor(
    private readonly audit: AuditSink,
    config: Partial<ToolPolicyConfig> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = validateToolPolicy({ ...DEFAULT_TOOL_POLICY, ...config });
  }

  private consume(principalId: string): boolean {
    const timestamp = this.now().getTime();
    const window = this.windows.get(principalId);
    if (!window || timestamp - window.startedAt >= 60_000) {
      this.windows.set(principalId, { startedAt: timestamp, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.config.maxToolCallsPerMinute;
  }

  async run<T>(options: {
    lane: McpLane;
    tool: string;
    principalId: string;
    episodeId?: string;
    /** Deadlines may detach reads, but never a mutating environment operation. */
    readOnly: boolean;
    body: () => Promise<T>;
  }): Promise<T> {
    const started = this.now().getTime();
    const base = {
      timestamp: this.now().toISOString(),
      lane: options.lane,
      tool: options.tool,
      principalHash: opaqueAuditHash(options.principalId),
      episodeHash: options.episodeId ? opaqueAuditHash(options.episodeId) : undefined,
    };

    if (!TOOLS_BY_LANE[options.lane].has(options.tool)) {
      await this.audit.write({ ...base, decision: 'denied', reason: 'default-deny', durationMs: 0 });
      throw new Error('tool is not allowed in this MCP lane');
    }
    if (!this.consume(options.principalId)) {
      await this.audit.write({ ...base, decision: 'denied', reason: 'rate-limit', durationMs: 0 });
      throw new Error('tool call rate limit exceeded');
    }

    // Authorization is durable before any mutation begins. If the audit sink
    // is unavailable, this throws and the tool body is never invoked.
    await this.audit.write({
      ...base,
      decision: 'allowed',
      reason: 'authorized',
      durationMs: 0,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let result: T;
      if (options.readOnly) {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('read-only tool deadline exceeded')), this.config.toolTimeoutMs);
        });
        result = await Promise.race([options.body(), timeout]);
      } else {
        // An abandoned Promise.race can let a write finish after ChatGPT was
        // told it failed. Mutations therefore run to completion and depend on
        // controller CAS, guards, and idempotency for safe retries.
        result = await options.body();
      }
      await this.audit.write({
        ...base,
        decision: 'allowed',
        reason: 'completed',
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      return result;
    } catch {
      await this.audit.write({
        ...base,
        decision: 'error',
        reason: 'tool-failed',
        durationMs: Math.max(0, this.now().getTime() - started),
      });
      throw new Error('ARC tool failed at the protected environment boundary');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
