// SPDX-License-Identifier: MIT
//
// h3-code-gate.mjs — ADR-201 H3-code GATE ($0). Does a code-structure graph traverse
// non-trivially on real SWE-bench-style Python repos? (Priority-2 leverage-map / RepoGraph thesis.)
//
// WHY: the FRAMES H3 was a STRUCTURAL null — Wikipedia + ONNX all-MiniLM-L6-v2 is a DENSE cluster
// (all pairwise cosine ≥ 0.43), so kHop over a fully-connected graph == dense cosine top-k
// (graphHits=0 by construction). CODE is the opposite hypothesis: unrelated files have cosine
// 0.05–0.25 (SPARSE), so an import/call/test→target graph traversal CAN surface files that are
// structurally connected but topically distant — i.e. NOT in the cosine top-k. RepoGraph
// (arXiv 2408.09504) reports +7pp on SWE-bench from exactly this.
//
// THIS IS A $0 GATE, NOT A PAID RUN. It answers two falsifiable questions before any LLM spend:
//   (1) SPARSITY: is the code corpus's pairwise cosine ≪ 0.43 under the SAME ONNX embedder that
//       made FRAMES dense?  (apples-to-apples control: same embedder, different corpus)
//   (2) graphHits > 0: seeded from the issue/failing-test, does kHop / hub-degree / PageRank
//       topology traversal over the SPARSE graph retrieve files NOT in the dense cosine top-k?
//   (bonus) GOLD RECOVERY: when the dense top-k MISSES the gold patch file, does the graph reach it?
//
// HONESTY: if graphHits=0 again → the gate FAILS, we STOP at $0 and report the structural reason.
// No Python is used to parse (project rule): a JS regex import/def extractor builds the graph.
// Topology traversal uses the REAL local @ruvector/graph-node v2.0.4 (kHopNeighbors, native Rust);
// PageRank + hub-degree are computed in JS over the same edge set (graph-node ships no PageRank).
//
// Label: kHop / PageRank / hub-degree TOPOLOGY TRAVERSAL over a code graph (NOT the unshipped
// Rust community-detection GraphRAG). Embedder: ONNX all-MiniLM-L6-v2 (384-d, local, $0).

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(import.meta.url);

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
function argv(flag, def) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const has = (flag) => process.argv.includes(flag);

const MOCK = has('--mock');
const RUVECTOR_PATH = argv('--ruvector', '/home/ruvultra/projects/ruvector/node_modules/ruvector');
const GRAPH_NODE_PATH = argv('--graph-node', '/home/ruvultra/projects/ruvector/npm/packages/graph-node');
const SCRATCH = argv('--scratch', '/tmp/claude-1000/-home-ruvultra-projects-agent-harness-generator/ec35bf87-f599-4921-ac41-4996378d9334/scratchpad/h3-code-repos');
const CANDIDATES = argv('--dataset', join(__dirname, '../swerebench/candidates-65.json'));
const OUT = argv('--out', join(__dirname, 'data/h3-code-gate-report.json'));
const TOPK = parseInt(argv('--k', '10'), 10);       // dense top-k retrieval size
const KHOP = parseInt(argv('--khop', '2'), 10);     // graph traversal depth
const MAX_FILES = parseInt(argv('--max-files', '1200'), 10);

// Default 5 instances: diverse, medium-sized Python repos with rich multi-module import graphs
// and single/few-file gold targets reachable via imports (clone fast, shallow depth-1).
const DEFAULT_INSTANCES = [
  'scikit-hep__cabinetry-506',
  'lmfit__lmfit-py-989',
  'pgmpy__pgmpy-1906',
  'zarr-developers__zarr-python-2661',
  'pdm-project__pdm-3393',
];
const INSTANCES = (argv('--instances', '') || '').trim()
  ? argv('--instances').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_INSTANCES;

const log = (...a) => console.error(...a);

