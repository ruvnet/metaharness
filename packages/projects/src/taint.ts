// SPDX-License-Identifier: MIT
//
// @metaharness/projects — lightweight, deterministic SOURCE→SINK taint heuristic.
// Raises discovery finding quality by distinguishing a dangerous sink that is
// reachable from UNTRUSTED (attacker-controllable) input from a sink operating on
// trusted/literal data. The analysis is coarse and intraprocedural: it splits the
// Python source into functions, locates dangerous sinks, and asks whether ANY
// untrusted source token co-occurs in the same function body. This is a heuristic,
// not a sound dataflow analysis — but it is dependency-free, fully deterministic,
// and cheap enough to run as a pre-filter before expensive LLM/execution lanes.

/** Confidence/danger band for a taint finding. */
export type Severity = 'high' | 'medium' | 'low';

/** A single sink occurrence and its reachability verdict. */
export interface TaintFinding {
  /** Enclosing function name (or '<module>' for top-level / unparented sinks). */
  fn: string;
  /** 1-based line number of the sink occurrence. */
  line: number;
  /** The matched sink label (e.g. 'eval(', 'os.system('). */
  sink: string;
  /** First untrusted source token found in the same function, or null. */
  source: string | null;
  /** True when an untrusted source co-occurs in the sink's function body. */
  reachable: boolean;
  /** Severity band derived from sink class + reachability. */
  severity: Severity;
  /** Associated CWE identifier. */
  cwe: string;
}

/**
 * Tokens indicating attacker-controllable input in Python. A coarse substring
 * match — presence anywhere in a function body marks that body as tainted.
 */
export const UNTRUSTED_SOURCES: string[] = [
  'request.args',
  'request.form',
  'request.data',
  'request.json',
  'request.values',
  'request.get_json',
  'input(',
  'sys.argv',
  'os.environ',
  'os.getenv',
  'flask.request',
  'argv',
];

