// SPDX-License-Identifier: MIT
//
// Default `NumericEvaluator` (ADR-272): spawns a caller-supplied command
// (never a shell — argv split by the CLI, exactly like `sandbox.ts`'s
// task runner), writes `{ variantId, genome }` as JSON to its stdin, and
// parses a `NumericScoreCard`-shaped JSON object from its stdout. This is the
// numeric kind's whole fitness function — Darwin Mode itself never trains or
// scores anything; it only ever calls this once per candidate.

import { spawn } from 'node:child_process';
import type { NumericEvaluator, NumericGenome, NumericScoreCard } from './numeric-types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ShellEvaluatorOptions {
  /** argv[0] and the rest, e.g. `['node', 'gate-cli.mjs']` — never passed through a shell. */
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Extra env vars layered over the inherited parent environment (see `evaluate` for why it is not scrubbed). */
  readonly env?: Readonly<Record<string, string>>;
}

/** Spawns `options.command` per candidate; genome in on stdin, `NumericScoreCard` out on stdout. */
export class ShellEvaluator implements NumericEvaluator {
  constructor(private readonly options: ShellEvaluatorOptions) {}

  async evaluate(genome: NumericGenome, variantId: string): Promise<NumericScoreCard> {
    const [cmd, ...args] = this.options.command;
    if (!cmd) {
      return errorCard(variantId, 'ShellEvaluator: empty command');
    }
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Unlike the prompt kind's sandbox (untrusted, potentially LLM-generated
    // test commands — deliberately env-scrubbed), `--evaluator` here is a
    // fixed, operator-supplied command: the numeric kind's whole contract is
    // "you already trust this command enough to run it once per candidate".
    // Inherit the full parent env by default (a hand-picked scrub broke Node's
    // own crypto init on Windows — CSPRNG needs more than PATH/HOME/SystemRoot
    // — with no corresponding security benefit here). `options.env` still
    // layers on top for evaluator-specific overrides.
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.options.env,
    };

    return new Promise<NumericScoreCard>((resolvePromise) => {
      const child = spawn(cmd, args, {
        cwd: this.options.cwd,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        resolvePromise(errorCard(variantId, `evaluator timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(errorCard(variantId, `evaluator spawn failed: ${error.message}`));
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolvePromise(errorCard(variantId, `evaluator exited ${code}: ${stderr.trim().slice(-2000)}`));
          return;
        }
        resolvePromise(parseScoreCard(variantId, stdout, stderr));
      });

      // An evaluator that exits before (or without) reading its stdin — a bad
      // argv, an immediate `process.exit`, a crash on startup — leaves this
      // pipe closed by the time we write, and an unhandled EPIPE on the stdin
      // socket takes down the whole run instead of demoting one candidate.
      // The race is platform-dependent (Linux usually completes the write
      // first; macOS often does not), so this must be handled, not hoped
      // past. Swallow it here: `close`/`error` above already resolve with a
      // demoting errorCard carrying the child's real exit code.
      child.stdin?.on('error', () => {});
      child.stdin?.write(JSON.stringify({ variantId, genome }));
      child.stdin?.end();
    });
  }
}

function parseScoreCard(variantId: string, stdout: string, stderr: string): NumericScoreCard {
  const trimmed = stdout.trim();
  // Try the whole trimmed output first (the common case: stdout IS the JSON
  // object, nothing else). Only if that fails — e.g. a log line printed before
  // the payload — fall back to the FIRST '{' (not the last: the payload
  // itself commonly nests objects, e.g. `raw`, so `lastIndexOf` would slice
  // into the middle of it and produce invalid JSON).
  let parsed: Partial<NumericScoreCard>;
  try {
    parsed = JSON.parse(trimmed) as Partial<NumericScoreCard>;
  } catch {
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart < 0) {
      return errorCard(variantId, `evaluator produced non-JSON stdout: ${trimmed.slice(0, 500)}${stderr ? ` (stderr: ${stderr.trim().slice(0, 500)})` : ''}`);
    }
    try {
      parsed = JSON.parse(trimmed.slice(jsonStart)) as Partial<NumericScoreCard>;
    } catch {
      return errorCard(variantId, `evaluator produced non-JSON stdout: ${trimmed.slice(0, 500)}${stderr ? ` (stderr: ${stderr.trim().slice(0, 500)})` : ''}`);
    }
  }
  {
    if (typeof parsed.primary !== 'number' || !Number.isFinite(parsed.primary)) {
      return errorCard(variantId, `evaluator output missing numeric "primary": ${trimmed.slice(0, 500)}`);
    }
    return {
      variantId,
      primary: parsed.primary,
      regressed: Boolean(parsed.regressed),
      noopRate: typeof parsed.noopRate === 'number' ? parsed.noopRate : 0,
      costPerWin: typeof parsed.costPerWin === 'number' ? parsed.costPerWin : 0,
      raw: parsed.raw,
    };
  }
}

/** A worst-case scorecard so an evaluator failure demotes the candidate instead of crashing the run. */
function errorCard(variantId: string, message: string): NumericScoreCard {
  return { variantId, primary: -Infinity, regressed: true, noopRate: 1, costPerWin: Infinity, evaluatorError: message };
}