// ── embedder (ONNX all-MiniLM-L6-v2, same as FRAMES H3; --mock falls back to hashed bigrams) ───
let _embedDim = 384;
export async function initEmbedder() {
  if (MOCK) {
    const { embedText } = await import('./embedder.mjs');
    _embedDim = 256;
    const cache = new Map();
    log('[embedder] MOCK hashed bag-of-bigrams (256-d) — NOT comparable to FRAMES ONNX');
    return async (t) => { if (!cache.has(t)) cache.set(t, embedText(t, 256)); return cache.get(t); };
  }
  let rv;
  try { rv = req(RUVECTOR_PATH); } catch (e) { throw new Error(`cannot load ruvector at ${RUVECTOR_PATH}: ${e.message}`); }
  if (!rv.OnnxEmbedder || !rv.isOnnxAvailable || !rv.isOnnxAvailable()) {
    throw new Error('ruvector OnnxEmbedder not available — set --ruvector or use --mock');
  }
  const onnx = new rv.OnnxEmbedder();
  if (onnx.init) await onnx.init();
  const toArr = (v) => Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : (v?.data ? Array.from(v.data) : Array.from(v || []));
  let gate = Promise.resolve();
  const serial = (text) => { const p = gate.then(() => onnx.embed(String(text)).then(toArr)); gate = p.catch(() => {}); return p; };
  const probe = await serial('dimension probe');
  _embedDim = probe.length;
  const cache = new Map();
  log(`[embedder] ONNX all-MiniLM-L6-v2 ready: ${_embedDim}-d (same embedder as FRAMES H3)`);
  return async (t) => { if (!cache.has(t)) cache.set(t, await serial(t)); return cache.get(t); };
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

// ── repo clone (shallow depth-1 at base_commit; $0) ────────────────────────────────────────────
function sh(cwd, cmd) { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
export function cloneRepo(repo, sha, dest) {
  if (existsSync(join(dest, '.git'))) { try { sh(dest, 'git rev-parse HEAD'); return dest; } catch { /* re-clone */ } }
  mkdirSync(dest, { recursive: true });
  sh(dest, 'git init -q');
  sh(dest, `git remote add origin https://github.com/${repo}.git`);
  try { sh(dest, `git fetch --depth 1 origin ${sha} -q`); sh(dest, 'git checkout -q FETCH_HEAD'); }
  catch { sh(dest, 'git fetch --depth 200 origin -q'); sh(dest, `git checkout -q ${sha}`); }
  return dest;
}

// ── file enumeration ───────────────────────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.git', '__pycache__', '.tox', '.venv', 'venv', 'node_modules', 'build',
  'dist', '.eggs', 'site-packages', '.mypy_cache', '.pytest_cache', 'docs', 'doc', 'examples',
  'example', 'benchmarks', '.github', 'vendor', 'third_party']);
export function walkPy(root) {
  const out = [];
  (function rec(dir) {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.endsWith('.egg-info')) rec(join(dir, e.name)); }
      else if (e.isFile() && e.name.endsWith('.py')) out.push(join(dir, e.name));
    }
  })(root);
  return out;
}
export const isTestFile = (rel) => /(^|\/)tests?(\/|$)|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/.test(rel);

// ── module-name resolution (Python package semantics, JS-implemented) ──────────────────────────
export function moduleNameFor(root, absPath) {
  const rel = relative(root, absPath).split(sep).join('/');
  let parts = rel.replace(/\.py$/, '').split('/');
  // strip src/ layout prefix if no __init__ at root level
  // module dotted name = path with dirs that form a package chain; we keep full path-derived name
  if (parts[parts.length - 1] === '__init__') parts = parts.slice(0, -1);
  return parts.join('.');
}

