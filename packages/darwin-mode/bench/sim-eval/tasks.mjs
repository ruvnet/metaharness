// SPDX-License-Identifier: MIT
//
// Frozen task partitions for the #523 sealed SIM evaluation. Pure: no dist
// imports, no I/O except the explicit `--write` CLI path. Two Tier-2 benchmark
// families (ADR-106 agent sandbox; graded by tier2-driver at $0):
//
//   loc — LOCATE: the buggy file `src/<a>_<b>.ts` sits behind `before` tie
//         distractors `src/<a>_<b>_<i>.ts`, so it survives only if the real
//         contextBuilder's window/ranking reaches it.
//   per — PERSIST: few distractors; the task fails `failAttempts` times with a
//         given classification, so retryPolicy budget/classification matter.
//
// Train tasks are optimizer-visible (passed to evolve()); held-out tasks are
// SEALED: they are graded only after a run finishes, on its winner. The two
// partitions use disjoint vocabularies and the held-out ranges extend beyond
// the train ranges (an extrapolation split), so an edit tuned exactly to the
// train tasks can pass train and still fail held-out.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PARTITION_VERSION = 'sim-eval-tasks-v1';
export const PARTITION_SEED = 523;

/** mulberry32 — tiny deterministic PRNG. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRAIN_WORDS = ['auth', 'token', 'cache', 'key', 'retry', 'budget', 'queue', 'lock', 'route', 'table', 'parse', 'frame'];
const HELDOUT_WORDS = ['ledger', 'shard', 'socket', 'pool', 'index', 'graph', 'vault', 'stream', 'clock', 'batch', 'cursor', 'scope'];

function task(id, a, b, before, extra) {
  const buggyFile = `src/${a}_${b}.ts`;
  const files = [...Array.from({ length: before }, (_, i) => `src/${a}_${b}_${i}.ts`), buggyFile];
  return { id, prompt: `fix ${a} ${b}`, files, buggyFile, ...extra };
}

function pair(r, words) {
  const a = words[Math.floor(r() * words.length)];
  let b = words[Math.floor(r() * words.length)];
  if (b === a) b = words[(words.indexOf(a) + 1) % words.length];
  return [a, b];
}

/** Build both families' train and sealed held-out partitions deterministically. */
export function buildPartitions(seed = PARTITION_SEED) {
  const r = rng(seed);
  const out = { loc: { train: [], heldout: [] }, per: { train: [], heldout: [] } };
  // loc train: 10 tasks, before in [0, 50]. held-out: 48 tasks, before in [0, 160].
  for (let i = 0; i < 10; i++) {
    const [a, b] = pair(r, TRAIN_WORDS);
    out.loc.train.push(task(`loc-t${i}`, a, b, Math.round((i * 50) / 9),
      { classification: 'transient', failAttempts: 0, backoffMs: 20, difficulty: 1 + Math.min(4, Math.floor(i / 2)) }));
  }
  for (let i = 0; i < 48; i++) {
    const [a, b] = pair(r, HELDOUT_WORDS);
    const before = Math.floor(r() * 161);
    out.loc.heldout.push(task(`loc-h${i}`, a, b, before,
      { classification: 'transient', failAttempts: 0, backoffMs: 20, difficulty: 1 + Math.min(4, Math.floor(before / 40)) }));
  }
  // per: classifications cycle; train failAttempts in {0,1,2}; held-out in {0..6}.
  const classes = ['transient', 'repairable', 'unknown'];
  for (let i = 0; i < 9; i++) {
    const [a, b] = pair(r, TRAIN_WORDS);
    const failAttempts = i % 3;
    out.per.train.push(task(`per-t${i}`, a, b, Math.floor(r() * 6),
      { classification: classes[Math.floor(i / 3)], failAttempts, backoffMs: 30, difficulty: 1 + failAttempts }));
  }
  for (let i = 0; i < 48; i++) {
    const [a, b] = pair(r, HELDOUT_WORDS);
    const failAttempts = Math.floor(r() * 7);
    out.per.heldout.push(task(`per-h${i}`, a, b, Math.floor(r() * 6),
      { classification: classes[i % 3], failAttempts, backoffMs: 30, difficulty: 1 + Math.min(4, failAttempts) }));
  }
  return out;
}

/** Canonical sha256 of a partitions object (key order is fixed by construction). */
export function partitionHash(partitions) {
  return createHash('sha256').update(JSON.stringify(partitions)).digest('hex');
}

/**
 * Sealing check: the optimizer-visible view of a benchmark contains no
 * held-out id, prompt or file. Returns a list of leaks (empty ⇒ sealed).
 */
export function sealingLeaks(partitions) {
  const leaks = [];
  for (const [bench, p] of Object.entries(partitions)) {
    const visible = JSON.stringify(p.train);
    for (const h of p.heldout) {
      if (visible.includes(`"${h.id}"`)) leaks.push(`${bench}: id ${h.id}`);
      if (visible.includes(h.buggyFile)) leaks.push(`${bench}: file ${h.buggyFile}`);
    }
  }
  return leaks;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const partitions = buildPartitions();
  const doc = { version: PARTITION_VERSION, seed: PARTITION_SEED, sha256: partitionHash(partitions), partitions };
  writeFileSync(new URL('./tasks.json', import.meta.url), JSON.stringify(doc) + '\n');
  console.log(JSON.stringify({ version: doc.version, sha256: doc.sha256, leaks: sealingLeaks(partitions) }));
}
