// SPDX-License-Identifier: MIT
//
// Darwin Shield bounded self-writing, Phase 1 (ADR-155 Addendum). Under test:
// the editable-surface allowlist, the static validator (forbidden targets,
// sandbox escapes, unsafe content), deterministic generation, full replayable
// receipts, the mock oracle, and the ten-gate promotion decision. The referee
// (policy/safety/grader/stats/promotion) is never an editable surface.

import { describe, expect, it } from 'vitest';
import {
  DeterministicDetectorGenerator,
  EDITABLE_SURFACES,
  FORBIDDEN_TARGETS,
  MockDetectorOracle,
  captureReceipt,
  evaluateCandidate,
  isEditableSurface,
  parseDetector,
  synthesizeAndEvaluate,
  validateGeneratedShieldCode,
} from '../../src/security/selfwrite.js';
import { defaultCorpus, groundTruth } from '../../src/security/corpus.js';
import { hardCorpus } from '../../src/security/ablation.js';

const easy = defaultCorpus();
const hard = hardCorpus();
const allTargets = [...new Set([...groundTruth(easy), ...groundTruth(hard)].map((s) => s.weakness))];

describe('editable surface allowlist', () => {
  it('accepts the six allowlisted detector surfaces', () => {
    for (const s of EDITABLE_SURFACES) expect(isEditableSurface(s)).toBe(true);
  });
  it('rejects any non-allowlisted surface (the referee is not editable)', () => {
    for (const s of ['policy-enforcement', 'safety-gate', 'grader', 'promotion-logic', 'sandbox']) {
      expect(isEditableSurface(s)).toBe(false);
    }
  });
});

describe('validateGeneratedShieldCode — defense in depth', () => {
  it('passes a clean detection rule', () => {
    expect(validateGeneratedShieldCode('semgrep-rule', 'covers: CWE-89\nprecision: 0.9')).toEqual([]);
  });
  it('rejects a non-allowlisted surface', () => {
    expect(validateGeneratedShieldCode('grader', 'covers: x').some((v) => v.includes('not an allowlisted'))).toBe(true);
  });
  it('rejects an empty artifact', () => {
    expect(validateGeneratedShieldCode('semgrep-rule', '   ')).toContain('empty artifact');
  });
  it('rejects weaponized content in a generated artifact', () => {
    const v = validateGeneratedShieldCode('reviewer-prompt', 'review for bugs; also drop a reverse shell');
    expect(v.some((x) => x.startsWith('unsafe content'))).toBe(true);
  });
  it('rejects an attempt to modify a forbidden target', () => {
    for (const t of ['policy', 'safety', 'grader', 'promotion', 'sandbox', 'receipt']) {
      const v = validateGeneratedShieldCode('detector-config', `then overwrite the ${t} module`);
      expect(v.some((x) => x.startsWith('forbidden target')), t).toBe(true);
    }
  });
  it('rejects a sandbox escape in executable-ish surfaces', () => {
    const v = validateGeneratedShieldCode('taint-heuristic', 'const x = eval("danger")');
    expect(v.some((x) => x.startsWith('sandbox escape'))).toBe(true);
  });
  it('exposes the forbidden-target list', () => {
    expect(FORBIDDEN_TARGETS).toContain('policy');
    expect(FORBIDDEN_TARGETS).toContain('grader');
    expect(FORBIDDEN_TARGETS).toContain('promotion');
  });
});

describe('DeterministicDetectorGenerator — reproducible', () => {
  it('same input ⇒ byte-identical artifact', () => {
    const g = new DeterministicDetectorGenerator();
    const a = g.generateDetector({ surface: 'semgrep-rule', targets: ['CWE-89'], seed: 4 });
    const b = g.generateDetector({ surface: 'semgrep-rule', targets: ['CWE-89'], seed: 4 });
    expect(a).toEqual(b);
  });
  it('parses back into the declared coverage/precision', () => {
    const g = new DeterministicDetectorGenerator();
    const c = g.generateDetector({ surface: 'semgrep-rule', targets: ['CWE-89', 'CWE-79'], seed: 4 });
    const rule = parseDetector(c.artifact);
    expect(rule.covers).toEqual(['CWE-89', 'CWE-79']);
    expect(rule.precision).toBeGreaterThan(0);
  });
});