// Build the code-structure graph: nodes=files, edges=imports / test→target (bidirectional).
export function buildGraph(root, files) {
  const nodes = [];                  // { id, path, rel, isTest, text, symbols:Set }
  const byModule = new Map();        // dotted module -> node id
  const byRel = new Map();           // rel path -> node id
  const bySymbol = new Map();        // symbol name -> Set(node id) (where DEFINED)
  const pkgDirsByName = new Map();   // last path segment dir -> node ids (for relative import package resolution)

  for (const abs of files) {
    const rel = relative(root, abs).split(sep).join('/');
    let src; try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const id = `f${nodes.length}`;
    const mod = moduleNameFor(root, abs);
    // symbol table: top-level def/class names
    const symbols = new Set();
    for (const m of src.matchAll(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)) symbols.add(m[1]);
    // compact embedding text: path + docstring head + signature lines (semantic surface)
    const sigLines = (src.match(/^\s*(?:async\s+)?(?:def|class)\s+.+$/gm) || []).slice(0, 80).join('\n');
    const head = src.slice(0, 800);
    const text = `# file: ${rel}\n${head}\n${sigLines}`.slice(0, 2000);
    const node = { id, path: abs, rel, mod, isTest: isTestFile(rel), text, symbols, vec: null };
    nodes.push(node);
    byModule.set(mod, id);
    byRel.set(rel, id);
    for (const s of symbols) { if (!bySymbol.has(s)) bySymbol.set(s, new Set()); bySymbol.get(s).add(id); }
  }

  // resolve a dotted module (or its parents) to a node id
  function resolveModule(dotted) {
    if (byModule.has(dotted)) return byModule.get(dotted);
    // try suffix matches: e.g. "cabinetry.templates.collector" when nodes are stored with full path-name
    const parts = dotted.split('.');
    for (let i = 0; i < parts.length; i++) {
      const suff = parts.slice(i).join('.');
      if (byModule.has(suff)) return byModule.get(suff);
    }
    // try as a package (dir/__init__) — match any module that endsWith dotted
    for (const [m, id] of byModule) if (m === dotted || m.endsWith('.' + dotted)) return id;
    return null;
  }

  const edgeSet = new Set();
  const adj = new Map();             // id -> Set(neighbor id)  (undirected for reachability)
  const indeg = new Map();           // for hub-degree
  function addEdge(a, b, kind) {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!edgeSet.has(key)) edgeSet.add(`${key}:${kind}`);
    if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b);
    if (!adj.has(b)) adj.set(b, new Set()); adj.get(b).add(a);
    indeg.set(b, (indeg.get(b) || 0) + 1);
    indeg.set(a, (indeg.get(a) || 0) + 1);
  }

  const edges = [];                  // for graph-node DB (directed import a->b)
  for (const node of nodes) {
    let src; try { src = readFileSync(node.path, 'utf8'); } catch { continue; }
    const myParts = node.mod.split('.');
    for (const m of src.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/gm)) {
      const dots = m[1].length, base = m[2], names = m[3];
      let targets = [];
      if (dots > 0) {
        // relative import: climb `dots` levels from current package
        const pkg = myParts.slice(0, Math.max(0, myParts.length - dots));
        const full = base ? [...pkg, ...base.split('.')].join('.') : pkg.join('.');
        targets.push(full);
        // `from . import x` → sibling module x
        for (const nm of names.split(',')) {
          const sym = nm.trim().split(/\s+as\s+/)[0].trim().replace(/[()]/g, '');
          if (sym && sym !== '*') targets.push([...pkg, sym].join('.'));
        }
      } else if (base) {
        targets.push(base);
        for (const nm of names.split(',')) {
          const sym = nm.trim().split(/\s+as\s+/)[0].trim().replace(/[()]/g, '');
          if (sym && sym !== '*') targets.push(`${base}.${sym}`);
        }
      }
      for (const t of targets) { const tid = resolveModule(t); if (tid) addEdge(node.id, tid, node.isTest ? 'test->target' : 'import'); }
    }
    for (const m of src.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/gm)) {
      const tid = resolveModule(m[1]); if (tid) addEdge(node.id, tid, node.isTest ? 'test->target' : 'import');
    }
  }
  // build directed edge list (both directions) for graph-node DB
  for (const [a, set] of adj) for (const b of set) edges.push({ from: a, to: b });

  return { nodes, byModule, byRel, bySymbol, resolveModule, adj, indeg, edges, edgeCount: edgeSet.size };
}

