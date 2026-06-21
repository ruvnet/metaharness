// SPDX-License-Identifier: MIT
//
// @metaharness/projects — sandbox.ts (network-isolated sandboxed execution).
//
// The discovery/verifier pipeline runs GENERATED and THIRD-PARTY code (proofs,
// candidate exploits, untrusted snippets) against targets. Such code must never
// reach the network: a malicious or buggy proof could exfiltrate data, fetch a
// second-stage payload, or phone home. This module wraps an arbitrary command in
// a new Linux user + network namespace via `unshare -rn <cmd>`, which yields a
// namespace with NO network interfaces (not even loopback is configured), so any
// connect()/DNS attempt fails — while pure CPU/compute is unaffected.
//
// Layering for testability:
//   * buildSandboxArgv() is PURE — it only computes the argument vector and takes
//     an injectable `available` flag, so the wrapping logic is unit-testable with
//     no spawning.
//   * sandboxAvailable() probes for the `unshare` binary, swallowing all errors.
//   * runSandboxed() is the only function that actually executes anything, and it
//     does so with a CLEAN environment (no secrets/API keys) and a timeout, and
//     never throws — failures are reported as { ok: false, error }.
//
// Dependency-free (Node built-ins only).

import { execFileSync } from 'node:child_process';

/**
 * True if the `unshare` binary is present and runnable. Probes via
 * `unshare --version`. Never throws — returns false on any failure (missing
 * binary, permission error, etc.).
 */
export function sandboxAvailable(): boolean {
  try {
    execFileSync('unshare', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Cached one-time probe result, used as the default for buildSandboxArgv(). */
const CACHED_AVAILABLE: boolean = sandboxAvailable();

/** The command + argument vector to hand to a process spawner. */
export interface SandboxArgv {
  cmd: string;
  argv: string[];
}

/**
 * PURE. Compute the command vector for running `bin args...` either wrapped in a
 * network-isolated namespace (when sandboxing is available) or directly.
 *
 * When `available` is true, returns `unshare -rn <bin> <args...>`: `-r` maps the
 * current user to root inside a new user namespace (so unprivileged callers may
 * create the namespace), and `-n` creates a fresh network namespace with no
 * configured interfaces ⇒ no network access. Otherwise returns the command as-is.
 *
 * The `available` argument is injectable for unit testing; it defaults to a
 * cached probe of `sandboxAvailable()`.
 */
export function buildSandboxArgv(
  bin: string,
  args: string[],
  available: boolean = CACHED_AVAILABLE,
): SandboxArgv {
  if (available) {
    return { cmd: 'unshare', argv: ['-rn', bin, ...args] };
  }
  return { cmd: bin, argv: args };
}

/** Outcome of a sandboxed run. `ok` is false on any non-zero exit / failure. */
export interface SandboxResult {
  stdout: string;
  ok: boolean;
  error?: string;
}

/**
 * Run `bin args...` (network-isolated when possible) and capture stdout. Uses a
 * CLEAN environment — only PATH and PYTHONDONTWRITEBYTECODE are forwarded, never
 * secrets or API keys — and a default 5s timeout. Never throws: any failure
 * (non-zero exit, timeout, network/connection error inside the child, missing
 * binary) is reported as `{ ok: false, error }` with whatever stdout was
 * captured before the failure.
 */
export function runSandboxed(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): SandboxResult {
  const { timeoutMs = 5000, cwd } = opts;
  const { cmd, argv } = buildSandboxArgv(bin, args);

  // Deliberately minimal env: do NOT inherit process.env (which may carry API
  // keys / tokens) into untrusted code.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    PYTHONDONTWRITEBYTECODE: '1',
  };

  try {
    const out = execFileSync(cmd, argv, {
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: out, ok: true };
  } catch (err: unknown) {
    // execFileSync attaches captured stdout/stderr on the thrown error.
    const e = err as { stdout?: Buffer | string; message?: string };
    const stdout =
      typeof e.stdout === 'string'
        ? e.stdout
        : e.stdout
          ? e.stdout.toString('utf8')
          : '';
    return {
      stdout,
      ok: false,
      error: e.message ?? String(err),
    };
  }
}