/** Dangerous sink patterns with their label and CWE. Order is deterministic. */
export const SINKS: { pattern: RegExp; sink: string; cwe: string }[] = [
  // Arbitrary code execution.
  { pattern: /\beval\s*\(/, sink: 'eval(', cwe: 'CWE-95' },
  { pattern: /\bexec\s*\(/, sink: 'exec(', cwe: 'CWE-95' },
  // OS command injection.
  { pattern: /\bos\.system\s*\(/, sink: 'os.system(', cwe: 'CWE-78' },
  // subprocess.* invoked with shell=True (command injection surface).
  {
    pattern: /\bsubprocess\.(?:Popen|call|run|check_call|check_output)\s*\([^)]*shell\s*=\s*True/,
    sink: 'subprocess(shell=True)',
    cwe: 'CWE-78',
  },
  // Generic subprocess.* with shell=True even when fully namespaced differently.
  { pattern: /\bshell\s*=\s*True/, sink: 'subprocess(shell=True)', cwe: 'CWE-78' },
  // Insecure deserialization.
  { pattern: /\bpickle\.loads\s*\(/, sink: 'pickle.loads(', cwe: 'CWE-502' },
  // Unsafe YAML load (NOT safe_load) — weaker than RCE sinks ⇒ medium class.
  { pattern: /\byaml\.load\s*\(/, sink: 'yaml.load(', cwe: 'CWE-502' },
  // Weak hash — medium class regardless of taint.
  { pattern: /\bhashlib\.md5\s*\(/, sink: 'hashlib.md5(', cwe: 'CWE-327' },
  { pattern: /\bmd5\s*\(/, sink: 'md5(', cwe: 'CWE-327' },
];

// Sink labels that, when reachable from untrusted input, warrant 'high'.
const HIGH_WHEN_REACHABLE = new Set<string>([
  'eval(',
  'exec(',
  'os.system(',
  'subprocess(shell=True)',
  'pickle.loads(',
]);

// Sink labels that are always at most 'medium' (no RCE/command/deser severity).
const ALWAYS_MEDIUM = new Set<string>(['yaml.load(', 'hashlib.md5(', 'md5(']);

/** A parsed Python function span (or the synthetic module-level span). */
interface FnSpan {
  name: string;
  /** 1-based line where the body region begins (the def line, or 1 for module). */
  startLine: number;
  /** 1-based line one past the end of the body (exclusive). */
  endLine: number;
  /** Indentation column of the `def` keyword (-1 for module). */
  indent: number;
}

const DEF_RE = /^(\s*)def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/**
 * Split source into function spans. A function body extends from its `def` line
 * until the next line at the SAME-OR-SHALLOWER indentation that is not blank /
 * pure comment (the standard Python block rule, applied coarsely). Lines not
 * inside any function are attributed to the synthetic '<module>' span.
 */
function parseFunctions(lines: string[]): FnSpan[] {
  const spans: FnSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = DEF_RE.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
      const lead = raw.length - raw.trimStart().length;
      if (lead <= indent) {
        end = j;
        break;
      }
    }
    spans.push({ name, startLine: i + 1, endLine: end + 1, indent });
  }
  return spans;
}

/** Find the innermost (deepest-indented) function span containing a 1-based line. */
function enclosingFn(spans: FnSpan[], line: number): FnSpan | null {
  let best: FnSpan | null = null;
  for (const s of spans) {
    // Body region is (startLine, endLine); the def line itself counts as part of it.
    if (line >= s.startLine && line < s.endLine) {
      if (best === null || s.indent > best.indent) best = s;
    }
  }
  return best;
}

/** First untrusted source token present in a body slice, or null. Deterministic. */
function firstSourceIn(body: string): string | null {
  for (const tok of UNTRUSTED_SOURCES) {
    if (body.includes(tok)) return tok;
  }
  return null;
}

function severityFor(sink: string, reachable: boolean): Severity {
  if (ALWAYS_MEDIUM.has(sink)) return 'medium';
  if (reachable && HIGH_WHEN_REACHABLE.has(sink)) return 'high';
  // Dangerous sink present but no untrusted source in scope ⇒ likely trusted/literal.
  return 'low';
}

/**
 * Scan Python source for dangerous sinks and classify each by whether an
 * untrusted source co-occurs in the same enclosing function. Returns findings in
 * deterministic order (by line, then by SINKS declaration order).
 */
export function taintScan(source: string): TaintFinding[] {
  const lines = source.split('\n');
  const spans = parseFunctions(lines);
  const findings: TaintFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    const lineNo = i + 1;
    for (const def of SINKS) {
      if (!def.pattern.test(lineText)) continue;
      const span = enclosingFn(spans, lineNo);
      const fnName = span ? span.name : '<module>';
      let body: string;
      if (span) {
        body = lines.slice(span.startLine - 1, span.endLine - 1).join('\n');
      } else {
        // Module scope: only lines NOT inside any function span.
        const inFn = new Set<number>();
        for (const s of spans) {
          for (let k = s.startLine; k < s.endLine; k++) inFn.add(k);
        }
        body = lines.filter((_, idx) => !inFn.has(idx + 1)).join('\n');
      }
      const src = firstSourceIn(body);
      const reachable = src !== null;
      findings.push({
        fn: fnName,
        line: lineNo,
        sink: def.sink,
        source: src,
        reachable,
        severity: severityFor(def.sink, reachable),
        cwe: def.cwe,
      });
    }
  }

  return findings;
}

/**
 * Cross-corroborate taint findings with an independent static tool. When a taint
 * finding's enclosing function is also flagged by the static tool (its name is in
 * `staticFns`), bump the finding to 'high' — two independent signals agreeing is a
 * strong reachability indicator. Returns a new array; inputs are not mutated.
 */
export function combineWithStatic(taint: TaintFinding[], staticFns: string[]): TaintFinding[] {
  const confirmed = new Set(staticFns);
  return taint.map((f) =>
    confirmed.has(f.fn) ? { ...f, severity: 'high' as Severity } : { ...f },
  );
}
