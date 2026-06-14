// SPDX-License-Identifier: MIT
//
// DRACO — the THREE-WAY thesis (refined M6): vanilla < harness < fusion+harness.
//
// Deterministic proof of the full ordering. The crafted transport models the
// real escalation:
//   - vanilla (1 raw call): answers from memory — no citations, partial coverage.
//   - harness (1 model, 6 stages): structure adds citations + full coverage, BUT
//     the verify stage is the same model as the synthesizer → it rubber-stamps
//     its own fabricated citation, which ships (grounding stays 0).
//   - fusion (different families): the independent verifier (gpt-5) catches the
//     fabrication → the fold drops it → a resolving citation ships (grounding 1).
// Result: vanilla < harness < fusion, each a measured delta.
import { describe, it, expect } from 'vitest';
import { runThreeWayAblation } from '../src/draco/ablation.js';
import { DRACO_SINGLE_MODEL, DRACO_OPTIMIZED_MODELS, SINGLE_MODEL_PROMPT, uniformModelMap } from '../src/draco/optimized.js';
import type { OpenRouterTransport } from '../src/draco/fusion.js';
import type { UrlChecker } from '../src/draco/scorer.js';
import type { DracoCorpus } from '../src/draco/runner.js';

const corpus: DracoCorpus = {
  version: 1,
  questions: [
    { id: 'sci-1', domain: 'science', prompt: 'consensus and the strongest dissenting positions on X?', rubric: { must_contain: ['alpha', 'beta'] } },
  ],
};
const checkUrl: UrlChecker = async (u) => (u.includes('good.example') ? 'ok' : 'dead');

// Texts at each fidelity level.
const VANILLA_ANSWER = 'alpha is broadly accepted.'; // no URL, misses 'beta', one-sided
const HARNESS_DRAFT = 'Per https://dead.example/fab alpha and beta hold. However critics dissent; in contrast others note nuance.';
const FUSION_CLEAN = 'Per https://good.example/real alpha and beta hold. However critics dissent; in contrast others note nuance.';

function craftedTransport(): OpenRouterTransport {
  const single = DRACO_SINGLE_MODEL;                 // anthropic/claude-opus-4 (vanilla + harness model + fusion synthesize)
  const fusionVerify = DRACO_OPTIMIZED_MODELS.verify; // openai/gpt-5 (independent)
  return async (model, messages) => {
    const sys = messages[0]?.content ?? '';
    // vanilla: one raw call.
    if (sys === SINGLE_MODEL_PROMPT && model === single && messages.length === 2 && /^consensus/.test(messages[1].content)) {
      return { text: VANILLA_ANSWER, tokens: 8 };
    }
    // synthesize (initial draft) — both harness + fusion produce the same flawed draft.
    if (/Write the dossier/.test(sys)) return { text: HARNESS_DRAFT, tokens: 10 };
    // verify — KEY DIFFERENCE: same-model (harness) rubber-stamps; independent (fusion) catches.
    if (/Adversarially verify/.test(sys)) {
      if (model === fusionVerify) return { text: 'UNSUPPORTED: https://dead.example/fab does not exist.', tokens: 5 };
      return { text: 'All claims SUPPORTED.', tokens: 5 }; // same-model self-approval
    }
    // fold synthesis — only meaningfully changes the answer when the verifier flagged something.
    if (/Revise the dossier to address the verifier feedback/.test(sys)) {
      // The fold only has fix material when verify flagged the fabrication (fusion).
      const verifierFeedback = messages[1]?.content ?? '';
      return verifierFeedback.includes('UNSUPPORTED')
        ? { text: FUSION_CLEAN, tokens: 9 }
        : { text: HARNESS_DRAFT, tokens: 9 }; // harness: nothing flagged → keeps the fabrication
    }
    if (/Normalise every citation/.test(sys)) {
      const draft = messages[1]?.content ?? '';
      return { text: draft, tokens: 3 }; // cite preserves whatever the fold produced
    }
    return { text: 'intermediate', tokens: 2 }; // decompose / search / grade
  };
}

describe('DRACO three-way thesis — vanilla < harness < fusion (deterministic)', () => {
  it('uniformModelMap puts one model on every stage', () => {
    const m = uniformModelMap('x/y');
    expect(new Set(Object.values(m))).toEqual(new Set(['x/y']));
  });

  it('measures the full ordering: harness beats vanilla, fusion beats harness', async () => {
    const report = await runThreeWayAblation(corpus, { transport: craftedTransport(), transportKind: 'mock', checkUrl });

    // vanilla: no URL (grounding 0), misses 'beta' (coverage 0.5), one-sided (balance 0).
    expect(report.arms.vanilla.perDimension.grounding).toBe(0);
    expect(report.arms.vanilla.perDimension.coverage).toBe(0.5);

    // harness: structure → full coverage + balance, BUT same-model verify rubber-stamps
    // the fabricated citation → grounding still 0.
    expect(report.arms.harness.perDimension.coverage).toBe(1);
    expect(report.arms.harness.perDimension.balance).toBe(1);
    expect(report.arms.harness.perDimension.grounding).toBe(0);

    // fusion: independent verifier removed the fabrication → grounding 1.
    expect(report.arms.fusion.perDimension.grounding).toBe(1);
    expect(report.arms.fusion.perDimension.coverage).toBe(1);

    // The ordering is MEASURED.
    expect(report.deltas.harnessOverVanilla).toBeGreaterThan(0); // structure beats vanilla
    expect(report.deltas.fusionOverHarness).toBeGreaterThan(0);  // fusion beats the harness
    expect(report.deltas.fusionOverVanilla).toBeGreaterThan(0);
    expect(report.ordering).toEqual(['vanilla', 'harness', 'fusion']); // best last
    expect(report.thesisHolds).toBe(true);
  });

  it('with the independent judge, fusion also leads on faithfulness', async () => {
    const judge: OpenRouterTransport = async (_m, msgs) => {
      const a = msgs[1]?.content ?? '';
      // faithful only if it cites a resolving source (fusion); fabricated/uncited → 0.
      return { text: `FAITHFULNESS: ${a.includes('good.example') ? '1.0' : '0.0'}`, tokens: 2 };
    };
    const report = await runThreeWayAblation(corpus, { transport: craftedTransport(), transportKind: 'mock', checkUrl, judgeTransport: judge });
    expect(report.judged).toBe(true);
    expect(report.arms.fusion.perDimension.faithfulness).toBe(1);
    expect(report.arms.vanilla.perDimension.faithfulness).toBe(0);
    expect(report.arms.harness.perDimension.faithfulness).toBe(0); // rubber-stamped fabrication
    expect(report.thesisHolds).toBe(true);
  });
});