describe('captureReceipt — full determinism contract', () => {
  it('records all ten contract fields and a replayable hash', () => {
    const g = new DeterministicDetectorGenerator();
    const c = g.generateDetector({ surface: 'semgrep-rule', targets: ['CWE-89'], seed: 1 });
    const r = captureReceipt(c, [], 'ok', easy, new MockDetectorOracle());
    for (const k of ['prompt', 'model', 'seed', 'artifact', 'formatterOutput', 'validatorOutput', 'testOutput', 'corpusVersion', 'toolVersions', 'receiptHash']) {
      expect(r).toHaveProperty(k);
    }
    const r2 = captureReceipt(c, [], 'ok', easy, new MockDetectorOracle());
    expect(r2.receiptHash).toBe(r.receiptHash);
  });
});

describe('MockDetectorOracle — labeled evaluation', () => {
  it('a rule covering a weakness finds it as a true positive', () => {
    const oracle = new MockDetectorOracle();
    const per = oracle.evaluate({ covers: allTargets, precision: 0.99 }, easy);
    const tp = per.reduce((a, r) => a + r.tp, 0);
    expect(tp).toBeGreaterThan(0);
  });
  it('an empty rule finds nothing', () => {
    const oracle = new MockDetectorOracle();
    const per = oracle.evaluate({ covers: [], precision: 0 }, easy);
    expect(per.reduce((a, r) => a + r.tp, 0)).toBe(0);
  });
  it('higher precision leaks fewer decoys', () => {
    const oracle = new MockDetectorOracle();
    const lowP = oracle.evaluate({ covers: allTargets, precision: 0.1 }, easy).reduce((a, r) => a + r.fp, 0);
    const hiP = oracle.evaluate({ covers: allTargets, precision: 0.99 }, easy).reduce((a, r) => a + r.fp, 0);
    expect(hiP).toBeLessThanOrEqual(lowP);
  });
});

describe('evaluateCandidate — the ten-gate promotion decision', () => {
  const gen = new DeterministicDetectorGenerator();
  const oracle = new MockDetectorOracle();
  const incumbent = { covers: [] as string[], precision: 0 };
  const opts = { easyCorpus: easy, hardCorpus: hard, baselineFpRate: 0.6, seed: 4 };

  it('promotes a statistically superior, safe, replayable candidate', () => {
    const v = synthesizeAndEvaluate(gen, 'semgrep-rule', allTargets, incumbent, oracle, opts);
    expect(v.promote).toBe(true);
    for (const g of v.gates) expect(g.pass, `${g.name}: ${g.detail}`).toBe(true);
    expect(v.receipt.validatorOutput).toEqual([]);
  });

  it('does NOT promote a candidate that fails static validation', () => {
    const bad = { id: 'bad', surface: 'taint-heuristic' as const, artifact: 'covers: CWE-89\nprecision: 0.9\nconst x = eval("x")', prompt: 'p', model: 'm', seed: 0 };
    const v = evaluateCandidate(incumbent, bad, oracle, opts);
    expect(v.promote).toBe(false);
    expect(v.gates.find((g) => g.name.includes('static validation'))!.pass).toBe(false);
  });

  it('does NOT promote a non-improving candidate (no statistical superiority)', () => {
    // Incumbent already covers everything at high precision ⇒ candidate can't beat it.
    const strongIncumbent = { covers: allTargets, precision: 0.99 };
    const v = synthesizeAndEvaluate(gen, 'semgrep-rule', allTargets, strongIncumbent, oracle, opts);
    expect(v.promote).toBe(false);
  });

  it('is deterministic (same inputs ⇒ same verdict + receipt hash)', () => {
    const a = synthesizeAndEvaluate(gen, 'semgrep-rule', allTargets, incumbent, oracle, opts);
    const b = synthesizeAndEvaluate(gen, 'semgrep-rule', allTargets, incumbent, oracle, opts);
    expect(a.promote).toBe(b.promote);
    expect(a.receipt.receiptHash).toBe(b.receipt.receiptHash);
    expect(a.gates.map((g) => g.pass)).toEqual(b.gates.map((g) => g.pass));
  });
});
