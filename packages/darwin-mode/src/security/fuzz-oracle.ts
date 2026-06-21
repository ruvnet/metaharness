// SPDX-License-Identifier: MIT
//
// Darwin Shield — REAL fuzz oracle (ADR-155 Addendum B, Phase 2). The second real
// tool: a property/totality fuzzer that EXECUTES real code with seeded random
// inputs and reports whether an invariant ("the target is total — never raises on
// bounded inputs") can be FALSIFIED. A falsification is a real counterexample →
// a finding; clean code holds → no false positive (the Code Augur trust property,
// now backed by real execution rather than a mock).
//
// Portable: needs only `python3` (no libFuzzer/clang/atheris build). Optional:
// absent python ⇒ `available:false` and callers skip, so the deterministic suite
// stays green. The driver reports only the exception CLASS, never the offending
// input — defensive by construction. Invoked via execFileSync, bare argv, no shell.

import { execFileSync } from 'node:child_process';
import { join, relative, isAbsolute } from 'node:path';
import type { ToolAvailability } from './semgrep-oracle.js';

function resolvePython(bin?: string): string {
  return bin || process.env.PYTHON_BIN || 'python3';
}

/** Probe whether python3 is runnable; never throws. */
export function pythonAvailability(bin?: string): ToolAvailability {
  const py = resolvePython(bin);
  try {
    const out = execFileSync(py, ['--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { available: true, version: out.trim(), binary: py };
  } catch (e) {
    return { available: false, version: '', binary: py, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The result of fuzzing a single target. */
export interface FuzzResult {
  available: boolean;
  falsified: boolean;
  /** Exception class of the counterexample (never the input). */
  exceptionClass: string | null;
  iterations: number;
  reason?: string;
}

/** A labeled fuzz corpus: a driver + targets with vulnerability labels. */
export interface FuzzCorpus {
  dir: string;
  /** Path to the seeded fuzz driver (relative to dir or absolute). */
  driver: string;
  labels: Array<{ file: string; vulnerable: boolean; weakness: string }>;
}

/** The scored result of fuzzing a whole labeled corpus. */
export interface FuzzCorpusResult {
  available: boolean;
  version: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  /** Per-target falsification outcomes (for the receipt). */
  outcomes: Array<{ file: string; vulnerable: boolean; falsified: boolean; exceptionClass: string | null }>;
  reason?: string;
}

const round6 = (v: number): number => +(Math.round(v * 1e6) / 1e6).toFixed(6);

/** The real property/totality fuzzer (Phase 2). Optional — skips when absent. */
export class RealFuzzOracle {
  readonly name = 'python-property-fuzzer';
  private readonly python: string;
  private readonly timeoutMs: number;

  constructor(opts: { python?: string; timeoutMs?: number } = {}) {
    this.python = resolvePython(opts.python);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  availability(): ToolAvailability {
    return pythonAvailability(this.python);
  }

  isAvailable(): boolean {
    return this.availability().available;
  }

  /** Fuzz one target file with the driver; deterministic for a fixed seed. */
  fuzz(driverPath: string, targetPath: string, opts: { seed?: number; iterations?: number } = {}): FuzzResult {
    const avail = this.availability();
    if (!avail.available) return { available: false, falsified: false, exceptionClass: null, iterations: 0, reason: avail.reason };
    return this.fuzzWithBinary(driverPath, targetPath, opts);
  }

  /**
   * Run the driver against a single target assuming python is already known
   * available (no re-probe). On a hard failure (python crash, non-zero exit,
   * unparseable output) this degrades to a non-falsification result with a
   * `reason` rather than throwing — a present-but-crashing python must not
   * propagate out of `evaluate()`.
   */
  private fuzzWithBinary(driverPath: string, targetPath: string, opts: { seed?: number; iterations?: number } = {}): FuzzResult {
    const seed = opts.seed ?? 0;
    const iterations = opts.iterations ?? 5000;
    try {
      const out = execFileSync(this.python, [driverPath, targetPath, String(seed), String(iterations)], {
        encoding: 'utf8',
        timeout: this.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      const parsed = JSON.parse(out.trim()) as { falsified: boolean; exceptionClass: string | null; iterations: number };
      return { available: true, falsified: parsed.falsified, exceptionClass: parsed.exceptionClass, iterations: parsed.iterations };
    } catch (e) {
      return { available: true, falsified: false, exceptionClass: null, iterations: 0, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Fuzz every target in a labeled corpus and score the totality invariant. A
   * vulnerable target that gets falsified is a true positive; a clean target that
   * gets falsified is a false positive; a vulnerable target that holds is a false
   * negative. Gracefully returns `available:false` when python is absent.
   */
  evaluate(corpus: FuzzCorpus, opts: { seed?: number; iterations?: number } = {}): FuzzCorpusResult {
    const avail = this.availability();
    if (!avail.available) {
      return { available: false, version: '', truePositives: 0, falsePositives: 0, falseNegatives: 0, precision: 0, recall: 0, outcomes: [], reason: avail.reason };
    }
    const driverPath = isAbsolute(corpus.driver) ? corpus.driver : join(corpus.dir, corpus.driver);
    const outcomes: FuzzCorpusResult['outcomes'] = [];
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const label of corpus.labels) {
      const targetPath = isAbsolute(label.file) ? label.file : join(corpus.dir, label.file);
      // python availability was probed once above; skip the per-target re-probe.
      const r = this.fuzzWithBinary(driverPath, targetPath, opts);
      outcomes.push({ file: label.file, vulnerable: label.vulnerable, falsified: r.falsified, exceptionClass: r.exceptionClass });
      if (label.vulnerable) {
        if (r.falsified) tp += 1;
        else fn += 1;
      } else if (r.falsified) {
        fp += 1;
      }
    }
    outcomes.sort((a, b) => a.file.localeCompare(b.file));
    const precision = tp + fp > 0 ? round6(tp / (tp + fp)) : 1;
    const recall = tp + fn > 0 ? round6(tp / (tp + fn)) : 1;
    return { available: true, version: avail.version, truePositives: tp, falsePositives: fp, falseNegatives: fn, precision, recall, outcomes };
  }
}

/** Convenience: the path a `FuzzCorpus` finding refers to, relative to the corpus. */
export function relForCorpus(corpus: FuzzCorpus, abs: string): string {
  return isAbsolute(abs) ? relative(corpus.dir, abs) : abs;
}
