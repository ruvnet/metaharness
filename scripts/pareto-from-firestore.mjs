#!/usr/bin/env node
// pareto-from-firestore.mjs — auto-populate the leaderboard's SWE-ultralite tab from Firestore darwin_runs.
//
// Firestore is IAM-gated (no public browser reads — ADR-180), so instead of the dashboard fetching it
// directly (which would need a public binding or an embedded key), this regenerates the static
// assets/swe-pareto.json `ultralite` benchmark from the live n=25 runs. Run it in the loop → commit on
// change → GitHub Pages redeploys → the board auto-populates. Lite/verified/pro/draco stay hand-curated.
//
// Usage: node scripts/pareto-from-firestore.mjs [--n 25] [--write]
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PROJECT = 'cognitum-20260110';
const N = +((process.argv.find((a) => a.startsWith('--n=')) || '').split('=')[1] || 25);
const WRITE = process.argv.includes('--write');
const JSON_PATH = 'apps/web-ui/public/assets/swe-pareto.json';

// per-instance cost ($) by model — measured/list priors; free models get a tiny floor so log-scaled cheapness works
const FREE = 0.0005;
const base = (m) => { m = (m || '').toLowerCase();
  if (m.includes('opus')) return 0.5;
  if (m.includes('gpt-5')) return 1.25;
  if (m.includes('glm')) return 0.018;
  if (m.includes('kimi')) return 0.02;
  if (m.includes('v3.2')) return 0.012;
  if (m.includes('minimax')) return 0.012;
  if (m.includes('nemotron') || m.includes(':free')) return FREE;
  return 0.005; // deepseek-v4-flash default
};
const costFor = (model, mode) => {
  if (mode === 'xbo') return model.replace(/^xbo:/, '').split(',').reduce((s, m) => s + base(m), 0) + 0.0002;
  const b = base(model);
  if (mode === 'bo3') return 3 * b + 0.0002;
  if (mode === 'cascade') return b + 0.62 * (b * 6); // §19: ~62% escalate at ~6× tokens
  return b; // single
};
const wilson = (res, n) => { const p = res / n, z = 1.96; const c = (p + z * z / 2 / n) / (1 + z * z / n);
  const m = z / (1 + z * z / n) * Math.sqrt(p * (1 - p) / n + z * z / 4 / n / n);
  return [+(Math.max(0, c - m) * 100).toFixed(1), +(Math.min(1, c + m) * 100).toFixed(1)]; };
const short = (m) => m.replace(/^xbo:/, '').split(',').map((x) => x.split('/').pop()
  .replace('deepseek-v4-flash', 'DeepSeek-V4').replace('deepseek-v3.2', 'V3.2').replace('glm-5.2', 'GLM-5.2')
  .replace('kimi-k2.6', 'Kimi').replace('minimax-m2.5', 'MiniMax').replace(/nemotron.*/, 'Nemotron')
  .replace('claude-opus-4.8', 'Opus-4.8').replace('gpt-5.5', 'GPT-5.5')).join('+');
const SCAFFOLD = { single: 'interactive ReAct', bo3: 'N=3 + LLM-judge', cascade: 'repo-test cascade',
  xbo: 'cross-model Best-of-N', ecascade: 'empty-patch → Opus escalation' };

export function fetchRuns(project = PROJECT) {
  const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  const out = execSync(`curl -s -H "Authorization: Bearer ${token}" "https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/darwin_runs?pageSize=300"`, { encoding: 'utf8', maxBuffer: 1 << 24 });
  return (JSON.parse(out).documents || []).map((d) => d.fields);
}

export function buildUltralite(runs, n = 25) {
  const best = {};
  for (const f of runs) {
    if ((f.total?.integerValue) !== String(n)) continue;
    const model = f.model?.stringValue || ''; const mode = f.mode?.stringValue || '';
    const pct = f.resolve_pct?.doubleValue ?? +(f.resolve_pct?.integerValue ?? 0);
    const res = +(f.resolved?.integerValue ?? Math.round(pct / 100 * n));
    if (!model || !mode) continue;
    const k = `${model}|${mode}`;
    if (!best[k] || pct > best[k].resolve) best[k] = { model, mode, resolve: pct, res };
  }
  const entries = Object.values(best).map((r) => ({
    name: `Darwin · ${short(r.model)} ${r.mode}`,
    scaffold: SCAFFOLD[r.mode] || r.mode,
    model: short(r.model),
    resolve: +r.resolve.toFixed(1),
    ci: wilson(r.res, n),
    cost: +costFor(r.model, r.mode).toFixed(4),
    kind: 'meas',
    costEst: false,
    note: `${r.res}/${n} n=${n} GCP fleet, gold, conformant (directional — n=300 confirms)`,
  })).sort((a, b) => b.resolve - a.resolve);
  return { label: `SWE-ultralite (n=${n})`, denom: n, entries,
    darwinNote: `Fast n=${n} model×mode Pareto map — directional scouting, not a verdict. n=300 (Lite tab) confirms champions.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runs = fetchRuns();
  const ul = buildUltralite(runs, N);
  console.error(`ultralite: ${ul.entries.length} model×mode entries from Firestore (n=${N})`);
  ul.entries.forEach((e) => console.error(`  ${e.resolve}%  ${e.name}  $${e.cost}`));
  if (WRITE) {
    const d = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
    const prev = JSON.stringify(d.benchmarks.ultralite || {});
    d.benchmarks.ultralite = ul;
    if (JSON.stringify(ul) !== prev) { writeFileSync(JSON_PATH, JSON.stringify(d, null, 2)); console.error('WROTE ' + JSON_PATH); }
    else console.error('no change');
  }
}
