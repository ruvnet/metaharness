// SPDX-License-Identifier: MIT
//
// Bench for harness-spec.ts (ADR-159 HarnessSpec). Demonstrates three properties
// that make the spec evolvable: (1) genome⇄spec round-trips losslessly, (2) replay
// is deterministic across many seeds, and (3) a policy mutation is OBSERVABLE as a
// spec-hash delta even when every step output is pinned — proving the program
// thesis that "Darwin Mode mutates structured policies, not prompts."
//
// The measured optimization: pinning step outputs (fixedOutputs) makes replay O(1)
// per step with no RNG draws, so re-replays for hash comparison are cheap and the
// only signal that moves the hash is the structured policy itself.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  genomeToSpec,
  specToGenome,
  replaySpec,
  defaultPolicy,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const N = 256;

const planners = ['file-first', 'sink-first', 'diff-first', 'callgraph-first', 'risk-first', 'memory-first'];
const ctxs = ['minimal', 'semantic', 'callgraph', 'hybrid'];

/** Deterministically build a genome from an index (no Math.random). */
function genomeAt(i) {
  return {
    planner: planners[i % planners.length],
    contextPolicy: ctxs[i % ctxs.length],
    reviewerCount: i % 4,
    retryBudget: i % 5,
    tools: ['read', 'edit', 'test'].slice(0, 1 + (i % 3)),
    policy: defaultPolicy(),
  };
}

// (1) Round-trip identity across N genomes.
let roundTripOk = true;
let sizeSum = 0;
for (let i = 0; i < N; i += 1) {
  const g = genomeAt(i);
  const spec = genomeToSpec(g);
  sizeSum += JSON.stringify(spec).length;
  const back = specToGenome(spec);
  if (JSON.stringify(back) !== JSON.stringify(g)) roundTripOk = false;
}
const avgSpecBytes = Math.round(sizeSum / N);

// (2) Deterministic replay: replay each spec twice across many seeds, compare.
let replayDeterministic = true;
const spec = genomeToSpec(genomeAt(2));
for (let seed = 0; seed < N; seed += 1) {
  const a = replaySpec(spec, { seed });
  const b = replaySpec(spec, { seed });
  if (a.hash !== b.hash) replayDeterministic = false;
}

// (3) Policy mutation is observable even with every output pinned.
const fixedOutputs = Object.fromEntries(spec.steps.map((s) => [s.id, 1]));
const baseHash = replaySpec(spec, { seed: 0, fixedOutputs }).hash;
const mutated = { ...spec, policy: { ...spec.policy, coderModel: 'frontier' } };
const mutatedHash = replaySpec(mutated, { seed: 0, fixedOutputs }).hash;
const policyMutationObservable = baseHash !== mutatedHash;

console.log(`harness-spec: roundTripOk=${roundTripOk} genomes=${N}`);
console.log(`harness-spec: replayDeterministic=${replayDeterministic} seeds=${N}`);
console.log(`harness-spec: avgSpecBytes=${avgSpecBytes}`);
console.log(`harness-spec: policyMutationObservable=${policyMutationObservable} (${baseHash} -> ${mutatedHash})`);

const receipt = { roundTripOk, replayDeterministic, policyMutationObservable, genomes: N, avgSpecBytes };
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'harness-spec.json'), JSON.stringify(receipt, null, 2));

process.exit(0);
