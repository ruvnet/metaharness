// SPDX-License-Identifier: MIT
//
// Tests for review-gates.ts (ADR-166 Human Review Gates): each trigger routes to a
// human independently, the ambiguous-benchmark trigger, a clean ctx routes auto, the
// simulation halves human review while catching every real defect on the uncertain
// edge, and routing is independent of the (ground-truth) actuallyDefective flag.

import { describe, it, expect } from 'vitest';
import {
  routeReview,
  defaultReviewPolicy,
  simulateReviewStream,
  type ReviewContext,
} from '../src/review-gates.js';
import type { BootstrapResult } from '../src/core.js';

/** An unambiguous, clearly-positive promotion result (CI entirely above zero). */
const CLEAR: BootstrapResult = { meanDelta: 0.2, lower95: 0.1, upper95: 0.3, pValue: 0.0, samples: 100 };
/** An ambiguous result: the 95% CI straddles zero. */
const AMBIG: BootstrapResult = { meanDelta: 0.01, lower95: -0.05, upper95: 0.07, pValue: 0.4, samples: 100 };

/** A clean, confident, cheap, low-risk, unambiguous change → should route 'auto'. */
function clean(over: Partial<ReviewContext> = {}): ReviewContext {
  return {
    id: 'c',
    highRiskFileTouched: false,
    securitySensitiveChange: false,
    costUnits: 5,
    confidence: 0.9,
    bootstrap: CLEAR,
    actuallyDefective: false,
    ...over,
  };
}

describe('review-gates individual triggers', () => {
  it('a clean, confident, unambiguous, cheap, low-risk ctx routes auto', () => {
    const d = routeReview(clean());
    expect(d.route).toBe('auto');
    expect(d.reasons).toEqual([]);
  });

  it('high-risk file routes human', () => {
    const d = routeReview(clean({ highRiskFileTouched: true }));
    expect(d.route).toBe('human');
    expect(d.reasons).toContain('high-risk-file');
  });

  it('security-sensitive change routes human', () => {
    const d = routeReview(clean({ securitySensitiveChange: true }));
    expect(d.route).toBe('human');
    expect(d.reasons).toContain('security-sensitive');
  });

  it('over-budget cost routes human', () => {
    const d = routeReview(clean({ costUnits: 21 })); // default budget 20
    expect(d.route).toBe('human');
    expect(d.reasons).toContain('over-budget');
  });

  it('low confidence routes human', () => {
    const d = routeReview(clean({ confidence: 0.69 })); // default threshold 0.7
    expect(d.route).toBe('human');
    expect(d.reasons).toContain('low-confidence');
  });
});

describe('review-gates ambiguous benchmark', () => {
  it('ambiguous bootstrap (lower95 < 0 < upper95) routes human', () => {
    const d = routeReview(clean({ bootstrap: AMBIG }));
    expect(d.route).toBe('human');
    expect(d.reasons).toContain('ambiguous-benchmark');
  });

  it('unambiguous low-risk change routes auto', () => {
    const d = routeReview(clean({ bootstrap: CLEAR }));
    expect(d.route).toBe('auto');
  });
});

describe('review-gates routing ignores ground truth', () => {
  it('flipping actuallyDefective does not change the route', () => {
    const ctxs: ReviewContext[] = [
      clean(),
      clean({ highRiskFileTouched: true }),
      clean({ bootstrap: AMBIG }),
      clean({ confidence: 0.5 }),
    ];
    for (const c of ctxs) {
      const a = routeReview({ ...c, actuallyDefective: false });
      const b = routeReview({ ...c, actuallyDefective: true });
      expect(a.route).toBe(b.route);
      expect(a.reasons).toEqual(b.reasons);
    }
  });
});

describe('review-gates stream simulation', () => {
  it('halves human review while catching every real defect on the uncertain edge', () => {
    const policy = defaultReviewPolicy();
    // Half the stream is clean (auto, not defective); half is on the uncertain edge
    // (a trigger fires AND it is actually defective). Defects correlate with triggers,
    // so the gate catches them all while reviewing only the edge.
    const stream: ReviewContext[] = [];
    for (let i = 0; i < 100; i += 1) {
      if (i % 2 === 0) {
        stream.push(clean({ id: `ok-${i}` }));
      } else {
        // Rotate through the trigger types so it isn't a single-trigger artifact.
        const which = i % 8;
        const edge: Partial<ReviewContext> = { id: `edge-${i}`, actuallyDefective: true };
        if (which === 1) edge.highRiskFileTouched = true;
        else if (which === 3) edge.securitySensitiveChange = true;
        else if (which === 5) edge.confidence = 0.4;
        else edge.bootstrap = AMBIG;
        stream.push(clean(edge));
      }
    }

    const res = simulateReviewStream(stream, policy);
    expect(res.humanRate).toBeLessThanOrEqual(0.5);
    expect(res.escapedDefects).toBe(0);
    expect(res.reviewAllEscaped).toBe(0);
    expect(res.escapedDefects).toBeLessThanOrEqual(res.reviewAllEscaped);
    expect(res.reductionPct).toBeCloseTo(1 - res.humanRate, 6);
  });
});
