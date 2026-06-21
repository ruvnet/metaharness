// SPDX-License-Identifier: MIT
//
// MULTI-SEED gate for the ADR-167 frontier-lane recommendation. Runs each model on
// the 6 hard discovery functions K times (temperature 0.8 → sampling variance),
// records verified/not per (function, seed) cell, and uses the package's seeded
// paired bootstrap to test whether the new default (Qwen3-235B) is statistically
// NOT WORSE than GLM-5.2 (lower95 of qwen−glm ≥ 0) — at far lower cost. Optional/
// key-gated, bounded, defensive. Single sweep (still small N), but no longer a
// single-run anecdote.
//
// Run: node bench/frontier-multiseed.bench.mjs   (K via env SEEDS, default 4)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, bootstrapDelta, round6 } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) { process.stdout.write('OPENROUTER_API_KEY absent — skipping.\n'); process.exit(0); }

const SOURCE = `def chunk_size(total, parts):
    return total // parts
def parse_pair(s):
    a, b = s.split("-"); return int(a) + int(b)
def nth_last(xs, k):
    return xs[len(xs) - k]
def from_hex(s):
    return bytes.fromhex(s)
def to_ints(s):
    return [int(x) for x in s.split(",")]
def ratio_at(xs, i, j):
    return xs[i] / xs[j]
`;
const FUNCS = ['chunk_size', 'parse_pair', 'nth_last', 'from_hex', 'to_ints', 'ratio_at'];
const K = +(process.env.SEEDS || 4);
const MODELS = [
  { id: 'qwen/qwen3-235b-a22b-2507', in: 0.09, out: 0.10 },   // new default frontier lane
  { id: 'z-ai/glm-5.2', in: 1.2, out: 4.1 },                  // prior default (incumbent)
  { id: 'deepseek/deepseek-v3.2', in: 0.23, out: 0.34 },      // co-winner
];

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'ms-'));
  const file = join(dir, 'c.py');
  writeFileSync(file, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception as e:\n    print(json.dumps({"t":True}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(out.trim().split('\n').pop()).t === true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function sample(client, fn) {
  let args = null;
  try {
    const r = await client.chatJSON([
      { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
      { role: 'user', content: `Give ONE concrete argument list that makes \`${fn}\` raise an unhandled exception. Return {"args":[...]}.\n\n${SOURCE}` },
    ], { maxTokens: 200 });
    const p = tryParseJson(r.raw);
    args = p && Array.isArray(p.args) ? p.args : null;
  } catch { args = null; }
  return args ? verify(fn, args) : false;
}

// cells[model] = array of 0/1 over (func × seed), aligned by index for pairing.
const cells = {};
const cost = {};
for (const m of MODELS) {
  const client = new OpenRouterClient({ model: m.id, maxRequests: FUNCS.length * K + 2, temperature: 0.8 });
  const bits = [];
  for (const fn of FUNCS) for (let k = 0; k < K; k += 1) bits.push((await sample(client, fn)) ? 1 : 0);
  cells[m.id] = bits;
  const s = client.stats();
  cost[m.id] = round6(((s.promptTokens / 1e6) * m.in + (s.completionTokens / 1e6) * m.out) * 1000);
}

const N = FUNCS.length * K;
const rate = (id) => round6(cells[id].reduce((a, b) => a + b, 0) / N);
const qwen = 'qwen/qwen3-235b-a22b-2507';
const glm = 'z-ai/glm-5.2';
// Paired bootstrap: delta = qwen − glm per cell. lower95 ≥ 0 ⇒ qwen not worse.
const boot = bootstrapDelta(cells[glm], cells[qwen], { seed: 1 });
const verifiedRate = Object.fromEntries(MODELS.map((m) => [m.id, rate(m.id)]));
const costPerVerified = Object.fromEntries(MODELS.map((m) => {
  const v = cells[m.id].reduce((a, b) => a + b, 0);
  return [m.id, v ? round6(cost[m.id] / v) : null];
}));

const verdict = boot.lower95 >= 0 && verifiedRate[qwen] >= verifiedRate[glm] && (costPerVerified[qwen] ?? 1e9) < (costPerVerified[glm] ?? 0);
const receipt = {
  experiment: 'multi-seed gate for ADR-167 frontier-lane swap (Qwen3-235B vs GLM-5.2)',
  functions: FUNCS.length, seedsPerFunction: K, cellsPerModel: N,
  verifiedRate, costPerVerifiedMilliUSD: costPerVerified, totalCostMilliUSD: cost,
  pairedBootstrap_qwenMinusGlm: boot,
  recommendationConfirmed: verdict,
  note: 'Sampling variance via temperature 0.8; paired by (function,seed) cell. lower95 ≥ 0 ⇒ Qwen3-235B is not statistically worse than GLM-5.2; combined with far lower cost-per-verified this confirms the ADR-167 default. N is still modest.',
};
writeFileSync(join(here, 'results', 'frontier-multiseed.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Multi-seed frontier gate (${FUNCS.length} funcs × ${K} seeds = ${N} cells)\n`);
for (const m of MODELS) process.stdout.write(`  ${m.id.padEnd(28)} verified-rate ${verifiedRate[m.id]}  cost/verified ${costPerVerified[m.id] ?? 'n/a'} mUSD\n`);
process.stdout.write(`  paired bootstrap qwen−glm: meanDelta ${boot.meanDelta}, lower95 ${boot.lower95}, p ${boot.pValue}\n`);
process.stdout.write(`  ADR-167 recommendation confirmed: ${verdict}\n`);
process.stdout.write(`  receipt → bench/results/frontier-multiseed.json\n`);
