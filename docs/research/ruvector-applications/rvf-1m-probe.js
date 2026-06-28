#!/usr/bin/env node
// Instrumented 1M probe — each phase timed separately with progress prints.
const { RvfDatabase } = require('/home/ruvultra/projects/ruvector/npm/packages/rvf-node/index.js');
const fs = require('fs'), os = require('os'), path = require('path');
const DIM = 128, N = 1000000;
const log = (...a) => { console.log(...a); };
function now() { return Number(process.hrtime.bigint()) / 1e6; }
function rndVecs(n, dim) { const a = new Float32Array(n * dim); for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1; return a; }
function fmt(b){ return b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(2)+' MB'; }
function med(a){ const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvf-1m-'));
const bp = path.join(dir, 'base.rvf');

let t = now();
const base = RvfDatabase.create(bp, { dimension: DIM, metric: 'cosine' });
let id = 1;
for (let off = 0; off < N; off += 50000) {
  const cnt = Math.min(50000, N - off);
  const v = rndVecs(cnt, DIM);
  const ids = new Array(cnt); for (let i = 0; i < cnt; i++) ids[i] = id++;
  base.ingestBatch(v, ids);
}
const buildMs = now() - t;
const baseSize = fs.statSync(bp).size;
log(`build: ${buildMs.toFixed(0)} ms | base ${fmt(baseSize)}`);
base.close();

// COLD OPEN x3
const opens = [];
for (let i = 0; i < 3; i++) { t = now(); const d = RvfDatabase.open(bp); d.status(); opens.push(now() - t); d.close(); log(`  open #${i+1}: ${opens[i].toFixed(1)} ms`); }
log(`cold open median: ${med(opens).toFixed(1)} ms`);

const db = RvfDatabase.open(bp);
const q = rndVecs(1, DIM);
// FIRST query (includes lazy HNSW index build)
t = now(); db.query(q, 10); const firstQ = now() - t;
log(`first query (incl. lazy HNSW build): ${firstQ.toFixed(0)} ms`);
// warm queries
for (let i = 0; i < 100; i++) db.query(q, 10);
const qs = [];
for (let i = 0; i < 2000; i++) { const q2 = rndVecs(1, DIM); t = process.hrtime.bigint(); db.query(q2, 10); qs.push(Number(process.hrtime.bigint() - t) / 1e6); }
qs.sort((a,b)=>a-b);
log(`warm query k=10: median ${(med(qs)*1000).toFixed(1)} µs | p99 ${(qs[Math.floor(qs.length*0.99)]*1000).toFixed(1)} µs | min ${(qs[0]*1000).toFixed(1)} µs`);

// DERIVE + edits
for (const E of [10, 100, 1000]) {
  const cp = path.join(dir, `e${E}.rvf`);
  t = now(); const c = db.derive(cp, { dimension: DIM, metric: 'cosine' }); const dms = now() - t;
  const v = rndVecs(E, DIM); const ids = new Array(E); for (let i = 0; i < E; i++) ids[i] = N + 1 + i;
  t = now(); c.ingestBatch(v, ids); const ems = now() - t;
  c.close();
  log(`derive+${E} edits: derive ${dms.toFixed(2)}ms + ingest ${ems.toFixed(2)}ms | branch ${fmt(fs.statSync(cp).size)} (${fs.statSync(cp).size} B)`);
}
// empty branch size
const ce = path.join(dir, 'empty.rvf'); db.derive(ce, { dimension: DIM, metric: 'cosine' }).close();
log(`empty branch: ${fs.statSync(ce).size} B`);

// NAIVE full copy x3
const cps = [];
for (let i = 0; i < 3; i++) { const cc = path.join(dir, `c${i}.rvf`); t = now(); fs.copyFileSync(bp, cc); cps.push(now() - t); fs.rmSync(cc); }
log(`naive full-copy: median ${med(cps).toFixed(1)} ms | ${fmt(baseSize)}`);

db.close();
fs.rmSync(dir, { recursive: true, force: true });
log('DONE_1M');
