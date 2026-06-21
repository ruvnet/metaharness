// SPDX-License-Identifier: MIT
//
// Darwin policy evolution for the discovery harness (deterministic synthetic
// benchmark — NO LLM calls, safe for run-all). Evolves the discovery POLICY
// (frontier model, escalation cap, skipStaticallyCovered, prompt variant) to
// maximize VERIFIED findings per cost, using a synthetic-but-plausible evaluator.
// The real evaluator wires bench/zero-day-discovery.bench.mjs (budget-gated); this
// proves the Darwin search converges to the cheap-but-effective policy.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolveDiscoveryPolicy, defaultVocabulary, defaultDiscoveryPolicy } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Frontier price proxy (milli-USD/escalation) by model family.
const frontierCost = (m) => (/glm-5\.2/.test(m) ? 4.1 : /glm-5/.test(m) ? 1.9 : /glm-4\.7/.test(m) ? 1.75 : 1.0);

// Synthetic evaluator: more escalations find more (capped); skipStaticallyCovered
// removes ~30% of wasted frontier spend without losing verified findings; prompt
// variant 1 is slightly more effective. Deterministic.
const evaluator = (p) => {
  const verified = Math.min(p.maxEscalations, 6) + (p.promptVariant === 1 ? 1 : 0);
  const costUnits = p.maxEscalations * frontierCost(p.frontierModel) * (p.skipStaticallyCovered ? 0.7 : 1.0);
  return { verified, costUnits };
};

const baseline = { ...defaultDiscoveryPolicy(), frontierModel: 'z-ai/glm-5.2', maxEscalations: 8, skipStaticallyCovered: false, promptVariant: 0 };
const r = evolveDiscoveryPolicy({ evaluator, vocabulary: defaultVocabulary(), generations: 12, population: 10, seed: 7, baseline });

const receipt = {
  experiment: 'Darwin policy evolution for discovery (synthetic, deterministic)',
  baseline: { policy: r.baseline, fitness: r.baselineFitness },
  champion: { policy: r.champion, fitness: r.championFitness },
  learningCurve: r.history,
  generations: r.generations,
  evaluations: r.evaluations,
  evaluatorCalls: r.evaluatorCalls,
  improvedOverBaseline: r.improvedOverBaseline,
  receiptHash: r.receiptHash,
  note: 'verified-per-cost fitness; evaluator is a synthetic model of the real discovery tradeoff. Real evaluator wires zero-day-discovery.bench.mjs (budget-gated).',
};
writeFileSync(join(here, 'results', 'discovery-evolve.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Darwin discovery-policy evolution (synthetic): baseline fitness ${r.baselineFitness} → champion ${r.championFitness}\n`);
process.stdout.write(`  champion: ${r.champion.frontierModel}, maxEscalations=${r.champion.maxEscalations}, skipStaticallyCovered=${r.champion.skipStaticallyCovered}, promptVariant=${r.champion.promptVariant}\n`);
process.stdout.write(`  learning curve: ${JSON.stringify(r.history)}\n`);
process.stdout.write(`  ${r.evaluations} evals / ${r.evaluatorCalls} evaluator calls (memoized), improvedOverBaseline=${r.improvedOverBaseline}\n`);
process.stdout.write(`  receipt → bench/results/discovery-evolve.json\n`);