// ── PageRank (JS, over undirected adjacency) ───────────────────────────────────────────────────
export function pageRank(nodes, adj, { d = 0.85, iters = 50 } = {}) {
  const ids = nodes.map((n) => n.id);
  const N = ids.length;
  let pr = new Map(ids.map((id) => [id, 1 / N]));
  for (let it = 0; it < iters; it++) {
    const next = new Map(ids.map((id) => [id, (1 - d) / N]));
    let dangling = 0;
    for (const id of ids) { const deg = adj.get(id)?.size || 0; if (deg === 0) dangling += pr.get(id); }
    for (const id of ids) {
      const neigh = adj.get(id); const deg = neigh?.size || 0;
      if (deg > 0) { const share = (d * pr.get(id)) / deg; for (const nb of neigh) next.set(nb, next.get(nb) + share); }
    }
    const dShare = (d * dangling) / N;
    for (const id of ids) next.set(id, next.get(id) + dShare);
    pr = next;
  }
  return pr;
}

// ── seed extraction from issue text + test patch (NOT from gold patch) ──────────────────────────
export function extractSeeds(graph, problem, testPatch) {
  const seeds = new Set();
  const reasons = [];
  const text = `${problem || ''}\n${testPatch || ''}`;
  // 1. explicit file paths e.g. src/cabinetry/templates/collector.py  or  templates/collector.py
  for (const m of text.matchAll(/[\w./-]+\.py/g)) {
    const p = m[0].replace(/^a\//, '').replace(/^b\//, '');
    for (const [rel, id] of graph.byRel) {
      if (rel === p || rel.endsWith('/' + p) || basename(rel) === basename(p)) { if (!seeds.has(id)) reasons.push(`path:${p}->${rel}`); seeds.add(id); }
    }
  }
  // 2. dotted module / symbol refs e.g. templates.collector._histo_path  or  module.Class.method
  for (const m of text.matchAll(/\b([a-zA-Z_]\w+(?:\.[a-zA-Z_]\w+){1,4})\b/g)) {
    const id = graph.resolveModule(m[1]); if (id) { if (!seeds.has(id)) reasons.push(`dotted:${m[1]}`); seeds.add(id); }
  }
  // 3. defined symbols (class/func names) mentioned in issue → files that DEFINE them
  //    require the symbol to be reasonably specific (len>=4, present in code) to avoid noise
  const symCounts = new Map();
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]{3,}|[a-z_][a-z0-9_]{4,})\b/g)) symCounts.set(m[1], (symCounts.get(m[1]) || 0) + 1);
  for (const [sym, ids] of graph.bySymbol) {
    if (symCounts.has(sym) && ids.size <= 3) { for (const id of ids) { if (!seeds.has(id)) reasons.push(`symbol:${sym}`); seeds.add(id); } }
  }
  return { seeds: [...seeds], reasons };
}

export function goldCodeFiles(patch) {
  const files = [...String(patch || '').matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]);
  // gold "target" files = .py, non-test (the fix location, which retrieval must surface)
  return files.filter((f) => /\.py$/.test(f) && !isTestFile(f));
}

