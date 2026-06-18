// SPDX-License-Identifier: MIT
//
// The sandbox runner (ADR-070 §sandbox, ADR-071 §gate) — the only place a
// variant's test command actually executes. It is the execution half of the
// evaluation side; the scorer (scorer.ts) is the judgement half.
//
// Two non-negotiable security properties, both pinned by tests:
//
//   1. The ADR-071 safety gate runs FIRST. A variant directory that fails
//      `inspectVariant` never has any command run: the trace is sealed with the
//      reserved exit code 99 and the findings recorded as blockedActions.
//   2. No shell, scrubbed environment. The test command is split into argv and
//      run via `execFile` (never a shell, so no command-injection surface), and
//      with a minimal env — PATH plus three identifying variables — so secrets,
//      tokens, and proxy settings in `process.env` never leak into a variant.
//
// `runVariantTask` never throws: a failing or timing-out command becomes a
// RunTrace, not an exception, so the evolution loop cannot be aborted by a
// hostile or broken variant.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectVariant } from './safety.js';
import type { HarnessVariant, RepoProfile, RunTrace } from './types.js';

const execFileAsync = promisify(execFile);

/** Reserved exit code meaning "disqualified by the safety gate before running". */
const DISQUALIFIED_EXIT_CODE = 99;

/** Default per-variant test-command wall-clock budget (ms). */
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

/** Default cap on captured stdout/stderr (bytes) before the process is killed. */
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** Tunables for one sandboxed run. */
export interface SandboxOptions {
  /** Wall-clock budget for the test command (ms). Default 120000. */
  taskTimeoutMs?: number;
  /** Max bytes of combined stdout/stderr to buffer. Default 8 MiB. */
  maxBufferBytes?: number;
}

/** Shape of the error `execFile` rejects with (Node augments it in place). */
interface ExecError extends Error {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

/**
 * Split a test command into argv by whitespace. Deliberately simple: there is
 * no shell, so there is no quoting/globbing to honour — the command comes from
 * the RepoProfile, not the variant, and `execFile` receives a bare argv.
 */
function toArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter((part) => part.length > 0);
}

/**
 * The minimal, scrubbed environment a variant's test command runs under. Only
 * PATH (so the runtime is findable) plus three identifying variables are
 * exposed; nothing else from `process.env` is passed through, so secrets,
 * tokens, and proxy configuration cannot leak into a variant.
 */
function scrubbedEnv(variantId: string, taskId: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'test',
    METAHARNESS_VARIANT: variantId,
    METAHARNESS_TASK: taskId,
  };
}

/**
 * Run one variant against one task in the sandbox.
 *
 * The ADR-071 safety gate runs first: if `inspectVariant` reports any findings,
 * no command is executed and a disqualified trace (exitCode 99) is returned.
 * Otherwise the profile's `testCommand` is executed via `execFile` (no shell)
 * with a scrubbed env. Never throws — failures become RunTraces.
 */
export async function runVariantTask(
  variant: HarnessVariant,
  profile: RepoProfile,
  taskId: string,
  opts?: SandboxOptions,
): Promise<RunTrace> {
  const startedAt = new Date();

  // ── Gate first: a disqualified variant never runs anything (ADR-071). ──
  const findings = await inspectVariant(variant.dir);
  if (findings.length > 0) {
    const finishedAt = new Date();
    return {
      variantId: variant.id,
      taskId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: DISQUALIFIED_EXIT_CODE,
      stdout: '',
      stderr: findings.join('\n'),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      timedOut: false,
      blockedActions: findings,
    };
  }

  const timeout = opts?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const maxBuffer = opts?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const argv = toArgv(profile.testCommand);
  const env = scrubbedEnv(variant.id, taskId);

  // A malformed (empty) command cannot run — treat as a benign failure trace.
  if (argv.length === 0) {
    const finishedAt = new Date();
    return {
      variantId: variant.id,
      taskId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: 1,
      stdout: '',
      stderr: 'empty testCommand',
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      timedOut: false,
      blockedActions: [],
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
      cwd: profile.root,
      timeout,
      maxBuffer,
      env,
      windowsHide: true,
      // No `shell` option: execFile never invokes a shell (no injection surface).
    });
    const finishedAt = new Date();
    return {
      variantId: variant.id,
      taskId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      timedOut: false,
      blockedActions: [],
    };
  } catch (err) {
    const e = err as ExecError;
    const finishedAt = new Date();
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    return {
      variantId: variant.id,
      taskId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      timedOut,
      blockedActions: [],
    };
  }
}

/**
 * Run a variant against a list of tasks sequentially, returning every trace.
 * Sequential by design: it bounds resource use and keeps traces deterministic
 * (the population-level concurrency budget lives in the evolution loop, not here).
 */
export async function runVariantTasks(
  variant: HarnessVariant,
  profile: RepoProfile,
  taskIds: string[],
  opts?: SandboxOptions,
): Promise<RunTrace[]> {
  const traces: RunTrace[] = [];
  for (const taskId of taskIds) {
    traces.push(await runVariantTask(variant, profile, taskId, opts));
  }
  return traces;
}
