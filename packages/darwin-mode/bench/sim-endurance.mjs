// SPDX-License-Identifier: MIT
// SIM persistence endurance benchmark (#522). Synthetic local-disk measurement, not a model claim.
// Run: npm run bench:sim-endurance -w @metaharness/darwin
//   options: --dir <path on the disk to measure> --records 10000,100000 --checkpoint-every 1000
//            --tail 100 --replays 5 --sustain-sizes 1000,5000,10000,20000 --sustain-appends 60
//            --out bench/results/sim-endurance.json
// Every arm runs in its own child process (clean RSS). Arms run one after another, not in
// parallel: they all fsync the same device, and concurrent fsync streams would contend and
// distort each other's latency.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = fileURLToPath(import.meta.url);
const dist = (m) => new URL(`../dist/${m}`, import.meta.url).href;
const SNAPSHOT_SCHEMA = 'metaharness.sim.v1';
const SNAPSHOT_MAX = 16 * 1024 * 1024;

// ---------- shared fixtures ----------
const scope = { ownerId: 'bench-owner', repoId: 'bench-repo', interfaceId: 'darwin-v1', modelId: 'model', benchmarkId: 'benchmark', harnessVersion: 'v1' };
const row = (id, i) => ({
  id, createdAt: '2026-11-20T00:00:00.000Z', scope, problemKey: 'timeout', diagnosis: 'synthetic timeout ' + (i % 17),
  variantId: 'variant-' + id, parentId: 'baseline', mutationSurface: 'retryPolicy', rationale: 'bounded retry',
  predictedDelta: null, observedDelta: i % 3 ? 0.01 : -0.02, finalScore: 0.4, promoted: i % 3 !== 0, evidenceIds: ['fixture:' + id],
});
function chain(count, prefix = 'seed') {
  const out = [];
  let previousHash = null;
  for (let i = 0; i < count; i++) {
    const unsigned = { ...row(`${prefix}-${i}`, i), previousHash };
    const hash = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    out.push({ ...unsigned, hash });
    previousHash = hash;
  }
  return out;
}
function ioWriteBytes() {
  try { return Number(/write_bytes:\s*(\d+)/.exec(readFileSync('/proc/self/io', 'utf8'))[1]); } catch { return null; }
}
const maxRssMb = () => +(process.resourceUsage().maxRSS / 1024).toFixed(1);
const fileSize = (p) => stat(p).then((s) => s.size, () => 0);

// ---------- statistics ----------
// mulberry32: small, fixed-seed, full-period 32-bit PRNG for reproducible resampling.
let seed = 0x5eed;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
};
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Percentile bootstrap 95% CI (fixed-seed resampling; 200 resamples).
function bootstrap(xs, stat, b = 200) {
  const out = [];
  const n = xs.length;
  for (let r = 0; r < b; r++) {
    const s = new Array(n);
    for (let i = 0; i < n; i++) s[i] = xs[(rand() * n) | 0];
    out.push(stat(s));
  }
  out.sort((a, c) => a - c);
  return [pct(out, 0.025), pct(out, 0.975)];
}
const r3 = (x) => +x.toFixed(3);
function summarize(latenciesMs) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const q = (p) => (xs) => pct([...xs].sort((a, b) => a - b), p);
  const sample = latenciesMs.length > 20_000 ? latenciesMs.filter((_, i) => i % Math.ceil(latenciesMs.length / 20_000) === 0) : latenciesMs;
  const ci = (f) => bootstrap(sample, f).map(r3);
  return {
    n: latenciesMs.length,
    meanMs: r3(mean(latenciesMs)), meanCi95: ci(mean),
    p50Ms: r3(pct(sorted, 0.5)), p50Ci95: ci(q(0.5)),
    p95Ms: r3(pct(sorted, 0.95)), p95Ci95: ci(q(0.95)),
    p99Ms: r3(pct(sorted, 0.99)), p99Ci95: ci(q(0.99)),
    recordsPerSecond: +(1000 / mean(latenciesMs)).toFixed(1),
    recordsPerSecondCi95: ci(mean).map((m) => +(1000 / m).toFixed(1)).reverse(),
  };
}

