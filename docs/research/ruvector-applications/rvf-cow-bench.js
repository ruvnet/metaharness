#!/usr/bin/env node
/*
 * RVF COW branching proof benchmark.
 * Proves/refutes README claims:
 *   - "git-like COW branching — 1M vectors, 100 edits = ~2.5 MB branch"
 *   - "single .rvf boots in 125ms"
 *   - "12µs warm queries"
 * $0 local benchmark. AMD Ryzen 9 9950X, Node v22.
 */
const { RvfDatabase } = require('/home/ruvultra/projects/ruvector/npm/packages/rvf-node/index.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIM = 128;
const METRIC = 'cosine';

function now() { return Number(process.hrtime.bigint()) / 1e6; } // ms
function rndVecs(n, dim) {
  const a = new Float32Array(n * dim);
  for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1;
  return a;
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];
}

function buildBase(p, n, dim) {
  const t0 = now();
  const db = RvfDatabase.create(p, { dimension: dim, metric: METRIC });
  // ingest in chunks to keep memory bounded
  const CHUNK = 50000;
  let id = 1;
  for (let off = 0; off < n; off += CHUNK) {
    const cnt = Math.min(CHUNK, n - off);
    const v = rndVecs(cnt, dim);
    const ids = new Array(cnt);
    for (let i = 0; i < cnt; i++) ids[i] = id++;
    db.ingestBatch(v, ids);
  }
  const buildMs = now() - t0;
  const size = fs.statSync(p).size;
  return { db, buildMs, size };
}

function timeMany(fn, iters) {
  const samples = new Array(iters);
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6; // ms
  }
  return samples;
}

function main() {
  const SIZES = process.env.SIZES ? process.env.SIZES.split(',').map(Number) : [10000, 100000, 1000000];
  const EDIT_COUNTS = [10, 100, 1000];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvf-cow-bench-'));
  const machine = `${os.cpus()[0].model.trim()} / Node ${process.version} / Linux`;
  const results = { machine, dim: DIM, metric: METRIC, sizes: [] };
  console.log('# RVF COW benchmark');
  console.log('machine:', machine, 'dim:', DIM, '\n');

  for (const N of SIZES) {
    console.log(`\n===== BASE N=${N} vectors (dim ${DIM}) =====`);
    const basePath = path.join(dir, `base_${N}.rvf`);
    const { db: base, buildMs, size: baseSize } = buildBase(basePath, N, DIM);
    console.log(`build: ${buildMs.toFixed(0)} ms, base file: ${fmtBytes(baseSize)} (${baseSize} B)`);

    // ---- COLD BOOT: open existing .rvf ----
    base.close();
    const openSamples = timeMany(() => {
      const d = RvfDatabase.open(basePath);
      d.status(); // force touch
      d.close();
    }, 10);
    const openMed = pct(openSamples, 50);
    console.log(`cold open (RvfDatabase.open): median ${openMed.toFixed(3)} ms (min ${Math.min(...openSamples).toFixed(3)})`);

    // reopen for queries/derives
    const baseRO = RvfDatabase.open(basePath);

    // ---- WARM QUERY latency ----
    const q = rndVecs(1, DIM);
    // warmup
    for (let i = 0; i < 200; i++) baseRO.query(q, 10);
    const qSamples = timeMany(() => baseRO.query(q, 10), 5000);
    const qMedUs = pct(qSamples, 50) * 1000;
    const qP99Us = pct(qSamples, 99) * 1000;
    const qMinUs = Math.min(...qSamples) * 1000;
    console.log(`warm query (k=10): median ${qMedUs.toFixed(1)} µs, p99 ${qP99Us.toFixed(1)} µs, min ${qMinUs.toFixed(1)} µs`);

    // ---- DERIVE (empty branch) latency ----
    const deriveSamples = timeMany((i) => {
      const cp = path.join(dir, `der_${N}_${i}.rvf`);
      const c = baseRO.derive(cp, { dimension: DIM });
      c.close();
    }, 20);
    const deriveMed = pct(deriveSamples, 50);
    const emptyBranchPath = path.join(dir, `der_${N}_0.rvf`);
    const emptyBranchSize = fs.statSync(emptyBranchPath).size;
    console.log(`derive() empty branch: median ${deriveMed.toFixed(3)} ms, branch file: ${fmtBytes(emptyBranchSize)} (${emptyBranchSize} B)`);

    // ---- BRANCH + N EDITS: delta size & latency ----
    const editResults = [];
    for (const E of EDIT_COUNTS) {
      const cp = path.join(dir, `edit_${N}_${E}.rvf`);
      const tDerive0 = now();
      const child = baseRO.derive(cp, { dimension: DIM });
      const tDerive = now() - tDerive0;
      // apply E edits: ingest E NEW vectors (ids past base range)
      const v = rndVecs(E, DIM);
      const ids = new Array(E);
      for (let i = 0; i < E; i++) ids[i] = N + 1 + i;
      const tEdit0 = now();
      const ir = child.ingestBatch(v, ids);
      const tEdit = now() - tEdit0;
      child.close();
      const branchSize = fs.statSync(cp).size;
      // correctness: reopen child, ensure edited vector is queryable
      const cRO = RvfDatabase.open(cp);
      const probe = new Float32Array(v.slice(0, DIM));
      const hit = cRO.query(probe, 1);
      const childVecs = cRO.status().totalVectors;
      cRO.close();
      editResults.push({
        edits: E, accepted: ir.accepted, deriveMs: tDerive, editMs: tEdit,
        branchBytes: branchSize, childTotalVectors: childVecs,
        probeTopId: hit[0] ? hit[0].id : null, probeDist: hit[0] ? hit[0].distance : null,
      });
      console.log(`  edits=${E}: derive ${tDerive.toFixed(2)}ms + ingest ${tEdit.toFixed(2)}ms | branch ${fmtBytes(branchSize)} (${branchSize} B) | child sees ${childVecs} vecs | probe top id=${hit[0]?.id} dist=${hit[0]?.distance.toFixed(4)}`);
    }

    // ---- NAIVE BASELINE: full file copy ----
    const copySamples = timeMany((i) => {
      const cpPath = path.join(dir, `copy_${N}_${i}.rvf`);
      fs.copyFileSync(basePath, cpPath);
      fs.rmSync(cpPath);
    }, 5);
    const copyMed = pct(copySamples, 50);
    console.log(`naive full-copy baseline: median ${copyMed.toFixed(2)} ms, ${fmtBytes(baseSize)}`);

    baseRO.close();
    results.sizes.push({
      n: N, baseBytes: baseSize, buildMs, openMedMs: openMed,
      queryMedUs: qMedUs, queryP99Us: qP99Us, queryMinUs: qMinUs,
      deriveEmptyMedMs: deriveMed, emptyBranchBytes: emptyBranchSize,
      edits: editResults, copyMedMs: copyMed,
    });
    // cleanup per-size scratch to bound disk
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`der_${N}_`) || f.startsWith(`copy_${N}_`)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }

  const outJson = path.join(dir, 'results.json');
  fs.writeFileSync(outJson, JSON.stringify(results, null, 2));
  console.log('\nJSON results:', outJson);
  // also dump to stdout for capture
  console.log('===JSON_START===');
  console.log(JSON.stringify(results));
  console.log('===JSON_END===');
}

main();