export function pctl(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; }

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const dataset = JSON.parse(readFileSync(CANDIDATES, 'utf8')).instances;
  const byId = new Map(dataset.map((x) => [x.instance_id, x]));
  const embed = await initEmbedder();
  mkdirSync(SCRATCH, { recursive: true });
  mkdirSync(dirname(OUT), { recursive: true });

  const results = [];
  for (const instId of INSTANCES) {
    const inst = byId.get(instId);
    if (!inst) { log(`[skip] ${instId} not in dataset`); continue; }
    log(`\n=== ${instId} (${inst.repo}) ===`);
    const dest = join(SCRATCH, instId);
    try { cloneRepo(inst.repo, inst.base_commit, dest); } catch (e) { log(`[clone-fail] ${instId}: ${e.message}`); results.push({ instId, error: `clone: ${e.message}` }); continue; }

    let files = walkPy(dest);
    if (files.length > MAX_FILES) {
      // restrict to the largest package dir to stay tractable
      files = files.sort((a, b) => a.length - b.length).slice(0, MAX_FILES);
      log(`[trim] ${files.length} files (capped at ${MAX_FILES})`);
    }
    const graph = buildGraph(dest, files);
    log(`[graph] nodes=${graph.nodes.length} undirected-edges=${graph.edgeCount} test-files=${graph.nodes.filter((n) => n.isTest).length}`);
    if (graph.nodes.length < 5 || graph.edgeCount === 0) { log(`[skip] trivial graph`); results.push({ instId, repo: inst.repo, nodes: graph.nodes.length, edges: graph.edgeCount, note: 'trivial graph' }); continue; }

    // embed all file nodes (ONNX, memoized)
    for (const n of graph.nodes) n.vec = await embed(n.text);

    // (1) SPARSITY: pairwise cosine distribution (sample if large)
    const N = graph.nodes.length;
    const pairCos = [];
    const allPairs = (N * (N - 1)) / 2;
    if (allPairs <= 30000) {
      for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairCos.push(cosine(graph.nodes[i].vec, graph.nodes[j].vec));
    } else {
      let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let s = 0; s < 30000; s++) { const i = Math.floor(rnd() * N), j = Math.floor(rnd() * N); if (i !== j) pairCos.push(cosine(graph.nodes[i].vec, graph.nodes[j].vec)); }
    }
    const sparsity = {
      min: Math.min(...pairCos), median: pctl(pairCos, 0.5), mean: pairCos.reduce((a, b) => a + b, 0) / pairCos.length,
      p90: pctl(pairCos, 0.9), p95: pctl(pairCos, 0.95), max: Math.max(...pairCos),
      fracGE043: pairCos.filter((c) => c >= 0.43).length / pairCos.length, nPairs: pairCos.length,
    };
    log(`[sparsity] min=${sparsity.min.toFixed(3)} median=${sparsity.median.toFixed(3)} mean=${sparsity.mean.toFixed(3)} p95=${sparsity.p95.toFixed(3)} frac≥0.43=${(sparsity.fracGE043 * 100).toFixed(1)}%`);

    // gold + seeds
    const gold = goldCodeFiles(inst.patch);
    const goldIds = gold.map((g) => { for (const [rel, id] of graph.byRel) if (rel === g || rel.endsWith('/' + g) || basename(rel) === basename(g)) return id; return null; }).filter(Boolean);
    const { seeds, reasons } = extractSeeds(graph, inst.problem_statement, inst.test_patch);
    // seeds for traversal: exclude gold ids so we test DISCOVERY of gold via topology
    const seedIds = seeds.filter((id) => !goldIds.includes(id));
    log(`[gold] files=${JSON.stringify(gold)} matchedNodes=${goldIds.length} | seeds=${seedIds.length} (raw ${seeds.length})`);

    // (dense) top-k cosine over file corpus, query = problem statement (truncated)
    const qvec = await embed(String(inst.problem_statement || '').slice(0, 2000));
    const denseRanked = graph.nodes.map((n) => ({ id: n.id, score: cosine(qvec, n.vec) })).sort((a, b) => b.score - a.score);
    const denseTopK = new Set(denseRanked.slice(0, TOPK).map((x) => x.id));

    // (graph) topology traversal via REAL @ruvector/graph-node kHopNeighbors
    let graphReached = new Set();
    let graphBackend = 'none';
    if (seedIds.length > 0) {
      try {
        const gn = req(GRAPH_NODE_PATH);
        const db = new gn.GraphDatabase({ distanceMetric: 'Cosine', dimensions: _embedDim });
        const z = new Float32Array(_embedDim);
        for (const n of graph.nodes) await db.createNode({ id: n.id, embedding: Float32Array.from(n.vec) });
        for (const e of graph.edges) { try { await db.createEdge({ from: e.from, to: e.to, description: 'rel', embedding: z }); } catch { /* skip dup */ } }
        for (const sid of seedIds) { const nb = await db.kHopNeighbors(sid, KHOP); for (const x of nb) graphReached.add(x); }
        graphBackend = `@ruvector/graph-node@${gn.version ? gn.version() : '?'}`;
      } catch (e) {
        log(`[graph-node fallback] ${e.message} — JS BFS kHop`);
        graphBackend = 'js-bfs';
        for (const sid of seedIds) {
          let frontier = new Set([sid]); graphReached.add(sid);
          for (let h = 0; h < KHOP; h++) { const nx = new Set(); for (const u of frontier) for (const v of (graph.adj.get(u) || [])) if (!graphReached.has(v)) { graphReached.add(v); nx.add(v); } frontier = nx; }
        }
      }
    }
    // graphHits = files reached by traversal that are NOT in the dense cosine top-k (and not seeds)
    const seedSet = new Set(seedIds);
    const graphOnly = [...graphReached].filter((id) => !denseTopK.has(id) && !seedSet.has(id));
    const graphHits = graphOnly.length;

    // topology-scoring rankings (hub-degree + PageRank) — alternative seed-free retrieval signals
    const pr = pageRank(graph.nodes, graph.adj);
    const prRanked = [...pr.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const degRanked = [...graph.indeg.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

    // ── usefulness signals (gold recovery) ──────────────────────────────────────────────────────
    const goldInDense = goldIds.filter((id) => denseTopK.has(id));
    const goldInGraph = goldIds.filter((id) => graphReached.has(id));
    const goldRecoveredByGraph = goldIds.filter((id) => graphReached.has(id) && !denseTopK.has(id));
    const goldRankPR = goldIds.map((id) => prRanked.indexOf(id) + 1);
    const goldRankDeg = goldIds.map((id) => degRanked.indexOf(id) + 1);
    const goldDenseRank = goldIds.map((id) => denseRanked.findIndex((x) => x.id === id) + 1);

    const relOf = (id) => graph.nodes.find((n) => n.id === id)?.rel;
    log(`[traverse] backend=${graphBackend} reached=${graphReached.size} graphHits(non-topk)=${graphHits}` +
        ` | gold: denseTopK=${goldInDense.length}/${goldIds.length} graphReach=${goldInGraph.length}/${goldIds.length} recoveredByGraph=${goldRecoveredByGraph.length}`);
    log(`[gold-rank] denseRank=${JSON.stringify(goldDenseRank)} prRank=${JSON.stringify(goldRankPR)} degRank=${JSON.stringify(goldRankDeg)} (of ${N})`);

    results.push({
      instId, repo: inst.repo, base_commit: inst.base_commit, is_lite: inst.is_lite ?? null,
      nodes: N, undirectedEdges: graph.edgeCount, testFiles: graph.nodes.filter((n) => n.isTest).length,
      sparsity,
      gold, goldMatched: goldIds.length, goldRels: goldIds.map(relOf),
      seeds: seedIds.length, seedRels: seedIds.map(relOf).slice(0, 12), seedReasons: reasons.slice(0, 12),
      denseTopK: TOPK, khop: KHOP, graphBackend,
      graphReached: graphReached.size, graphHits, graphOnlyRels: graphOnly.slice(0, 15).map(relOf),
      goldInDenseTopK: goldInDense.length, goldInGraphReach: goldInGraph.length, goldRecoveredByGraph: goldRecoveredByGraph.length,
      goldRecoveredRels: goldRecoveredByGraph.map(relOf),
      goldDenseRank, goldPageRankRank: goldRankPR, goldHubDegreeRank: goldRankDeg,
    });
  }

  // ── aggregate gate verdict ───────────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.sparsity);
  const medians = ok.map((r) => r.sparsity.median);
  const mins = ok.map((r) => r.sparsity.min);
  const totGraphHits = ok.reduce((a, r) => a + (r.graphHits || 0), 0);
  const instWithHits = ok.filter((r) => (r.graphHits || 0) > 0).length;
  const totGold = ok.reduce((a, r) => a + (r.goldMatched || 0), 0);
  const goldDenseMiss = ok.reduce((a, r) => a + ((r.goldMatched || 0) - (r.goldInDenseTopK || 0)), 0);
  const goldRecovered = ok.reduce((a, r) => a + (r.goldRecoveredByGraph || 0), 0);
  const corpusMedianCos = medians.length ? medians.reduce((a, b) => a + b, 0) / medians.length : null;

  const SPARSE = corpusMedianCos != null && corpusMedianCos < 0.43;
  const TRAVERSES = instWithHits === ok.length && totGraphHits > 0; // graphHits>0 on EVERY instance
  const GATE_PASS = SPARSE && TRAVERSES;

  const summary = {
    adr: 'ADR-201 H3-code', kind: 'topology-traversal-gate', dollars: 0,
    embedder: MOCK ? 'mock-hash-256' : 'onnx-all-MiniLM-L6-v2-384',
    label: 'kHop / PageRank / hub-degree TOPOLOGY traversal over a code import/test graph (NOT Rust community-detection GraphRAG)',
    n: ok.length, instances: INSTANCES,
    sparsity: { corpusMedianCosMean: corpusMedianCos, minOfMins: mins.length ? Math.min(...mins) : null,
      perInstanceMedian: ok.map((r) => ({ id: r.instId, median: r.sparsity.median, min: r.sparsity.min, fracGE043: r.sparsity.fracGE043 })),
      FRAMES_reference: 'FRAMES+ONNX min pairwise cosine ≥ 0.434 (dense); H3-code expects ≪0.43 (sparse)' },
    traversal: { totalGraphHits: totGraphHits, instancesWithHits: instWithHits, ofInstances: ok.length },
    goldRecovery: { totalGoldMatched: totGold, goldMissedByDenseTopK: goldDenseMiss, goldRecoveredByGraphTraversal: goldRecovered },
    verdict: { SPARSE, TRAVERSES, GATE_PASS,
      interpretation: GATE_PASS
        ? `GATE PASSED — code corpus is SPARSE (median cosine ${corpusMedianCos?.toFixed(3)} ≪ 0.43) and topology traversal surfaces ${totGraphHits} non-top-k files across all ${ok.length} instances (FRAMES failure mode does NOT recur). Gold-recovery signal: graph reached ${goldRecovered} gold file(s) the dense top-k missed.`
        : `GATE ${SPARSE ? 'PARTIAL' : 'FAILED'} — SPARSE=${SPARSE} TRAVERSES=${TRAVERSES}. ${SPARSE ? 'Sparsity confirmed but traversal did not surface non-top-k files everywhere.' : 'Corpus not sparse — structural null risk recurs.'}` },
    results,
  };

  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  log(`\n${'='.repeat(70)}`);
  log(`GATE VERDICT: ${GATE_PASS ? 'PASS ✓' : 'FAIL ✗'}  (SPARSE=${SPARSE}, TRAVERSES=${TRAVERSES})`);
  log(`  corpus median cosine (mean over instances): ${corpusMedianCos?.toFixed(4)}  [FRAMES was ≥0.434 dense]`);
  log(`  graphHits (non-top-k files surfaced): ${totGraphHits} total, ${instWithHits}/${ok.length} instances >0`);
  log(`  gold recovery: ${goldRecovered} gold file(s) reached by graph that dense top-k missed (of ${goldDenseMiss} missed)`);
  log(`  report → ${OUT}`);
  console.log(JSON.stringify(summary.verdict, null, 2));
}

import { realpathSync } from 'node:fs';
const _invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (_invoked) main().catch((e) => { console.error('FATAL', e); process.exit(1); });
