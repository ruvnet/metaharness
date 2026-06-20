// SPDX-License-Identifier: MIT
//
// Darwin Shield bounded agentic loop (ADR-155 Addendum C; security analog of
// ADR-153). The architectural claim under test: single-shot analysis is
// structurally blind to multi-step (cross-file) bugs, while a bounded, gated
// agentic loop that PAYS the navigation cost crosses that discovery wall — with
// zero false positives (counterexample-required), full determinism, a step bound,
// and zero unsafe output.

import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_TOOLS,
  defaultAgenticPolicy,
  discoveryCorpus,
  runAgenticLoop,
  runSingleShot,
} from '../../src/security/agentic.js';

const corpus = discoveryCorpus();
const deepVulns = corpus.repos.flatMap((r) => r.sites.filter((s) => s.isVulnerable && (s.discoveryDepth ?? 1) > 1));
const allVulns = corpus.repos.flatMap((r) => r.sites.filter((s) => s.isVulnerable));

describe('the discovery wall — single-shot is structurally blind to deep bugs', () => {
  it('the corpus carries multi-step (depth > 1) vulnerabilities and decoys', () => {
    expect(deepVulns.length).toBeGreaterThan(0);
    expect(corpus.repos[0].sites.some((s) => !s.isVulnerable)).toBe(true);
  });

  it('single-shot misses every depth > 1 vuln (TPR < 1)', () => {
    const ss = runSingleShot(corpus);
    expect(ss.tpr).toBeLessThan(1);
    expect(ss.truePositives).toBe(allVulns.length - deepVulns.length); // only shallow bugs
  });
});

describe('the agentic loop crosses the wall', () => {
  it('with enough budget it finds every vuln, zero false positives', () => {
    const r = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    expect(r.metrics.truePositives).toBe(allVulns.length);
    expect(r.metrics.falsePositives).toBe(0);
    expect(r.metrics.unsafeOutputs).toBe(0);
    expect(r.findings.every((f) => f.exploitCodeAllowed === false)).toBe(true);
  });

  it('beats single-shot strictly', () => {
    const ss = runSingleShot(corpus);
    const r = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    expect(r.metrics.truePositives).toBeGreaterThan(ss.truePositives);
  });

  it('more step budget discovers monotonically more (budget is the lever)', () => {
    const small = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 3 }).metrics.truePositives;
    const mid = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 10 }).metrics.truePositives;
    const big = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 }).metrics.truePositives;
    expect(mid).toBeGreaterThanOrEqual(small);
    expect(big).toBeGreaterThanOrEqual(mid);
    expect(big).toBeGreaterThan(small);
  });
});

describe('the loop is bounded and gated (safety envelope)', () => {
  it('never exceeds its step budget', () => {
    for (const maxSteps of [1, 3, 5, 8, 12, 40]) {
      const r = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps });
      expect(r.stepsUsed).toBeLessThanOrEqual(maxSteps + corpus.repos.length); // +list_sites per repo
    }
  });

  it('the tool surface excludes all mutating/escape tools', () => {
    for (const t of ['write', 'exec', 'shell', 'network']) expect(FORBIDDEN_TOOLS).toContain(t);
  });

  it('emits a non-empty audit trace ending in submit_finding for confirmed bugs', () => {
    const r = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    expect(r.trace.length).toBeGreaterThan(0);
    expect(r.trace.some((s) => s.tool === 'submit_finding')).toBe(true);
    expect(r.trace.some((s) => s.tool === 'run_fuzzer')).toBe(true);
  });
});

describe('determinism / replay', () => {
  it('same corpus + policy ⇒ byte-identical receipt hash and metrics', () => {
    const a = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    const b = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    expect(a.receiptHash).toBe(b.receiptHash);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('a different policy changes the receipt', () => {
    const a = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 40 });
    const b = runAgenticLoop(corpus, { ...defaultAgenticPolicy(), maxSteps: 5 });
    expect(a.receiptHash).not.toBe(b.receiptHash);
  });
});
