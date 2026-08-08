// @metaharness/oo-agents — model drivers. The driver is the ONLY seam where a
// model enters: it sees the assembled context (prompts, contract, args,
// capabilities, prior cells with their outputs and any contract error) and
// emits the next cell of cellscript. A real LLM driver is host wiring (the
// kernel owns routing); the package ships the deterministic ScriptedDriver
// used by tests and simulations.

import { AgenticContext, DriverStep, ModelDriver } from './agent.js';

/** Plays a fixed list of cells, with optional reactions to contract errors —
 *  enough to exercise every runtime path deterministically. */
export class ScriptedDriver implements ModelDriver {
  private i = 0;
  constructor(
    private readonly cells: string[],
    /** Cell to emit when the previous signal failed its contract (the typed
     *  auto-retry path). Defaults to re-emitting the next scripted cell. */
    private readonly onContractError?: (error: string, ctx: AgenticContext) => string,
  ) {}

  async next(ctx: AgenticContext): Promise<DriverStep> {
    const last = ctx.cells[ctx.cells.length - 1];
    if (last?.contractError && this.onContractError) {
      return { kind: 'cell', code: this.onContractError(last.contractError, ctx) };
    }
    if (this.i >= this.cells.length) {
      throw new Error('ScriptedDriver ran out of cells');
    }
    return { kind: 'cell', code: this.cells[this.i++] };
  }
}

/** Render the context as a single prompt string — what a real LLM driver
 *  would send. Exported so drivers stay consistent and testable. */
export function renderContext(ctx: AgenticContext): string {
  const lines = [
    `SYSTEM: ${ctx.agentDoc}`,
    `TASK (${ctx.methodName}): ${ctx.methodDoc}`,
    `RETURN CONTRACT: ${ctx.contract} — finish with return_result(value)`,
    `ARGS: ${JSON.stringify(ctx.args)}`,
    `STATE FIELDS: ${ctx.fields.map((f) => `self.${f}`).join(', ') || '(none)'}`,
    `CAPABILITIES: ${ctx.capabilities.map((c) => `self.${c}(...)`).join(', ') || '(none)'}`,
  ];
  for (const cell of ctx.cells) {
    lines.push(`CELL:\n${cell.code}`);
    if (cell.outcome.prints.length) lines.push(`PRINTS: ${cell.outcome.prints.join(' | ')}`);
    lines.push(
      cell.outcome.kind === 'error'
        ? `ERROR: ${cell.outcome.message}`
        : `${cell.outcome.kind.toUpperCase()}: ${JSON.stringify(cell.outcome.value ?? null)}`,
    );
    if (cell.contractError) lines.push(`CONTRACT ERROR: ${cell.contractError}`);
  }
  return lines.join('\n');
}
