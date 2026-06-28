#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Smoke test for @metaharness/jujutsu. Runs fully offline against the built
// dist/ using mock adapters, then probes for the real (optional) native peers
// and reports what is live. Exit non-zero only on a real failure of the
// always-available path.
//
//   npm run -w @metaharness/jujutsu build && npm run -w @metaharness/jujutsu smoke

import {
  DualStateBridge,
  MockOpProvider,
  MockMemoryProvider,
  MockQueryProvider,
  HashEmbedder,
  probe,
} from './dist/index.js';

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

console.log('=== @metaharness/jujutsu smoke ===\n');

// 1) Offline dual-state lifecycle (always available — mock adapters).
const op = new MockOpProvider(4);
const mem = new MockMemoryProvider();
const bridge = new DualStateBridge(op, mem, {
  queryProvider: new MockQueryProvider(mem),
  embedder: new HashEmbedder(64),
});

const spawned = await bridge.spawn('demo-agent');
ok(spawned.op && spawned.mem, 'spawn() creates op-branch + memory-branch together');

const learn = await bridge.learn('demo-agent', 0.92, 'clean run');
ok(learn.opCount === 4 && learn.ingested === 4, `learn() embedded ${learn.ingested}/${learn.opCount} ops into COW memory branch`);

const hits = await bridge.queryMemory('demo-agent', bridge.embed('jj commit demo-agent step 0'), 3);
ok(hits.length > 0, `queryMemory() (stubbed ANN plane) returned ${hits.length} ranked hits`);

await bridge.revert('demo-agent');
const afterRevert = await mem.diff(spawned.mem);
ok(afterRevert.added.length === 0, 'revert() dropped the memory delta back to spawn checkpoint');

await bridge.learn('demo-agent', 1.0);
const promo = await bridge.merge('demo-agent');
ok(promo.ingested > 0 && mem.base.size > 0, `merge() promoted ${promo.ingested} records into base memory`);

// 2) Probe the real removable augmentations (informational — never fails smoke).
console.log('\n--- capability probe (optional native peers) ---');
const rep = await probe();
console.log(`agentic-jujutsu addon : ${rep.opLog ? 'LIVE' : 'absent'}`);
console.log(`jj (Jujutsu) CLI      : ${rep.jjCli ? 'found' : 'absent'}`);
console.log(`agenticow memory      : ${rep.memory ? 'LIVE' : 'absent'}`);
console.log(`native ANN-across-br. : ${rep.annAcrossBranch ? 'shipped' : 'pending (RuVector PR #617)'}`);
for (const n of rep.notes) console.log(`  note: ${n}`);

console.log(`\n${failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
