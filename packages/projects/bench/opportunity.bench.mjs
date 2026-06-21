// SPDX-License-Identifier: MIT
//
// Bench for opportunity.ts (ADR-165 Darwin Opportunity Scanner). Ranks a synthetic
// portfolio of ~25 task classes and prints the top 10 with the four fields a human
// needs to greenlight automation: estimated monthly cost, expected saving,
// verification method, and risk score — plus the total expected monthly saving.
//
// The measured optimization: a NAIVE "automate the highest model-spend first"
// strategy ignores verification, so its realized saving is eroded by weak oracles.
// ROI ranking (saving discounted by risk) recovers more realized saving from the
// same review/evolution budget. We report the realized-saving uplift of ROI over the
// spend-only ordering when both pick their top-K candidates.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rankOpportunities, scoreOpportunity, makeRng } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORTFOLIO = 25;
const TOP_K = 10;

const rng = makeRng(165); // deterministic synthetic portfolio

/** Build a deterministic portfolio of task classes from a seeded RNG. */
function buildPortfolio() {
  const items = [];
  for (let i = 0; i < PORTFOLIO; i += 1) {
    items.push({
      taskClass: `task-${String(i).padStart(2, '0')}`,
      monthlyVolume: Math.round(50 + rng() * 5000),
      modelSpendUnitsPerTask: +(0.2 + rng() * 4).toFixed(3),
      verificationStrength: +rng().toFixed(3),
      failureRisk: +rng().toFixed(3),
      modelComplexity: +rng().toFixed(3),
      testability: +rng().toFixed(3),
    });
  }
  return items;
}

const portfolio = buildPortfolio();

// ROI ranking (this module).
const ranked = rankOpportunities(portfolio);
const top10 = ranked.slice(0, TOP_K).map((s) => ({
  taskClass: s.taskClass,
  rank: s.rank,
  estimatedMonthlyCost: s.estimatedMonthlyCost,
  expectedSaving: s.expectedSaving,
  verificationMethod: s.verificationMethod,
  riskScore: s.riskScore,
  roi: s.roi,
}));
const totalExpectedSaving = +top10.reduce((acc, s) => acc + s.expectedSaving, 0).toFixed(6);

// NAIVE baseline: pick the TOP_K by raw model spend, ignoring verification/risk.
// Realized saving credits each pick its (risk/verification-aware) expectedSaving —
// i.e. what it would ACTUALLY save once you account for the weak-oracle leakage.
const scored = portfolio.map((p) => scoreOpportunity(p));
const naivePicks = [...scored]
  .sort((a, b) => b.estimatedMonthlyCost - a.estimatedMonthlyCost)
  .slice(0, TOP_K);
const naiveRealized = +naivePicks.reduce((acc, s) => acc + s.expectedSaving, 0).toFixed(6);
const roiRealized = totalExpectedSaving;
const upliftPct = naiveRealized > 0 ? +(((roiRealized - naiveRealized) / naiveRealized) * 100).toFixed(2) : 0;

console.log(`opportunity: portfolio=${PORTFOLIO} topK=${TOP_K}`);
console.log('opportunity: top 10 by ROI ->');
for (const s of top10) {
  console.log(
    `  #${s.rank} ${s.taskClass} cost=${s.estimatedMonthlyCost} saving=${s.expectedSaving} ` +
      `verify=${s.verificationMethod} risk=${s.riskScore} roi=${s.roi}`,
  );
}
console.log(`opportunity: totalExpectedSaving(top10)=${totalExpectedSaving}`);
console.log(`opportunity: realized saving roi=${roiRealized} naive(spend-only)=${naiveRealized} uplift=${upliftPct}%`);

const receipt = { portfolio: PORTFOLIO, top10, totalExpectedSaving, naiveRealized, roiRealized, upliftPct };
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'opportunity.json'), JSON.stringify(receipt, null, 2));

process.exit(0);
