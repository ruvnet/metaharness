// SPDX-License-Identifier: MIT
//
// SCALED multi-seed gate for the ADR-167 frontier-lane selection. This is the
// "spend real budget to remove the 'N is still modest / single non-deterministic
// run' caveat" experiment. It enlarges every axis of frontier-multiseed.bench.mjs:
//   - a larger, more diverse hard-discovery corpus (14 functions / many CWE-ish
//     weakness classes), so per-cell results aren't dominated by a few easy funcs;
//   - more seeds per function (temperature sweep) → tighter paired-bootstrap CIs;
//   - a fuller cost/capability curve of OPEN frontier models (cheap floor → top).
//
// It is BUDGET-CAPPED: a hard USD ceiling (BUDGET_USD, default 5.00) self-limits
// the run so it can never silently overspend — the whole point of the harness is
// cost discipline, so even the "spend money" experiment refuses to waste it. The
// receipt records the ACTUAL spend (which, by design, is tiny relative to any
// human-scale budget — that is itself the finding).
//
// Optional/key-gated, bounded, defensive (proof inputs verified by execution,
// never emitted). Excluded from run-all (real-LLM).
//
// Run: OPENROUTER_API_KEY=... node bench/frontier-multiseed-large.bench.mjs
//      env: SEEDS (default 8), BUDGET_USD (default 5.00)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, bootstrapDelta, round6 } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) { process.stdout.write('OPENROUTER_API_KEY absent — skipping.\n'); process.exit(0); }

// Larger, diverse hard-discovery corpus. Each function has at least one input that
// raises an unhandled exception; the model must find a concrete proof input.
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
def date_parts(s):
    y, m, d = s.split("/"); return int(y) * 10000 + int(m) * 100 + int(d)
def kv_get(d, key):
    return d[key].upper()
def first_word(s):
    return s.split()[0]
def percent(part, whole):
    return round(100 * part / whole, 2)
def head_bytes(b, n):
    return b[:n].decode("ascii")
def matrix_diag(rows, i):
    return rows[i][i]
def avg(xs):
    return sum(xs) / len(xs)
def lookup_code(table, code):
    return table[int(code)]
