// SPDX-License-Identifier: MIT
// DRACO grounding gate (ADR-038 follow-up) — the honest JUDGE→CONSOLIDATE citation
// stage. These tests prove the no-hidden-claims invariant and the coverage↔
// grounding trade-off OFFLINE (injected URL checker) — no API run required.

import { describe, it, expect } from 'vitest';
import { applyGroundingGate, scoreWithGate, groundingGain, splitSentences } from '../src/draco/grounding-gate.js';
import type { UrlChecker, Rubric } from '../src/draco/scorer.js';

// Deterministic offline checker: URLs containing "/live" resolve, all else dead.
const checker: UrlChecker = async (u) => (/\/live/.test(u) ? 'ok' : 'dead');

describe('splitSentences', () => {
  it('splits on sentence terminators and trims', () => {
    expect(splitSentences('A claim. Another one! A third?')).toEqual(['A claim.', 'Another one!', 'A third?']);
  });
});

describe('honesty invariant — never keep an unsupported claim', () => {
  it('a sentence whose ONLY citation is dead is dropped entirely (claim removed, not just the link)', async () => {
    const answer = 'Solar grew fast https://example.com/dead-source supporting the claim.';
    const r = await applyGroundingGate(answer, checker);
    expect(r.claimsDropped).toBe(1);
    expect(r.deadUrlsStripped).toBe(0);
    // the dead URL must NOT survive while its claim is kept
    expect(r.gatedAnswer).not.toContain('dead-source');
    expect(r.gatedAnswer).not.toContain('Solar grew fast');
  });

  it('NEVER strips a dead link while keeping its claim text (no grounding gaming)', async () => {
    const answer = 'Claim X https://a.com/dead matters a lot.';
    const r = await applyGroundingGate(answer, checker);
    // either the whole claim is gone, or (if it had a live cite) the claim stays —
    // but a dead URL can never coexist with a retained claim that had no live cite.
    if (r.gatedAnswer.includes('Claim X')) {
      expect(r.gatedAnswer).not.toContain('/dead');
      // and only because a live URL supported it — not the case here, so:
    }
    expect(r.gatedAnswer.includes('Claim X')).toBe(false);
  });
});

describe('redundant dead+live citation → pure grounding win, coverage preserved', () => {
  const rubric: Rubric = { must_contain: ['renewable', 'capacity'] };
  const prompt = 'Summarise renewable energy growth.';
  // Both rubric terms present; the claim is cited by a LIVE and a DEAD url.
  const answer =
    'Global renewable capacity surged https://src.com/live-iea https://src.com/dead-mirror last year.';

  it('strips the dead token, keeps the claim + both rubric terms', async () => {
    const r = await applyGroundingGate(answer, checker);
    expect(r.deadUrlsStripped).toBe(1);
    expect(r.claimsDropped).toBe(0);
    expect(r.liveUrlsKept).toBe(1);
    expect(r.gatedAnswer).toContain('renewable');
    expect(r.gatedAnswer).toContain('capacity');
    expect(r.gatedAnswer).toContain('live-iea');
    expect(r.gatedAnswer).not.toContain('dead-mirror');
  });

  it('grounding rises to 1.0 with NO coverage loss (the honest harness lever)', async () => {
    const g = await scoreWithGate(answer, rubric, prompt, checker);
    // before: 2 cited URLs, 1 live → grounding 0.5; after: 1 live → 1.0
    expect(g.before.grounding).toBeCloseTo(0.5, 5);
    expect(g.after.grounding).toBeCloseTo(1, 5);
    expect(g.after.coverage).toBeCloseTo(g.before.coverage, 5); // coverage preserved
    expect(g.delta).toBeGreaterThan(0); // net composite WIN
  });
});

describe('dead-only citation on a covered claim → honest coverage cost', () => {
  const rubric: Rubric = { must_contain: ['hydrogen'] };
  const prompt = 'Discuss hydrogen.';
  // The ONLY sentence carrying the rubric term "hydrogen" is cited by a dead URL only.
  const answer = 'Green hydrogen scaled in 2025 https://src.com/dead-only here.';

  it('drops the unsupported claim, losing its rubric term (coverage falls — quantified, not hidden)', async () => {
    const g = await scoreWithGate(answer, rubric, prompt, checker);
    expect(g.report.claimsDropped).toBe(1);
    expect(g.before.coverage).toBeCloseTo(1, 5); // "hydrogen" present before
    expect(g.after.coverage).toBeCloseTo(0, 5); // dropped with the claim
    // grounding before: 1 dead URL → 0; after: 0 URLs → 0 (scorer rule). Honest:
    // the gate did NOT manufacture a grounding win by hiding the claim.
    expect(g.after.grounding).toBe(0);
  });
});

describe('prose without citations is preserved verbatim', () => {
  it('keeps sentences that have no URLs', async () => {
    const answer = 'This is analysis with no link. Another prose sentence.';
    const r = await applyGroundingGate(answer, checker);
    expect(r.claimsDropped).toBe(0);
    expect(r.gatedAnswer).toContain('analysis with no link');
    expect(r.gatedAnswer).toContain('Another prose sentence');
  });
});

describe('groundingGain — closed-form break-even predictor', () => {
  it('redundant dead citations give a positive grounding gain', () => {
    // 4 live, 6 dead-but-redundant, 0 dead-only → before 4/10=0.4, after 1.0
    expect(groundingGain(4, 6, 0)).toBeCloseTo(0.6, 5);
  });
  it('all-live already → zero gain', () => {
    expect(groundingGain(5, 0, 0)).toBeCloseTo(0, 5);
  });
  it('no citations at all → zero gain (no division by zero)', () => {
    expect(groundingGain(0, 0, 0)).toBe(0);
  });
});
