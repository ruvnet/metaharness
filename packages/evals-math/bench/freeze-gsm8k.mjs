#!/usr/bin/env node
// Freeze a GSM8K split for the LIVE flywheel run — the math analog of freeze-swebench-suites.mjs.
//
// Anti-overfit is PROCEDURAL (ADR-233 four-set contract): load real GSM8K (test split) once, split it
// DETERMINISTICALLY (hash-sort by id — no RNG, so re-running yields byte-identical sets), and commit the
// hashed manifest so a reviewer can prove the split was fixed BEFORE any tuning. The four sets:
//   publicDev         — the flywheel ANCHOR (never optimized against) + the leakage corpus
//   privateTrain      — the proposer searches policy mutations here
//   privateValidation — the promotion gate scores candidates here (the flywheel holdout)
//   frozenHoldout     — NEVER shown to the proposer/gate; confirmed against EXACTLY ONCE, at the very end
//
// Only real, exact-match-gradable GSM8K (integer gold after `#### N`) is included — the loader drops any
// unparseable row rather than fabricate a gold answer.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadGsm8kFromHub, manifestOf } from '../dist/data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const LIMIT = +arg('--limit', 200);
// Sizes (disjoint, sum ≤ LIMIT). Small holdout+anchor keep a live run cheap/fast; frozenHoldout is the
// one-shot final confirm.
const SIZES = { publicDev: 30, privateTrain: 50, privateValidation: 40, frozenHoldout: 40 };

const hsort = (a, b) => createHash('sha256').update(a.id).digest('hex').localeCompare(createHash('sha256').update(b.id).digest('hex'));

const items = await loadGsm8kFromHub({ limit: LIMIT, token: process.env.HUGGINGFACE_API_KEY || undefined });
const need = Object.values(SIZES).reduce((s, n) => s + n, 0);
if (items.length < need) { console.error(`loaded ${items.length} GSM8K items but need ${need} — raise --limit`); process.exit(1); }

// Hash-sort the whole corpus, then carve DISJOINT contiguous slices — deterministic + disjoint by construction.
const sorted = [...items].sort(hsort);
let off = 0;
const split = {};
for (const [k, n] of Object.entries(SIZES)) { split[k] = sorted.slice(off, off + n); off += n; }

const manifest = manifestOf(split);
const out = { dataset: 'openai/gsm8k', config: 'main', split: 'test', frozenAt: arg('--stamp', 'unstamped'), sizes: manifest.sizes, hashes: manifest.hashes, splitFingerprint: manifest.splitFingerprint, sets: split };
const path = join(HERE, 'gsm8k-frozen.json');
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log(`froze ${need} GSM8K items → ${path}`);
console.log(`  sizes: ${JSON.stringify(manifest.sizes)}`);
console.log(`  splitFingerprint: ${manifest.splitFingerprint}`);
