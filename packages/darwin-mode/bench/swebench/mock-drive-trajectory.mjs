#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// ADR-231 forward-contract PROOF driver — $0, no Docker, no LLM, no network.
//
// Drives the REAL trajectory serialization path (createTrajectoryRecorder → assembleTrajectoryRecord →
// JSONL) with STUBBED upstream signals (the agent transcript, the localizer seed, the selector `row`),
// exactly as solve-agentic.mjs feeds it — but without paying for a solve. Emits two solver-trajectory
// files so `scripts/sota-attest.mjs --trajectory` can be shown flipping skip → PASS on the clean one and
// CRITICAL-failing on the dirty one.
//
//   node mock-drive-trajectory.mjs <clean|dirty> <out.jsonl>
//
// This is EVIDENCE-plumbing, not fabrication: the exact `assembleTrajectoryRecord` the real solver calls
// produces these records; only the inputs are stubbed (the shapes solveTier / localizeSeed / the `row`
// really return). It lives under bench/ (Linux+Docker research scripts; path-guard SKIPs bench/).
import { createTrajectoryRecorder } from './solver-trajectory.mjs';

const mode = process.argv[2] || 'clean';
const out = process.argv[3] || `/tmp/solver-trajectory-${mode}.jsonl`;
if (!['clean', 'dirty'].includes(mode)) { console.error('usage: mock-drive-trajectory.mjs <clean|dirty> <out.jsonl>'); process.exit(1); }

// Three stub instances mimicking what solve-agentic's runInstance passes to trajectoryRecorder.record().
// Each carries the shapes the REAL harness produces: a ReAct transcript, localizer seeds ({files:[{file}]}),
// and the finished per-instance `row` (tier drives the selector). Conformant run ⇒ noTestOracle:true.
const stubInstances = [
  {
    instance_id: 'astropy__astropy-12907',
    // Stub agent transcript — real solveTier returns res.transcript = [{actionRaw, obs}] like this.
    transcripts: [[
      { actionRaw: '{"tool":"ls","dir":"astropy/modeling"}', obs: 'separable.py\ncore.py' },
      { actionRaw: '{"tool":"read","path":"astropy/modeling/separable.py","start":1,"end":80}', obs: '1\tdef _separable(...)' },
      { actionRaw: '{"tool":"grep","pattern":"_cstack"}', obs: 'astropy/modeling/separable.py:245:def _cstack' },
      { actionRaw: '{"tool":"edit","path":"astropy/modeling/separable.py","search":"a","replace":"b"}', obs: 'edited' },
      { actionRaw: '{"tool":"run_tests"}', obs: 'run_tests: ALL TARGET TESTS PASS' },
      { actionRaw: '{"tool":"submit"}', obs: 'submitted.' },
    ]],
    // Stub localizer seed — real localizeSeed returns { files:[{file,score,symbols}], snippets, stats }.
    localizeSeeds: [{ files: [{ file: 'astropy/modeling/separable.py', score: 0.91 }, { file: 'astropy/modeling/core.py', score: 0.72 }] }],
    row: { tier: 'T2' }, // cascade winner → selector ranks on conformant-repro-tests (non-gold)
    noTestOracle: true,
  },
  {
    instance_id: 'django__django-11039',
    transcripts: [[
      { actionRaw: '{"tool":"read","path":"django/core/management/commands/sqlmigrate.py"}', obs: '1\tclass Command' },
      { actionRaw: '{"tool":"edit","path":"django/core/management/commands/sqlmigrate.py","search":"x","replace":"y"}', obs: 'edited' },
    ]],
    localizeSeeds: [{ files: [{ file: 'django/core/management/commands/sqlmigrate.py' }] }],
    row: { tier: 'T1' },
    noTestOracle: true,
  },
  {
    instance_id: 'sympy__sympy-24152',
    transcripts: [[
      { actionRaw: '{"tool":"grep","pattern":"TensorProduct"}', obs: 'sympy/physics/quantum/tensorproduct.py:1' },
      { actionRaw: '{"tool":"edit","path":"sympy/physics/quantum/tensorproduct.py","search":"p","replace":"q"}', obs: 'edited' },
    ]],
    localizeSeeds: [{ files: [{ file: 'sympy/physics/quantum/tensorproduct.py' }] }],
    row: { tier: 'repro', reproRounds: 2 }, // repro-gate winner → self-written-repro-test (non-gold)
    noTestOracle: true,
  },
];

// The DIRTY variant injects ONE of each conformance breach (spread across the instances) so all three
// enforced vectors trip: (1) gold access in-loop, (2) a gold test path in localization, (3) a gold
// selector signal (an oracle-in-loop run: noTestOracle:false → deriveSelector records 'gold-oracle').
function dirtify(instances) {
  const d = JSON.parse(JSON.stringify(instances));
  d[0].localizeSeeds[0].files.push({ file: 'astropy/modeling/tests/test_separable.py' }); // gold test path surfaced
  d[1].noTestOracle = false;                                                               // oracle in-loop → gold access + gold-oracle selector
  d[1].usedGoldOracle = true;
  return d;
}

const instances = mode === 'dirty' ? dirtify(stubInstances) : stubInstances;
const recorder = createTrajectoryRecorder(out);
for (const inst of instances) recorder.record(inst);
console.error(`[mock-drive] mode=${mode} → wrote ${instances.length} records to ${out}`);
