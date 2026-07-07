#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// $0, no-model end-to-end demo of the workspace-lens → workspace-probe flow, on a synthetic lens.
// Run: node packages/workspace-probe/examples/demo.mjs
//
// A real deployment fits the lens offline (open-weight model + backward pass — see the reference
// anthropics/jacobian-lens) and captures real activations; here we hand-build a tiny lens so the whole
// governance flow runs deterministically with no dependencies.

import { WorkspaceLens, buildReceipt } from '@metaharness/workspace-lens';
import { workspaceProbeScore, gradeMutationByWorkspace } from '@metaharness/workspace-probe';

// dModel=3; J(layer 5)=identity; unembed maps residual components to tokens.
const lens = WorkspaceLens.fromArtifact({
  lensId: 'jlens-demo', modelId: 'synth-3d', dModel: 3,
  vocab: ['ok', 'wrong', 'exfiltrate'],
  unembed: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  layers: [{ layer: 5, jacobian: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }],
});

// A concept direction (per-model) for the "exfiltrate" workspace concept — flagged critical.
const concepts = [{ concept: 'exfiltration', modelId: 'synth-3d', vector: [0, 0, 1], critical: true }];

console.log('1) readout — what the activation is disposed to say:');
console.log('  ', lens.readout({ layer: 5, position: 4, h: [0, 5, 0] }).tokens.map((t) => t.token).join(' '), '(top: "wrong")\n');

// Two "decisions": one clean, one where the exfiltration direction lights up.
const clean = buildReceipt(lens, 'summarize the doc', [{ layer: 5, position: 4, h: [0, 5, 0] }], { createdAt: '2026-07-07T00:00:00Z', concepts });
const leaky = buildReceipt(lens, 'summarize the doc', [{ layer: 5, position: 4, h: [0, 0, 9] }], { createdAt: '2026-07-07T00:00:01Z', concepts });

console.log('2) workspaceProbeScore over a clean baseline:');
console.log('  ', JSON.stringify(workspaceProbeScore([clean, clean])), '\n');

console.log('3) grade-mutation — a mutation whose workspace starts leaking "exfiltration" is VETOED');
console.log('   even though the final answer may look fine:');
const verdict = gradeMutationByWorkspace([clean, clean], [clean, leaky]);
console.log('  ', JSON.stringify({ keep: verdict.keep, reasons: verdict.reasons }));
