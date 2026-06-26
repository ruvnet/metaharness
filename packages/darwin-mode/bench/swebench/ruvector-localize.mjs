// SPDX-License-Identifier: MIT
//
// RuVector-HNSW code-localization prototype (feasibility probe).
//
// GOAL: the HARD-25 SWE-bench instances are Opus-give-ups (no patch produced); the #1 suspected
// blocker is LOCALIZATION — the ReAct agent never finds the right files in a big repo before its
// step budget runs out. This module is the candidate fix: a retrieval-seeded localization surface.
//
// PIPELINE (conformant — issue text + repo code only, NEVER gold tests):
//   1. INDEX   clone the repo at base_commit, walk source files, chunk at function/class
//              granularity (a lightweight brace/def scanner — no full parse), embed each chunk
//              with a cheap code-capable embedding model (OpenRouter text-embedding-3-small),
//              and build a RuVector HNSW index (the native `ruvector` npm addon).
//   2. RETRIEVE embed the issue problem_statement, HNSW-search the top-k most similar chunks.
//   3. SEED    emit a ranked {files, symbols, snippets} JSON — the agent's starting
//              localization surface (consumed by solve-agentic.mjs --localize-seed).
//
// CLI: `node ruvector-localize.mjs --instance <id> --manifest full-300.json --k 12`
// writes a seed file and prints retrieval stats (latency, cost, #chunks).
//
// This is a PROTOTYPE: chunking is regex-grained (good enough to localize a file/symbol; not an
// AST), the embedder is a remote API (latency + $), and n is tiny. It is a feasibility probe, not
// a benchmark — see LEARNINGS in the report.

import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- ruvector (native HNSW addon) -------------------------------------------------------------
// Resolved from the ruvector repo's node_modules (the published 0.1.100 native build).
const RUVECTOR_PATH = process.env.RUVECTOR_PATH || '/home/ruvultra/projects/ruvector/node_modules/ruvector';
function loadRuvector() {
  const rv = require(RUVECTOR_PATH);
  return { VectorDB: rv.VectorDB || rv.VectorDb || rv.default, impl: rv.getImplementationType?.() };
}

// --- args -------------------------------------------------------------------------------------
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const INSTANCE = argv('--instance', null);
const MANIFEST = join(HERE, argv('--manifest', 'full-300.json'));
const K = +argv('--k', 12);
const OUT = argv('--out', null); // seed json path; default /tmp/localize-seed-<id>.json
const EMBED_MODEL = argv('--embed-model', 'openai/text-embedding-3-small');
const EMBED_DIM = +argv('--embed-dim', 1536); // text-embedding-3-small native dim
const BASE_URL = argv('--base-url', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY = (process.env[argv('--api-key-env', 'OPENROUTER_API_KEY')]
  || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const MAX_CHUNKS = +argv('--max-chunks', 4000); // cap index size for the prototype

// --- repo fetch (mirror solve-agentic.mjs's shallow clone) ------------------------------------
const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function fetchRepo(repo, sha) {
  const work = mkdtempSync(join(tmpdir(), 'rvloc-'));
  g(work, 'git init -q'); g(work, `git remote add origin https://github.com/${repo}.git`);
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) { try { execSync(`sleep ${3 * 2 ** (attempt - 1)}`); } catch { /**/ } }
    try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); last = null; break; }
    catch { try { g(work, 'git fetch --depth 200 origin -q'); g(work, `git checkout -q ${sha}`); last = null; break; } catch (e2) { last = e2; } }
  }
  if (last) throw last;
  return work;
}

// --- chunking (function/class granularity, regex-grained, language-aware-lite) ----------------
const SRC_EXT = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.rs', '.java', '.rb', '.c', '.cc', '.cpp', '.h', '.hpp']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'vendor', '.tox', '__pycache__', 'target', 'docs', 'doc', '.github', 'tests', 'test', 'testing']);
// We skip test dirs from the INDEX too — conformant localization should point at *source*, and it
// keeps the index small. (Issue text never references the gold test file path.)

function walk(root) {
  const out = [];
  const rec = (dir) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) rec(p); }
      else if (SRC_EXT.has(extname(e.name))) { try { if (statSync(p).size < 400_000) out.push(p); } catch { /**/ } }
    }
  };
  rec(root);
  return out;
}

// Split a file into def/class-level chunks. Python: top-level + nested `def`/`class`.
// Other langs: `function`/`class`/`fn`/`func`/`type` headers. Falls back to fixed-size windows
// for files with no recognizable defs.
const DEF_RE = /^(\s*)(?:async\s+)?(?:def|class|function|fn|func|type|public|private|protected|static|export)\b.*?([A-Za-z_][A-Za-z0-9_]*)/;
function chunkFile(relPath, text) {
  const lines = text.split('\n');
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DEF_RE);
    if (m) heads.push({ line: i, sym: m[2], indent: m[1].length });
  }
  const chunks = [];
  if (heads.length === 0) {
    for (let i = 0; i < lines.length; i += 80) {
      chunks.push({ file: relPath, sym: '(file)', start: i + 1, end: Math.min(i + 80, lines.length), text: lines.slice(i, i + 80).join('\n') });
    }
    return chunks;
  }
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].line;
    let end = lines.length;
    for (let n = h + 1; n < heads.length; n++) { if (heads[n].indent <= heads[h].indent) { end = heads[n].line; break; } }
    if (end - start > 200) end = start + 200; // cap giant defs
    chunks.push({ file: relPath, sym: heads[h].sym, start: start + 1, end, text: lines.slice(start, end).join('\n') });
  }
  return chunks;
}

