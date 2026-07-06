// D1-S2 (self-learning scale loop) — freeze a SWE-bench-Lite HOLDOUT + a separate FROZEN ANCHOR slice
// for the flywheel domain-scale run (D1-S4). The holdout is optimized against; the anchor is NEVER
// optimized against (the anti-Goodhart guard) — they MUST be disjoint. Selection is DETERMINISTIC
// (hash-sorted by instance_id → reproducible, no RNG), so re-running yields byte-identical fixtures and
// the pinned sha256 is a checkable immutability anchor. Source: full-300.json (the SWE-bench manifest);
// the official harness resolves the rest (test patch / FAIL_TO_PASS) by instance_id at D1-S4.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const rel = (p) => join(HERE, p);
const sha = (s) => createHash('sha256').update(s).digest('hex');

export const HOLDOUT_SIZE = 40;
export const ANCHOR_SIZE = 15;

/** Deterministic disjoint split: sort instances by sha256(instance_id), take holdout then anchor. */
export function selectSuites(instances, holdoutSize = HOLDOUT_SIZE, anchorSize = ANCHOR_SIZE) {
  const ordered = [...instances].sort((a, b) => sha(a.instance_id).localeCompare(sha(b.instance_id)));
  const holdout = ordered.slice(0, holdoutSize);
  const anchor = ordered.slice(holdoutSize, holdoutSize + anchorSize);
  return { holdout, anchor };
}

/** The immutability anchor: sha256 over the sorted instance_ids of a suite. */
export function suiteHash(instances) {
  return sha(instances.map((i) => i.instance_id).sort().join('\n'));
}

function freeze(instances, role, source) {
  return {
    schema: 'flywheel.frozen-suite/v1',
    role, // 'holdout' | 'anchor'
    source,
    n: instances.length,
    sha256: suiteHash(instances),
    frozen_at_note: 'DETERMINISTIC (hash-sorted); re-run freeze-swebench-suites.mjs to reproduce byte-identically',
    instances,
  };
}

// CLI: regenerate the fixtures (only run intentionally — the committed fixtures are the frozen truth).
if (import.meta.url === `file://${process.argv[1]}`) {
  const source = 'full-300.json';
  const raw = JSON.parse(readFileSync(rel(source), 'utf-8'));
  const instances = raw.instances ?? raw;
  const { holdout, anchor } = selectSuites(instances);
  const inter = new Set(holdout.map((i) => i.instance_id));
  if (anchor.some((i) => inter.has(i.instance_id))) throw new Error('holdout/anchor overlap — not disjoint');
  writeFileSync(rel('swebench-holdout-frozen.json'), JSON.stringify(freeze(holdout, 'holdout', source), null, 2));
  writeFileSync(rel('swebench-anchor-frozen.json'), JSON.stringify(freeze(anchor, 'anchor', source), null, 2));
  console.log(`holdout: ${holdout.length} sha256=${suiteHash(holdout).slice(0, 16)}…`);
  console.log(`anchor:  ${anchor.length} sha256=${suiteHash(anchor).slice(0, 16)}…`);
  console.log('disjoint: OK');
}
