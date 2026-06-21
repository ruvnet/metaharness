// SPDX-License-Identifier: MIT
//
// @metaharness/projects — verifiers.ts (language-agnostic proof VERIFIER registry).
//
// The discovery harness only reports execution-confirmed weaknesses: a proof is
// run against the target in an isolated subprocess, and an unhandled exception
// (or explicit failure) confirms the weakness. Historically that verifier was
// Python-only (`python3 -I -B`). This module generalizes the *pure* pieces of
// that pipeline — language detection, code extraction, and the per-language
// subprocess command + driver-source builders — so benches can verify proofs in
// BOTH Python and JavaScript from a single registry.
//
// This module performs NO process execution. It only produces the strings and
// argument vectors a caller (a bench) feeds to `execFileSync`/`spawnSync`. That
// keeps it deterministic and unit-testable without spawning anything. The drivers
// emit a single JSON line `{"triggered":bool,"evidenceClass":name}` matching the
// existing bench contract (see bench/zero-day-discovery.bench.mjs).
//
// Dependency-free (no Node built-ins, no third-party packages).

// ─────────────────────────────────────────────────────────────────────────────
// Languages.
// ─────────────────────────────────────────────────────────────────────────────

export type Language = 'python' | 'javascript';

// ─────────────────────────────────────────────────────────────────────────────
// Code extraction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip a single fenced code block (```lang … ```) if the input is one, returning
 * just the inner code. Otherwise return the trimmed input unchanged.
 *
 * Handles an optional language tag on the opening fence (```python, ```js, ```)
 * and tolerates a trailing newline before the closing fence.
 */
export function extractCode(raw: string): string {
  const trimmed = raw.trim();
  // ```<optional-lang>\n … \n``` — capture the inner body lazily.
  const fence = /^```[^\n`]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fence) return fence[1].trim();
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Language detection.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heuristically classify a snippet as Python or JavaScript.
 *
 * JavaScript signals: `function `, `=>`, `const `, `require(`, `console.`.
 * Python signals: `def `, `import `, a colon-terminated block header, `print(`.
 * Ties / no signal default to Python (the harness's historical default).
 */
export function detectLanguage(code: string): Language {
  const jsSignals =
    /\bfunction\s/.test(code) ||
    /=>/.test(code) ||
    /\bconst\s/.test(code) ||
    /\brequire\s*\(/.test(code) ||
    /\bconsole\./.test(code);

  const pySignals =
    /\bdef\s/.test(code) ||
    /\bimport\s/.test(code) ||
    /:\s*(?:\n|$)/m.test(code) || // colon-terminated block header
    /\bprint\s*\(/.test(code);

  // Python wins ties (default). Only classify as JS when JS signals are present
  // AND there are no Python signals — JS-specific tokens (=>, const, require,
  // console.) are far less ambiguous than a bare colon.
  if (jsSignals && !pySignals) return 'javascript';
  if (pySignals) return 'python';
  if (jsSignals) return 'javascript';
  return 'python';
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifier registry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A per-language recipe for executing a proof in an isolated subprocess.
 *
 * - `bin`     — the interpreter binary (`python3` / `node`).
 * - `args`    — argv (excluding bin) given the temp source `file` and the
 *               JSON-encoded positional arguments `argsJson`.
 * - `driver`  — the full source written to `file`: the candidate `code` plus a
 *               harness that calls `fn(...args)` and prints exactly one JSON line
 *               `{"triggered":bool,"evidenceClass":name}`. An unhandled
 *               error/exception ⇒ triggered:true with the error class name.
 */
export interface VerifierSpec {
  language: Language;
  bin: string;
  args: (file: string, argsJson: string) => string[];
  driver: (code: string, fn: string) => string;
}

const PYTHON: VerifierSpec = {
  language: 'python',
  bin: 'python3',
  args: (file, argsJson) => ['-I', '-B', file, argsJson],
  driver: (code, fn) => `${code}

import json, sys
ARGS = json.loads(sys.argv[1])
try:
    ${fn}(*ARGS)
    print(json.dumps({"triggered": False}))
except Exception as e:
    print(json.dumps({"triggered": True, "evidenceClass": type(e).__name__}))
`,
};

const JAVASCRIPT: VerifierSpec = {
  language: 'javascript',
  bin: 'node',
  args: (file, argsJson) => [file, argsJson],
  // The candidate code is wrapped so a top-level `function fn(){}` or
  // `const fn = …` declaration is reachable from globalThis. We discover the
  // function in this order: an own/global binding named `fn`, then any
  // same-named local declaration captured via `eval`. If none is callable we
  // report triggered:false (the proof could not be exercised).
  driver: (code, fn) => `${code}

const __args = JSON.parse(process.argv[2]);
function __resolve() {
  if (typeof globalThis[${JSON.stringify(fn)}] === 'function') return globalThis[${JSON.stringify(fn)}];
  try { const f = eval(${JSON.stringify(fn)}); if (typeof f === 'function') return f; } catch (_) {}
  return undefined;
}
try {
  const __fn = __resolve();
  if (typeof __fn !== 'function') {
    console.log(JSON.stringify({ triggered: false }));
  } else {
    __fn(...__args);
    console.log(JSON.stringify({ triggered: false }));
  }
} catch (e) {
  console.log(JSON.stringify({ triggered: true, evidenceClass: e && e.constructor ? e.constructor.name : 'Error' }));
}
`,
};

const REGISTRY: Record<Language, VerifierSpec> = {
  python: PYTHON,
  javascript: JAVASCRIPT,
};

/** Look up the verifier recipe for a language. */
export function verifierFor(language: Language): VerifierSpec {
  return REGISTRY[language];
}