// --- embeddings (OpenRouter, batched) ---------------------------------------------------------
let embedCalls = 0, embedTokensApprox = 0;
async function embedBatch(inputs) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE_URL}/embeddings`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
      });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json();
      if (!j.data) { lastErr = new Error('no data: ' + JSON.stringify(j).slice(0, 200)); continue; }
      embedCalls++;
      embedTokensApprox += j.usage?.total_tokens || inputs.reduce((s, x) => s + Math.ceil(x.length / 4), 0);
      return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('embed failed');
}
async function embedAll(texts, batchSize = 64) {
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize).map((t) => t.slice(0, 8000)); // per-input char cap
    out.push(...await embedBatch(slice));
  }
  return out;
}

// --- main -------------------------------------------------------------------------------------
async function main() {
  if (!INSTANCE) { console.error('need --instance'); process.exit(2); }
  if (!KEY) { console.error('no API key (set OPENROUTER_API_KEY or /tmp/.orkey)'); process.exit(2); }
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')).instances;
  const inst = manifest.find((i) => i.instance_id === INSTANCE);
  if (!inst) { console.error('instance not in manifest: ' + INSTANCE); process.exit(2); }

  const t0 = Date.now();
  const { VectorDB, impl } = loadRuvector();
  const work = fetchRepo(inst.repo, inst.base_commit);
  const tClone = Date.now();

  // index
  const files = walk(work);
  let chunks = [];
  for (const f of files) {
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    chunks.push(...chunkFile(relative(work, f), text));
    if (chunks.length > MAX_CHUNKS) break;
  }
  chunks = chunks.slice(0, MAX_CHUNKS);
  const tChunk = Date.now();

  // embed chunks (prefix with file path + symbol so the path is part of the signal)
  const chunkTexts = chunks.map((c) => `# ${c.file} :: ${c.sym}\n${c.text}`);
  const chunkVecs = await embedAll(chunkTexts);
  const tEmbed = Date.now();

  // build HNSW
  const db = new VectorDB({ dimensions: EMBED_DIM, distanceMetric: 'Cosine' });
  await db.insertBatch(chunks.map((c, i) => ({
    id: String(i),
    vector: chunkVecs[i],
    metadata: { file: c.file, sym: c.sym, start: c.start, end: c.end },
  })));
  const tIndex = Date.now();

  // retrieve
  const [qVec] = await embedAll([inst.problem_statement.slice(0, 8000)]);
  const hits = await db.search({ vector: qVec, k: Math.min(K * 3, chunks.length), efSearch: 200 });
  const tSearch = Date.now();

  // aggregate to file-level (best chunk score per file), keep top symbols per file
  const byFile = new Map();
  for (const h of hits) {
    const f = h.metadata.file;
    const cur = byFile.get(f) || { file: f, score: -Infinity, symbols: [] };
    cur.score = Math.max(cur.score, h.score);
    if (h.metadata.sym && h.metadata.sym !== '(file)' && !cur.symbols.includes(h.metadata.sym)) cur.symbols.push(h.metadata.sym);
    byFile.set(f, cur);
  }
  const rankedFiles = [...byFile.values()].sort((a, b) => b.score - a.score).slice(0, K);
  const topSnippets = hits.slice(0, Math.min(6, hits.length)).map((h) => {
    const c = chunks[+h.id];
    return { file: c.file, sym: c.sym, start: c.start, end: c.end, score: +h.score.toFixed(4), text: c.text.slice(0, 1200) };
  });

  const seed = {
    instance_id: INSTANCE,
    repo: inst.repo,
    engine: `ruvector-hnsw (${impl})`,
    embed_model: EMBED_MODEL,
    k: K,
    files: rankedFiles.map((f) => ({ file: f.file, score: +f.score.toFixed(4), symbols: f.symbols.slice(0, 6) })),
    snippets: topSnippets,
    stats: {
      n_files_indexed: files.length,
      n_chunks: chunks.length,
      embed_calls: embedCalls,
      embed_tokens_approx: embedTokensApprox,
      ms_clone: tClone - t0,
      ms_chunk: tChunk - tClone,
      ms_embed_index: tEmbed - tChunk,
      ms_build_hnsw: tIndex - tEmbed,
      ms_search: tSearch - tIndex,
      ms_total: tSearch - t0,
      embed_cost_usd: +((embedTokensApprox / 1e6) * 0.02).toFixed(5), // text-embedding-3-small price
    },
  };

  const outPath = OUT || `/tmp/localize-seed-${INSTANCE}.json`;
  writeFileSync(outPath, JSON.stringify(seed, null, 2));
  try { execSync(`rm -rf ${work}`); } catch { /**/ }
  console.error(`[localize] ${INSTANCE} repo=${inst.repo} files=${files.length} chunks=${chunks.length} `
    + `embed=${embedTokensApprox}tok ($${seed.stats.embed_cost_usd}) total=${seed.stats.ms_total}ms search=${seed.stats.ms_search}ms`);
  console.error(`[localize] top files: ${rankedFiles.slice(0, 5).map((f) => f.file).join(', ')}`);
  console.error(`[localize] seed -> ${outPath}`);
  console.log(outPath);
}

main().catch((e) => { console.error('localize failed:', e.message); process.exit(1); });