// ---------- child arms ----------
async function armJournalAppend({ dir, records, checkpointEvery, tail }) {
  const { SimJournal } = await import(dist('sim-journal.js'));
  const { checkpointPathFor } = await import(dist('sim-checkpoint.js'));
  const file = join(dir, `journal-${records}-${checkpointEvery}.jsonl`);
  const journal = new SimJournal(file, { checkpointEvery });
  await journal.acquire();
  const io0 = ioWriteBytes();
  const lat = [];
  let logical = 0;
  let checkpoints = 0;
  const start = performance.now();
  for (let i = 0; i < records; i++) {
    if (checkpointEvery > 0 && i === records - tail) { await journal.checkpoint(); checkpoints++; }
    const t = performance.now();
    const rec = await journal.append(row('id-' + i, i));
    lat.push(performance.now() - t);
    logical += Buffer.byteLength(JSON.stringify({ schema: 'metaharness.sim.journal.v1', record: rec }) + '\n');
    if (checkpointEvery > 0 && (i + 1) % checkpointEvery === 0 && i < records - tail) checkpoints++;
  }
  const elapsed = performance.now() - start;
  await journal.close();
  const io1 = ioWriteBytes();
  const manifest = await fileSize(checkpointPathFor(file));
  const journalBytes = await fileSize(file);
  return {
    arm: checkpointEvery ? `journal+checkpoint/${checkpointEvery}` : 'journal', records, file,
    wallSeconds: +(elapsed / 1000).toFixed(2), append: summarize(lat),
    diskBytes: journalBytes + manifest, bytesPerRecord: +((journalBytes + manifest) / records).toFixed(1),
    checkpoints, appBytesWritten: logical + checkpoints * manifest,
    writeAmplificationApp: +((logical + checkpoints * manifest) / logical).toFixed(4),
    writeAmplificationBlock: io0 === null ? null : +((io1 - io0) / logical).toFixed(3),
    maxRssMb: maxRssMb(),
  };
}

async function armReplay({ file, checkpoints }) {
  const { SimJournal } = await import(dist('sim-journal.js'));
  const t = performance.now();
  const journal = new SimJournal(file, { checkpoints });
  await journal.load();
  const ms = performance.now() - t;
  return { ms, records: journal.count(), ...journal.checkpointStatus(), maxRssMb: maxRssMb() };
}

