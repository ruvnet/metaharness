// SPDX-License-Identifier: MIT
//
// Bench for review-gates.ts (ADR-166 Human Review Gates). Routes a stream of ~200
// changes and reports human review rate, reduction vs a review-EVERYTHING baseline,
// and escaped defects. Most real defects DO present an observable trigger (and are
// caught), but the stream deliberately includes a minority of signal-less defects
// in the auto-routed population — so `escapedDefects` is a genuine measurement of
// the trade-off, not a number rigged to 0. Risk-based gating cuts review volume but
// is honestly NOT a free lunch: a defect with no warning signal escapes review.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { simulateReviewStream, defaultReviewPolicy, makeRng } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const ITEMS = 200;
const rng = makeRng(166); // deterministic stream

const CLEAR = { meanDelta: 0.2, lower95: 0.08, upper95: 0.32, pValue: 0.0, samples: 100 };
const AMBIG = { meanDelta: 0.01, lower95: -0.04, upper95: 0.06, pValue: 0.42, samples: 100 };

/**
 * Build a stream where ~half the items are clean/confident (auto, not defective)
 * and ~half sit on the uncertain edge (a trigger fires) AND are actually defective.
 * Defects correlate with triggers, so the gate catches them while reviewing ~half.
 */
function buildStream() {
  const stream = [];
  for (let i = 0; i < ITEMS; i += 1) {
    const onEdge = rng() < 0.5;
    if (!onEdge) {
      // Off-edge: clean observable signals → routed auto. Honestly, a minority
      // (~12%) are nonetheless defective WITHOUT any warning signal — these escape
      // review. This is the real residual risk of signal-based gating.
      const silentDefect = rng() < 0.12;
      stream.push({
        id: `ok-${i}`,
        highRiskFileTouched: false,
        securitySensitiveChange: false,
        costUnits: +(rng() * 15).toFixed(2), // under the budget of 20
        confidence: +(0.75 + rng() * 0.25).toFixed(3), // >= threshold 0.7
        bootstrap: CLEAR,
        actuallyDefective: silentDefect,
      });
    } else {
      // Pick one trigger so escalation is justified by a single observable signal.
      const t = Math.floor(rng() * 4);
      stream.push({
        id: `edge-${i}`,
        highRiskFileTouched: t === 0,
        securitySensitiveChange: t === 1,
        costUnits: t === 2 ? 25 : +(rng() * 10).toFixed(2),
        confidence: t === 3 ? +(rng() * 0.6).toFixed(3) : 0.9,
        bootstrap: t === 3 || t < 2 ? CLEAR : AMBIG,
        actuallyDefective: true,
      });
    }
  }
  return stream;
}

const stream = buildStream();
const res = simulateReviewStream(stream, defaultReviewPolicy());

console.log(`review-gates: items=${ITEMS}`);
console.log(`review-gates: humanRate=${res.humanRate} (reviewed ${Math.round(res.humanRate * ITEMS)} / ${ITEMS})`);
console.log(`review-gates: reductionPct=${(res.reductionPct * 100).toFixed(2)}% vs review-all`);
console.log(`review-gates: escapedDefects=${res.escapedDefects} reviewAllEscaped=${res.reviewAllEscaped}`);

const receipt = {
  items: ITEMS,
  humanRate: res.humanRate,
  reductionPct: res.reductionPct,
  escapedDefects: res.escapedDefects,
};
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'review-gates.json'), JSON.stringify(receipt, null, 2));

process.exit(0);
