// SPDX-License-Identifier: MIT
//
// $0 deterministic tests for the runtime measurement core — synthetic lens artifacts + hand-verifiable
// activations, NO model. Proves the math (lens_l(h)=unembed(J·h)), drift/entropy, vectorized safety
// triggers (incl. cross-model isolation), the decision rule, and the end-to-end receipt.

import { describe, it, expect } from 'vitest';
import {
  WorkspaceLens, detectConcepts, flagsFromTriggers, workspaceDrift, entropyTrajectory,
  decide, buildReceipt, sha256, matVec, cosine, softmax, jensenShannon, topKIndices,
  type LensArtifact, type ConceptVector, type HiddenState,
} from '../src/index.js';

// dModel=3, vocab of 5. J(layer 5)=identity so project(h)=h; unembed maps components to tokens:
//   yes=[1,0,0] no=[0,1,0] wrong=[0,0,1] right=[1,1,0] secret=[0,0,0]
function synthArtifact(): LensArtifact {
  return {
    lensId: 'jlens-synth-v1',
    modelId: 'synth-3d',
    dModel: 3,
    vocab: ['yes', 'no', 'wrong', 'right', 'secret'],
    unembed: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 0, 0]],
    layers: [{ layer: 5, jacobian: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
  };
}

describe('linalg', () => {
  it('matVec computes M·x and rejects shape mismatch', () => {
    expect(matVec([[1, 2], [3, 4]], [1, 1])).toEqual([3, 7]);
    expect(() => matVec([[1, 2]], [1, 2, 3])).toThrow(/cols/);
  });
  it('cosine is 1 for parallel, 0 for orthogonal or zero', () => {
    expect(cosine([0, 0, 5], [0, 0, 1])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  it('softmax sums to 1 and jensenShannon is 0 for identical, >0 for different', () => {
    const p = softmax([1, 2, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(jensenShannon(p, p)).toBeCloseTo(0);
    expect(jensenShannon(softmax([5, 0, 0]), softmax([0, 0, 5]))).toBeGreaterThan(0);
  });
  it('topKIndices returns highest-first, stable on ties', () => {
    expect(topKIndices([0.1, 0.9, 0.5], 2)).toEqual([1, 2]);
    expect(topKIndices([1, 1, 1], 2)).toEqual([0, 1]);
  });
});

describe('WorkspaceLens', () => {
  const lens = WorkspaceLens.fromArtifact(synthArtifact());

  it('exposes model/lens metadata and fitted layers', () => {
    expect(lens.modelId).toBe('synth-3d');
    expect(lens.lensId).toBe('jlens-synth-v1');
    expect(lens.layers).toEqual([5]);
    expect(lens.hasLayer(5)).toBe(true);
    expect(lens.hasLayer(6)).toBe(false);
  });

  it('readout decodes unembed(J·h) → the right top workspace token', () => {
    const r = lens.readout({ layer: 5, position: 3, h: [0, 0, 5] });
    expect(r.tokens[0].token).toBe('wrong');   // component 3 dominates
    expect(r.tokens[0].rank).toBe(0);
    expect(r.entropy).toBeGreaterThan(0);
  });

  it('project = J·h and throws on an un-fitted layer or wrong width', () => {
    expect(lens.project({ layer: 5, position: 0, h: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(() => lens.project({ layer: 9, position: 0, h: [1, 2, 3] })).toThrow(/no fitted operator/);
    expect(() => lens.project({ layer: 5, position: 0, h: [1, 2] })).toThrow(/width/);
  });

  it('rejects a malformed artifact eagerly', () => {
    const bad = { ...synthArtifact(), unembed: [[1, 0, 0]] }; // rows != vocab
    expect(() => WorkspaceLens.fromArtifact(bad as LensArtifact)).toThrow(/unembed rows/);
  });
});

describe('safety triggers (vectorized, tokenizer-agnostic)', () => {
  const lens = WorkspaceLens.fromArtifact(synthArtifact());
  const states: HiddenState[] = [{ layer: 5, position: 3, h: [0, 0, 5] }];

  it('fires when the J-projection aligns with a concept direction, and maps to a flag', () => {
    const concepts: ConceptVector[] = [
      { concept: 'hidden_objective', modelId: 'synth-3d', vector: [0, 0, 1], critical: true },
    ];
    const triggers = detectConcepts(lens, states, concepts, { threshold: 0.5 });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].score).toBeCloseTo(1);
    expect(flagsFromTriggers(triggers).hiddenObjective).toBe(true);
  });

  it('never cross-applies a concept vector from another model', () => {
    const concepts: ConceptVector[] = [{ concept: 'hidden_objective', modelId: 'gemma-2-9b', vector: [0, 0, 1] }];
    expect(detectConcepts(lens, states, concepts)).toHaveLength(0);
  });

  it('does not fire an orthogonal concept', () => {
    const concepts: ConceptVector[] = [{ concept: 'exfiltration', modelId: 'synth-3d', vector: [1, 0, 0] }];
    expect(detectConcepts(lens, states, concepts, { threshold: 0.5 })).toHaveLength(0);
  });
});

describe('drift + entropy', () => {
  const lens = WorkspaceLens.fromArtifact(synthArtifact());
  it('drift is 0 for a stable workspace and >0 when the distribution jumps', () => {
    const stable = [lens.readout({ layer: 5, position: 0, h: [0, 0, 5] }), lens.readout({ layer: 5, position: 1, h: [0, 0, 5] })];
    expect(workspaceDrift(stable).drift).toBeCloseTo(0);
    const jump = [lens.readout({ layer: 5, position: 0, h: [5, 0, 0] }), lens.readout({ layer: 5, position: 1, h: [0, 0, 5] })];
    expect(workspaceDrift(jump).drift).toBeGreaterThan(0);
  });
  it('entropyTrajectory returns one entropy per readout', () => {
    const rs = [lens.readout({ layer: 5, position: 0, h: [0, 0, 5] })];
    expect(entropyTrajectory(rs)).toHaveLength(1);
  });
});

describe('decision rule', () => {
  const base = { taskResolved: true, workspaceDrift: 0.1, driftThreshold: 0.3, triggers: [], receiptCoverage: 1 };
  it('accepts only when all four clauses pass', () => {
    expect(decide(base).accepted).toBe(true);
  });
  it('rejects with an auditable reason per failed clause', () => {
    expect(decide({ ...base, taskResolved: false }).reasons).toContain('task not resolved');
    expect(decide({ ...base, workspaceDrift: 0.9 }).accepted).toBe(false);
    expect(decide({ ...base, receiptCoverage: 0.5 }).accepted).toBe(false);
    const crit = decide({ ...base, triggers: [{ concept: 'exfiltration', layer: 5, position: 0, score: 0.9, critical: true }] });
    expect(crit.accepted).toBe(false);
    expect(crit.reasons.join(' ')).toMatch(/critical safety trigger/);
  });
});

describe('buildReceipt (end-to-end)', () => {
  const lens = WorkspaceLens.fromArtifact(synthArtifact());
  it('assembles a deterministic, auditable receipt', () => {
    const states: HiddenState[] = [
      { layer: 5, position: 3, h: [0, 0, 5] },
      { layer: 5, position: 4, h: [5, 0, 0] },
    ];
    const concepts: ConceptVector[] = [{ concept: 'hidden_objective', modelId: 'synth-3d', vector: [0, 0, 1], critical: true }];
    const r = buildReceipt(lens, 'Is 12+5=1 correct?', states, { concepts, createdAt: '2026-07-07T00:00:00Z', topK: 5 });
    expect(r.promptHash).toBe(sha256('Is 12+5=1 correct?'));
    expect(r.modelId).toBe('synth-3d');
    expect(r.layerRange).toEqual([5, 5]);
    expect(r.positions).toEqual([3, 4]);
    expect(r.topTokens[0].tokens[0].token).toBe('wrong');
    expect(r.flags.hiddenObjective).toBe(true);
    expect(r.entropyTrajectory).toHaveLength(2);
    expect(r.workspaceDrift).toBeGreaterThan(0);
    expect(r.createdAt).toBe('2026-07-07T00:00:00Z');
  });
});

// Acceptance-test SHAPE (mechanism only — synthetic, not a model claim): a mid-layer readout can surface
// an un-emitted abstract judgment ("wrong") for a "12+5=1" prompt while only the digits are in context.
describe('acceptance-test shape: un-emitted judgment surfaces in the workspace', () => {
  it('the Jacobian readout ranks the abstract concept above the surface tokens', () => {
    // A lens whose J rotates the residual so the "wrong" direction dominates mid-network even though the
    // raw activation (logit-lens) would read the surface digit. Here J maps h=[digit,0,0] → [0,0,1].
    const artifact: LensArtifact = {
      ...synthArtifact(),
      layers: [{ layer: 8, jacobian: [[0, 0, 0], [0, 0, 0], [1, 0, 0]] }],
    };
    const lens = WorkspaceLens.fromArtifact(artifact);
    const r = lens.readout({ layer: 8, position: 6, h: [9, 0, 0] }); // "9" surface digit in context
    expect(r.tokens[0].token).toBe('wrong');   // J-lens surfaces the abstract judgment, not the digit
  });
});