// Sustained append cost at a fixed history size H, for snapshot (unmodified SimMemory and
// an fsynced variant) and journal. The store is seeded once; only the timed appends count.
async function armSustain({ dir, history, appends, kind }) {
  const { SimMemory } = await import(dist('sim-memory.js'));
  const { writeFileAtomic } = await import(dist('sim-checkpoint.js'));
  const { writeSimJournal } = await import(dist('sim-migrate.js'));
  const { SimJournal } = await import(dist('sim-journal.js'));
  const seedRecords = chain(history);
  const path = join(dir, `sustain-${kind}-${history}`);
  let append;
  let done = async () => undefined;
  const size = async () => fileSize(path);
  if (kind === 'journal') {
    await writeSimJournal(seedRecords, path);
    const j = new SimJournal(path);
    await j.acquire(); // lease + recovery happen once, outside the timed appends
    append = (r) => j.append(r);
    done = () => j.close();
  } else {
    const data = JSON.stringify({ schema: SNAPSHOT_SCHEMA, records: seedRecords }, null, 2);
    if (Buffer.byteLength(data) > SNAPSHOT_MAX) return { kind, history, skipped: `seed of ${history} records is ${Buffer.byteLength(data)} bytes, over the snapshot's 16 MiB limit` };
    await writeFile(path, data);
    if (kind === 'snapshot') {
      const m = new SimMemory(path);
      await m.load();
      append = (r) => m.append(r);
    } else {
      // Bench-local fsynced snapshot: same JSON as SimMemory.persist(), plus fsync of the
      // temp file and the directory (equal durability to the journal's per-record fsync).
      const records = [...seedRecords];
      append = async (r) => {
        const unsigned = { ...r, previousHash: records.at(-1)?.hash ?? null };
        records.push({ ...unsigned, hash: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') });
        const body = JSON.stringify({ schema: SNAPSHOT_SCHEMA, records }, null, 2);
        if (Buffer.byteLength(body) > SNAPSHOT_MAX) throw new Error('SIM: snapshot too large');
        await writeFileAtomic(path, body);
      };
    }
  }
  const lat = [];
  const before = await size();
  const io0 = ioWriteBytes();
  try {
    for (let i = 0; i < appends; i++) {
      const t = performance.now();
      await append(row(`live-${i}`, i));
      lat.push(performance.now() - t);
    }
  } catch (error) {
    return { kind, history, failedAfter: lat.length, error: String(error.message) };
  } finally { await done(); }
  const io1 = ioWriteBytes();
  const growth = (await size()) - before;
  return { kind, history, append: summarize(lat), blockBytesPerAppend: io0 === null ? null : Math.round((io1 - io0) / appends), logicalBytesPerAppend: Math.round(growth / appends), latencies: lat };
}

const ARMS = { armJournalAppend, armReplay, armSustain };
if (process.argv[2] === '--arm') {
  const result = await ARMS[process.argv[3]](JSON.parse(process.argv[4]));
  process.stdout.write('\nRESULT ' + JSON.stringify(result) + '\n');
  process.exit(0);
}

// ---------- parent ----------
function child(arm, args) {
  const r = spawnSync(process.execPath, [here, '--arm', arm, JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (r.status !== 0 || !line) throw new Error(`arm ${arm} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(line.slice(7));
}
const opt = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const list = (s) => s.split(',').map(Number);
const config = {
  records: list(opt('records', '10000,100000')), checkpointEvery: Number(opt('checkpoint-every', '1000')),
  tail: Number(opt('tail', '100')), replays: Number(opt('replays', '5')),
  sustainSizes: list(opt('sustain-sizes', '1000,5000,10000,20000')), sustainAppends: Number(opt('sustain-appends', '60')),
};
const base = opt('dir', tmpdir());
const out = opt('out', fileURLToPath(new URL('./results/sim-endurance.json', import.meta.url)));
let fsType = 'unknown';
try { fsType = execFileSync('findmnt', ['-n', '-o', 'FSTYPE', '-T', base], { encoding: 'utf8' }).trim(); } catch { /* not Linux */ }
if (fsType === 'tmpfs') console.error('WARNING: tmpfs makes fsync free; pass --dir on a real disk.');
const dir = await mkdtemp(join(base, 'sim-endurance-'));
const methodology = {
  kind: 'synthetic_local_disk_persistence_not_model_performance',
  node: process.version, platform: `${platform()} ${release()}`, arch: process.arch,
  cpu: cpus()[0]?.model, cpus: cpus().length, fsType, dir: base,
  syncPolicy: 'journal: fsync per acknowledged append (+dir fsync on create); checkpoint: temp+fsync+rename+dir fsync; snapshot(fsync): temp+fsync+rename+dir fsync per append; snapshot(unmodified SimMemory): temp+rename, no fsync',
  isolation: 'each arm in a fresh child process; arms sequential (shared device)',
  ci: '95% percentile bootstrap, 200 fixed-seed resamples (latency subsampled to <=20k points)',
  writeAmplification: 'app = bytes the code writes / logical record-line bytes; block = /proc/self/io write_bytes / logical bytes (Linux only)',
  config,
};
console.log(JSON.stringify(methodology, null, 2));
const results = { generatedFrom: 'bench/sim-endurance.mjs', generatedAt: new Date().toISOString(), methodology, endurance: [], replay: [], sustained: [] };
try {
  for (const records of config.records) {
    for (const every of [0, config.checkpointEvery]) {
      const r = child('armJournalAppend', { dir, records, checkpointEvery: every, tail: config.tail });
      console.error(`append ${r.arm} n=${records}: ${r.append.recordsPerSecond}/s p99 ${r.append.p99Ms}ms`);
      results.endurance.push(r);
      for (const checkpoints of every ? [true] : [false]) {
        const trials = Array.from({ length: config.replays }, () => child('armReplay', { file: r.file, checkpoints }));
        const ms = trials.map((t) => t.ms).sort((a, b) => a - b);
        results.replay.push({
          arm: r.arm, records, mode: checkpoints ? 'checkpoint' : 'full-verify', trials: trials.length,
          replayedRecords: trials[0].replayedRecords, checkpointRecords: trials[0].checkpointRecords,
          p50Ms: r3(pct(ms, 0.5)), p95Ms: r3(pct(ms, 0.95)), p99Ms: r3(pct(ms, 0.99)), minMs: r3(ms[0]), maxMs: r3(ms.at(-1)),
          meanCi95: bootstrap(ms, mean).map(r3), maxRssMb: Math.max(...trials.map((t) => t.maxRssMb)),
        });
      }
      await rm(r.file, { force: true });
    }
  }
  for (const history of config.sustainSizes) {
    const row = { history };
    for (const kind of ['journal', 'snapshot-fsync', 'snapshot']) {
      const r = child('armSustain', { dir, history, appends: config.sustainAppends, kind });
      row[kind] = r;
    }
    const j = row.journal.latencies;
    const s = row['snapshot-fsync'].latencies;
    if (j && s) {
      // Throughput ratio = mean snapshot latency / mean journal latency, CI by independent resampling.
      const ratios = [];
      for (let b = 0; b < 200; b++) {
        const pick = (xs) => mean(Array.from(xs, () => xs[(rand() * xs.length) | 0]));
        ratios.push(pick(s) / pick(j));
      }
      ratios.sort((a, b) => a - b);
      row.journalVsFsyncSnapshot = { speedup: +(mean(s) / mean(j)).toFixed(1), ci95: [+pct(ratios, 0.025).toFixed(1), +pct(ratios, 0.975).toFixed(1)] };
    }
    for (const kind of ['journal', 'snapshot-fsync', 'snapshot']) delete row[kind]?.latencies;
    console.error(`sustain H=${history}: ${JSON.stringify(row.journalVsFsyncSnapshot ?? row['snapshot-fsync'].skipped ?? row['snapshot-fsync'].error)}`);
    results.sustained.push(row);
  }
} finally { await rm(dir, { recursive: true, force: true }); }
results.notMeasured = [
  '1,000,000 records: SimJournal caps a journal at 100,000 records (MAX_RECORDS); raising it is out of scope',
  'snapshot at 100,000 records: the snapshot format caps at 16 MiB, far below 100k records',
  'power-loss durability and network filesystems',
];
await writeFile(out, JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ endurance: results.endurance.map(({ file, ...r }) => r), replay: results.replay, sustained: results.sustained }, null, 2));