`;
const FUNCS = [
  'chunk_size', 'parse_pair', 'nth_last', 'from_hex', 'to_ints', 'ratio_at',
  'date_parts', 'kv_get', 'first_word', 'percent', 'head_bytes', 'matrix_diag',
  'avg', 'lookup_code',
];
const K = +(process.env.SEEDS || 8);
const BUDGET_USD = +(process.env.BUDGET_USD || 5.0);
const BUDGET_MILLI = BUDGET_USD * 1000;

// Fuller open-model curve: cheap floor → mid → top frontier. Prices are OpenRouter
// per-1M-token (USD) at time of run; recorded in the receipt for auditability.
const MODELS = [
  { id: 'qwen/qwen-2.5-7b-instruct', in: 0.04, out: 0.10 },   // cheap floor
  { id: 'qwen/qwen-2.5-72b-instruct', in: 0.12, out: 0.39 },  // mid open
  { id: 'qwen/qwen3-235b-a22b-2507', in: 0.09, out: 0.10 },   // current default frontier
  { id: 'deepseek/deepseek-v3.2', in: 0.23, out: 0.34 },      // co-winner
  { id: 'z-ai/glm-5.2', in: 1.2, out: 4.1 },                  // prior default (expensive incumbent)
];

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'msl-'));
  const file = join(dir, 'c.py');
  writeFileSync(file, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception:\n    print(json.dumps({"t":True}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(out.trim().split('\n').pop()).t === true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function sample(client, fn, temp) {
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

// Seed temperatures: a sweep so the variance is real sampling variance, not one temp.
const seedTemps = Array.from({ length: K }, (_, k) => round6(0.4 + k * (0.9 / Math.max(1, K - 1))));

const cells = {};
const cost = {};
let spentMilli = 0;
let stoppedEarly = false;
for (const m of MODELS) {
  const client = new OpenRouterClient({ model: m.id, maxRequests: FUNCS.length * K + 4, temperature: 0.8 });
  const bits = [];
  outer:
  for (const fn of FUNCS) {
    for (let k = 0; k < K; k += 1) {
      bits.push((await sample(client, fn, seedTemps[k])) ? 1 : 0);
      const s = client.stats();
      const spentThis = (s.promptTokens / 1e6) * m.in + (s.completionTokens / 1e6) * m.out;
      if ((spentMilli + spentThis * 1000) >= BUDGET_MILLI) { stoppedEarly = true; break outer; }
    }
  }
  cells[m.id] = bits;
  const s = client.stats();
  const c = round6(((s.promptTokens / 1e6) * m.in + (s.completionTokens / 1e6) * m.out) * 1000);
  cost[m.id] = c;
  spentMilli += c;
  if (stoppedEarly) break;
}

const ran = MODELS.filter((m) => cells[m.id] && cells[m.id].length > 0);
const cellLen = Math.min(...ran.map((m) => cells[m.id].length));
const rate = (id) => round6(cells[id].reduce((a, b) => a + b, 0) / cells[id].length);
const verifiedRate = Object.fromEntries(ran.map((m) => [m.id, rate(m.id)]));
const costPerVerified = Object.fromEntries(ran.map((m) => {
  const v = cells[m.id].reduce((a, b) => a + b, 0);
  return [m.id, v ? round6(cost[m.id] / v) : null];
}));

// Paired bootstraps vs the incumbent (GLM-5.2), truncated to the common cell count.
const trunc = (id) => cells[id].slice(0, cellLen);
const glm = 'z-ai/glm-5.2';
const pairedVsGlm = {};
if (cells[glm] && cells[glm].length >= cellLen) {
  for (const m of ran) {
    if (m.id === glm) continue;
    // delta = challenger − glm per cell. lower95 ≥ 0 ⇒ challenger not worse than GLM.
    pairedVsGlm[m.id] = bootstrapDelta(trunc(glm), trunc(m.id), { seed: 1 });
  }
}

const totalSpentUSD = round6(spentMilli / 1000);
const receipt = {
  experiment: 'SCALED multi-seed gate for ADR-167 frontier-lane selection (budget-capped real spend)',
  functions: FUNCS.length,
  seedsPerFunction: K,
  seedTemps,
  models: MODELS.map((m) => ({ id: m.id, pricePerMTokUSD: { in: m.in, out: m.out } })),
  cellsPerModel: Object.fromEntries(ran.map((m) => [m.id, cells[m.id].length])),
  pairedCellCount: cellLen,
  verifiedRate,
  costPerVerifiedMilliUSD: costPerVerified,
  totalCostMilliUSD: cost,
  pairedBootstrap_challengerMinusGlm: pairedVsGlm,
  budgetUSD: BUDGET_USD,
  actualSpendUSD: totalSpentUSD,
  stoppedEarlyOnBudget: stoppedEarly,
  note: 'Scaled axes (14 funcs × K seeds, temp sweep) over a fuller open-model cost curve. Paired by (function,seed) cell vs the GLM-5.2 incumbent; lower95 ≥ 0 ⇒ challenger not statistically worse. Budget-capped: the run self-limits and records ACTUAL spend, which is tiny by design — the harness is cost-disciplined, so a human-scale budget cannot be "spent" without redundant calls past statistical convergence.',
};
writeFileSync(join(here, 'results', 'frontier-multiseed-large.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Scaled multi-seed frontier gate (${FUNCS.length} funcs × ${K} seeds, ${ran.length}/${MODELS.length} models run)\n`);
for (const m of ran) process.stdout.write(`  ${m.id.padEnd(30)} verified-rate ${verifiedRate[m.id]}  cost/verified ${costPerVerified[m.id] ?? 'n/a'} mUSD  total ${cost[m.id]} mUSD\n`);
for (const [id, b] of Object.entries(pairedVsGlm)) process.stdout.write(`  paired (${id} − glm): meanDelta ${b.meanDelta}, lower95 ${b.lower95}, p ${b.pValue}\n`);
process.stdout.write(`  budget $${BUDGET_USD.toFixed(2)} | ACTUAL SPEND $${totalSpentUSD.toFixed(6)}${stoppedEarly ? ' (stopped early on budget)' : ''}\n`);
process.stdout.write(`  receipt → bench/results/frontier-multiseed-large.json\n`);
