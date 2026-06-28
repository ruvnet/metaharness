// SPDX-License-Identifier: MIT
//
// FRAMES loader — the OPEN, ungated GAIA-class everyday-agentic dataset.
//
// Why FRAMES (google/frames-benchmark): the official GAIA validation set is
// HuggingFace-GATED (requires a human to accept the license on the token's
// account; confirmed inaccessible from this environment). FRAMES is the open
// GAIA-class proxy: 824 real-world MULTI-HOP general-assistant questions, each
// with a single gold `Answer` and the gold Wikipedia evidence pages. It is the
// "everyday-work, multi-step retrieval+reasoning" proxy the thesis needs, and it
// is reproducible at $0 infra (Wikipedia is keyless). Source:
//   https://huggingface.co/datasets/google/frames-benchmark  (Krishna et al. 2024)
//
// Pulls rows via the HF datasets-server (NO auth needed for this open dataset),
// emits a dataset-agnostic manifest that solve-gaia.mjs consumes:
//   { dataset, n, tasks: [{ task_id, question, answer, reasoning_types }] }
// The gold `answer` is kept ONLY for offline scoring; solve-gaia.mjs never reads it.
//
// Deterministic subset: --sample N picks a seeded shuffle (fixed seed) so EVERY
// model in the matrix is scored on the SAME questions (apples-to-apples).
//
// Run: node --experimental-strip-types frames-loader.mjs --sample 50 --out manifest-frames.json

import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const SAMPLE = +argv('--sample', 0);          // 0 = all 824
const SEED = +argv('--seed', 42);             // fixed → same subset across models
const OUT = rel(argv('--out', 'manifest-frames.json'));
const DATASET = argv('--dataset', 'google/frames-benchmark');
const CONFIG = argv('--config', 'default');
const SPLIT = argv('--split', 'test');

const DS_ROWS = 'https://datasets-server.huggingface.co/rows';

// Mulberry32 — tiny deterministic PRNG for the seeded shuffle.
function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(arr, seed) { const r = rng(seed); const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

async function fetchRows(offset, length) {
  const url = `${DS_ROWS}?dataset=${encodeURIComponent(DATASET)}&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=${length}`;
  for (let a = 0; a < 4; a++) {
    if (a) await new Promise((r) => setTimeout(r, 1000 * 2 ** (a - 1)));
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) { if (res.status === 429 || res.status >= 500) continue; throw new Error(`http ${res.status}`); }
      return await res.json();
    } catch (e) { if (a === 3) throw e; }
  }
  throw new Error('rows fetch failed');
}

async function main() {
  // First call returns num_rows_total.
  const first = await fetchRows(0, 100);
  const total = first.num_rows_total ?? first.rows?.length ?? 0;
  const rows = [...(first.rows || [])];
  for (let off = 100; off < total; off += 100) {
    const j = await fetchRows(off, Math.min(100, total - off));
    rows.push(...(j.rows || []));
    process.stderr.write(`\rfetched ${rows.length}/${total}`);
  }
  process.stderr.write('\n');

  let tasks = rows.map((r) => {
    const o = r.row;
    return {
      task_id: `frames-${o['Unnamed: 0'] ?? r.row_idx}`,
      question: String(o.Prompt ?? '').trim(),
      answer: String(o.Answer ?? '').trim(),
      reasoning_types: String(o.reasoning_types ?? '').trim(),
    };
  }).filter((t) => t.question && t.answer);

  if (SAMPLE > 0 && SAMPLE < tasks.length) tasks = shuffle(tasks, SEED).slice(0, SAMPLE);

  writeFileSync(OUT, JSON.stringify({ dataset: DATASET, split: SPLIT, seed: SEED, n: tasks.length, tasks }, null, 2));
  console.error(`wrote ${tasks.length} tasks → ${OUT} (total available ${total}, sample=${SAMPLE || 'all'}, seed=${SEED})`);
}

main().catch((e) => { console.error('loader failed:', e); process.exit(1); });
