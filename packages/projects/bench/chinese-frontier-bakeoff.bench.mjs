// SPDX-License-Identifier: MIT
//
// Frontier-Chinese-model bake-off for the discovery PROPOSER lane: which open/
// Chinese frontier model best proposes a VERIFIED crashing input on a hard corpus,
// at the lowest cost per verified finding? Isolates the proposer: 6 genuine edge-
// case bugs; each model proposes one crashing input per function, confirmed by
// execution. Ranked by verified, then cost-per-verified. Optional (skips without
// key), bounded caps, defensive, single non-deterministic run.
//
// Run: node bench/chinese-frontier-bakeoff.bench.mjs   (override list via MODELS=csv)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) { process.stdout.write('OPENROUTER_API_KEY absent — skipping.\n'); process.exit(0); }

// 6 genuine, input-specific edge-case crashes (no trivial wrong-type controls).
const SOURCE = `def chunk_size(total, parts):
    return total // parts                       # ZeroDivisionError when parts == 0
def parse_pair(s):
    a, b = s.split("-"); return int(a) + int(b) # ValueError on malformed pair
def nth_last(xs, k):
    return xs[len(xs) - k]                       # IndexError off-by-one when k == 0
def from_hex(s):
    return bytes.fromhex(s)                      # ValueError on odd-length / non-hex
def to_ints(s):
    return [int(x) for x in s.split(",")]        # ValueError on a non-integer element
def ratio_at(xs, i, j):
    return xs[i] / xs[j]                         # IndexError or ZeroDivisionError
`;
const FUNCS = ['chunk_size', 'parse_pair', 'nth_last', 'from_hex', 'to_ints', 'ratio_at'];

// Pricing ($/M in,out) for cost math (from OpenRouter at time of writing).
const MODELS = (process.env.MODELS ? process.env.MODELS.split(',') : [
  'deepseek/deepseek-v3.2',
  'qwen/qwen3-235b-a22b-2507',
  'moonshotai/kimi-k2.5',
  'minimax/minimax-m2.5',
  'z-ai/glm-4.7-flash',
  'z-ai/glm-5.2',
]);
const PRICING = {
  'deepseek/deepseek-v3.2': { in: 0.23, out: 0.34 },
  'qwen/qwen3-235b-a22b-2507': { in: 0.09, out: 0.10 },
  'moonshotai/kimi-k2.5': { in: 0.38, out: 2.02 },
  'minimax/minimax-m2.5': { in: 0.15, out: 0.90 },
  'z-ai/glm-4.7-flash': { in: 0.06, out: 0.40 },
  'z-ai/glm-5.2': { in: 1.2, out: 4.1 },
};

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-'));
  const file = join(dir, 'c.py');
  writeFileSync(file, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception as e:\n    print(json.dumps({"t":True,"e":type(e).__name__}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    const r = JSON.parse(out.trim().split('\n').pop());
    return { triggered: r.t === true, evidenceClass: r.e };
  } catch { return { triggered: false }; } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function evalModel(model) {
  const client = new OpenRouterClient({ model, maxRequests: 8, temperature: 0, timeoutMs: 90_000 });
  let verified = 0;
  const classes = [];
  for (const fn of FUNCS) {
    let args = null;
    try {
      const r = await client.chatJSON([
        { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
        { role: 'user', content: `Give ONE concrete argument list that makes \`${fn}\` raise an unhandled exception. Return {"args":[...]}.\n\n${SOURCE}` },
      ], { maxTokens: 220 });
      const p = tryParseJson(r.raw);
      args = p && Array.isArray(p.args) ? p.args : null;
    } catch { args = null; }
    const v = args ? verify(fn, args) : { triggered: false };
    if (v.triggered) { verified += 1; classes.push(v.evidenceClass); }
  }
  const s = client.stats();
  const p = PRICING[model] ?? { in: 0, out: 0 };
  const costMilliUSD = ((s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out) * 1000;
  return { model, verified, of: FUNCS.length, costMilliUSD: +costMilliUSD.toFixed(4), costPerVerifiedMilliUSD: verified ? +(costMilliUSD / verified).toFixed(4) : null, classes };
}

const rows = [];
for (const m of MODELS) {
  try { rows.push(await evalModel(m)); }
  catch (e) { rows.push({ model: m, verified: 0, of: FUNCS.length, costMilliUSD: 0, costPerVerifiedMilliUSD: null, error: String(e).slice(0, 120) }); }
}
// Rank: most verified, then cheapest per verified.
rows.sort((a, b) => b.verified - a.verified || ((a.costPerVerifiedMilliUSD ?? 1e9) - (b.costPerVerifiedMilliUSD ?? 1e9)));

const receipt = { experiment: 'frontier Chinese model bake-off — discovery proposer (verified per cost)', functions: FUNCS.length, models: rows, note: 'Real LLM calls, single non-deterministic run. "verified" = proposed input actually crashes the function (execution-confirmed). Cost from token usage × OpenRouter pricing.' };
writeFileSync(join(here, 'results', 'chinese-frontier-bakeoff.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Frontier Chinese model bake-off (proposer, ${FUNCS.length} hard functions)\n`);
for (const r of rows) process.stdout.write(`  ${String(r.verified) + '/' + r.of} ${r.model.padEnd(30)} ${r.costMilliUSD} mUSD → ${r.costPerVerifiedMilliUSD ?? 'n/a'}/verified${r.error ? '  [' + r.error + ']' : ''}\n`);
process.stdout.write(`  receipt → bench/results/chinese-frontier-bakeoff.json\n`);
