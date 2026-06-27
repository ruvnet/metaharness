// SPDX-License-Identifier: MIT
//
// Attack execution sandbox + target drivers.
//
// Drivers implement TargetDriver. Two are provided:
//   - MockTargetDriver: an in-proc, deterministic target for offline tests.
//   - HttpTargetDriver: posts to a loopback/test http endpoint (validated by
//     the safety module; network is hard-off so only local targets pass).
//
// PatchedTargetDriver wraps any driver with a set of declarative guard rules
// (from blue actors). The guards are applied BY THE HARNESS — no model-authored
// code is ever executed.

import type { Patch, TargetConfig, TargetDriver, TargetTelemetry } from '../types.js';
import { assertNoLiveCredential } from '../config/safety.js';

/** In-proc deterministic target. The fn receives the (guarded) input. */
export class MockTargetDriver implements TargetDriver {
  private readonly fn: (input: string) => { output: string; toolCalls?: string[] };
  constructor(fn: (input: string) => { output: string; toolCalls?: string[] }) {
    this.fn = fn;
  }
  async invoke(input: string): Promise<TargetTelemetry> {
    const t0 = Date.now();
    const r = this.fn(input);
    return { output: r.output, toolCalls: r.toolCalls ?? [], latencyMs: Math.max(1, Date.now() - t0) };
  }
}

function getByPath(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** Drives a loopback/test http endpoint. Safety-validated target only. */
export class HttpTargetDriver implements TargetDriver {
  constructor(private readonly cfg: TargetConfig) {}
  async invoke(input: string): Promise<TargetTelemetry> {
    if (this.cfg.kind !== 'http' || !this.cfg.url) {
      throw new Error('HttpTargetDriver requires an http target with a url.');
    }
    // Safety: never forward a payload containing a real-credential-shaped token.
    assertNoLiveCredential(input);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(this.cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.cfg.headers ?? {}) },
        body: JSON.stringify({ input }),
      });
    } catch (e) {
      return { output: `(target unreachable: ${(e as Error).message})`, toolCalls: [], latencyMs: Date.now() - t0 };
    }
    const latencyMs = Date.now() - t0;
    let output = '';
    let toolCalls: string[] = [];
    try {
      const j: any = await res.json();
      output = this.cfg.responsePath ? String(getByPath(j, this.cfg.responsePath) ?? '') : JSON.stringify(j);
      if (Array.isArray(j?.toolCalls)) toolCalls = j.toolCalls.map(String);
    } catch {
      output = await res.text().catch(() => '');
    }
    return { output, toolCalls, latencyMs, status: res.status };
  }
}

/**
 * Wrap a driver so blue-team guard rules are enforced. If any guard blocks the
 * request, the target is never invoked and a safe refusal is returned — this is
 * exactly the behavior a real defense would produce.
 */
export class PatchedTargetDriver implements TargetDriver {
  constructor(
    private readonly inner: TargetDriver,
    private readonly patches: Patch[],
  ) {}

  async invoke(input: string): Promise<TargetTelemetry> {
    // Input-side guards.
    const prefixes: string[] = [];
    const allowedTools = new Set<string>();
    let hasToolScope = false;
    let maxIterations = Infinity;

    for (const p of this.patches) {
      const r = p.rule;
      if (r.hardeningPrefix) prefixes.push(r.hardeningPrefix);
      if (r.allowedTools) {
        hasToolScope = true;
        r.allowedTools.forEach((t) => allowedTools.add(t.toLowerCase()));
      }
      if (typeof r.maxIterations === 'number') maxIterations = Math.min(maxIterations, r.maxIterations);
      if (r.blockSubstrings) {
        const lower = input.toLowerCase();
        if (r.blockSubstrings.some((s) => lower.includes(s.toLowerCase()))) {
          return {
            output: `Request blocked by policy guard (${p.family}). I cannot comply with that part of the request.`,
            toolCalls: [],
            latencyMs: 1,
          };
        }
      }
    }

    const hardenedInput = prefixes.length ? `${prefixes.join(' ')}\n\n${input}` : input;
    const tel = await this.inner.invoke(hardenedInput);

    // Output-side guards: strip out-of-scope tool calls; enforce iteration cap.
    let toolCalls = tel.toolCalls;
    if (hasToolScope) {
      toolCalls = toolCalls.filter((t) => allowedTools.has(t.toLowerCase()));
    }
    if (Number.isFinite(maxIterations)) {
      toolCalls = toolCalls.slice(0, maxIterations);
    }
    return { ...tel, toolCalls };
  }
}
