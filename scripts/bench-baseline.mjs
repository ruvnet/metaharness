#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/bench-baseline.mjs — performance regression detector.
//
// Reads a current bench report (JSON) and compares against a stored
// baseline. Fails CI if any tracked metric has degraded by more than
// the configured threshold. Useful as the gate downstream of
// iter-13's memory bench + iter-39's host-bench.
//
// Inputs:
//   --current=<path>    current bench-report.json (required)
//   --baseline=<path>   baseline to compare against (default: packages/bench/baseline.json)
//   --threshold=<pct>   max acceptable regression % (default 25)
//   --update            overwrite baseline with current (for re-baselining)
//
// Bench JSON shape this script understands:
//   memory bench:  { ndcg, recall, precision, ... } per config
//   host bench:    { iterations, results: [{ host, meanMs, p50Ms, p95Ms, ... }] }
//
// Each metric is auto-classified as "higher-is-better" (ndcg, recall,
// precision) or "lower-is-better" (latency); regression is computed
// accordingly.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

function log(tag, msg) { process.stderr.write(`[bench-baseline] ${tag}: ${msg}\n`); }

const HIGHER_IS_BETTER = new Set(['ndcg', 'recall', 'precision', 'mrr', 'hitrate']);

/**
 * Flatten a nested bench report into a list of {path, value, kind} entries.
 * kind = 'higher' or 'lower'.
 */
export function flattenMetrics(obj, prefix = '') {
  const out = [];
  if (obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      // For arrays of objects with a `host` or `name` key, use that as the
      // key; otherwise index. Keeps results stable.
      const key = obj[i]?.host ?? obj[i]?.name ?? String(i);
      out.push(...flattenMetrics(obj[i], prefix ? `${prefix}/${key}` : key));
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}/${k}` : k;
    if (typeof v === 'number') {
      const lower = HIGHER_IS_BETTER.has(k.toLowerCase()) ? 'higher' : (
        /ms|latency|cost|size|count|p\d|wall/i.test(k) ? 'lower' :
        'higher'  // default to higher-is-better for unknown keys
      );
      out.push({ path: p, value: v, kind: lower });
    } else if (v && typeof v === 'object') {
      out.push(...flattenMetrics(v, p));
    }
  }
  return out;
}

/**
 * Compare current vs baseline.
 * Returns an array of {path, baseline, current, deltaPct, regressed, kind}.
 */
export function compare(currentReport, baselineReport, thresholdPct) {
  const c = flattenMetrics(currentReport);
  const b = flattenMetrics(baselineReport);
  const byPath = new Map(b.map(m => [m.path, m]));
  const results = [];
  for (const cm of c) {
    const bm = byPath.get(cm.path);
    if (!bm) continue;
    if (bm.value === 0 && cm.value === 0) {
      results.push({ ...cm, baseline: bm.value, current: cm.value, deltaPct: 0, regressed: false });
      continue;
    }
    const delta = cm.value - bm.value;
    const deltaPct = bm.value === 0 ? Infinity : (delta / Math.abs(bm.value)) * 100;
    // For "lower is better", regression = positive delta; for "higher is better",
    // regression = negative delta.
    let regressed = false;
    if (cm.kind === 'lower') regressed = deltaPct > thresholdPct;
    else regressed = deltaPct < -thresholdPct;
    results.push({
      path: cm.path,
      baseline: bm.value,
      current: cm.value,
      deltaPct,
      regressed,
      kind: cm.kind,
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => args.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
  const flag = name => args.includes(`--${name}`);

  const ROOT = process.cwd();
  const current = arg('current');
  const baseline = arg('baseline') ?? 'packages/bench/baseline.json';
  const threshold = parseFloat(arg('threshold') ?? '25');
  const updateBaseline = flag('update');

  if (!current) {
    process.stderr.write('[bench-baseline] usage: --current=<bench.json> [--baseline=<base.json>] [--threshold=<pct>] [--update]\n');
    process.exit(2);
  }

  const currentPath = join(ROOT, current);
  if (!existsSync(currentPath)) {
    log('FAIL', `current bench report not found: ${currentPath}`);
    process.exit(1);
  }
  const currentReport = JSON.parse(await readFile(currentPath, 'utf-8'));
  const baselinePath = join(ROOT, baseline);

  if (updateBaseline) {
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(currentReport, null, 2) + '\n', 'utf-8');
    log('INFO', `baseline updated at ${baselinePath}`);
    return;
  }

  if (!existsSync(baselinePath)) {
    log('WARN', `no baseline at ${baselinePath} — establishing it from current`);
    await mkdir(dirname(baselinePath), { recursive: true });
    await writeFile(baselinePath, JSON.stringify(currentReport, null, 2) + '\n', 'utf-8');
    log('INFO', 'baseline established; future runs will compare against it');
    return;
  }

  const baselineReport = JSON.parse(await readFile(baselinePath, 'utf-8'));
  const results = compare(currentReport, baselineReport, threshold);

  const regressions = results.filter(r => r.regressed);
  log('INFO', `checked ${results.length} metric(s), threshold ${threshold}%`);
  if (regressions.length === 0) {
    log('PASS', 'no regressions detected');
    process.exit(0);
  }
  for (const r of regressions.slice(0, 10)) {
    const sign = r.deltaPct > 0 ? '+' : '';
    log('FAIL', `${r.path}: ${r.baseline} -> ${r.current} (${sign}${r.deltaPct.toFixed(1)}% ${r.kind === 'lower' ? 'slower' : 'lower-quality'})`);
  }
  log('FAIL', `${regressions.length} regression(s) > ${threshold}% threshold`);
  process.exit(1);
}

// Only run main when invoked as a CLI; not when imported as a module.
const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || (typeof process.argv[1] === 'string' && process.argv[1].endsWith('bench-baseline.mjs'));
if (isMain) {
  main().catch(err => {
    log('FAIL', err?.stack ?? err);
    process.exit(1);
  });
}
