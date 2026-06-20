// SPDX-License-Identifier: MIT
//
// Does the open-frontier (GLM) lane EARN its cost on HARD discovery tasks? This
// benchmark isolates the proposer: subtle, input-specific crashes that need real
// reasoning to trigger. For each function we ask the cheap model AND GLM-5.2 to
// propose a concrete crashing input, then VERIFY by execution. We report what each
// lane verifies, what GLM RECOVERS that the cheap model misses, and cost-per-
// verified-finding for cheap-only / frontier-only / escalation (cheap→GLM on miss).
//
// Optional (skips without OPENROUTER_API_KEY), bounded caps, key from env only,
// strictly defensive (proves a crash exists; proof inputs not emitted).
// Run: SEMGREP_BIN unused here. node bench/proposer-bakeoff.bench.mjs

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping proposer bake-off.\n');
  process.exit(0);
}

// Inert fixture: subtle non-total functions (the crash needs a SPECIFIC input) + a
// robust control. These are harder than b==0 — they need reasoning to trigger.
const SOURCE = `def chunk_size(total, parts):
    return total // parts                 # ZeroDivisionError when parts == 0

def parse_pair(s):
    a, b = s.split("-")                   # ValueError if no single '-'
    return int(a) + int(b)                # ValueError if parts aren't ints

def nth_last(xs, k):
    return xs[len(xs) - k]                # IndexError off-by-one when k == 0 (or k > len)

def merge(a, b):
    return {**a, **b}                     # TypeError if a or b is None

def from_hex(s):
    return bytes.fromhex(s)               # ValueError on odd-length / non-hex

def clamp(x, lo, hi):
    return max(lo, min(x, hi))            # robust control — should NOT crash
`;

const FUNCS = ['chunk_size', 'parse_pair', 'nth_last', 'merge', 'from_hex', 'clamp'];
const CHEAP = process.env.CHEAP_MODEL || 'qwen/qwen-2.5-7b-instruct';
const FRONTIER = process.env.FRONTIER_MODEL || 'z-ai/glm-5.2';
const PRICING = { [CHEAP]: { in: 0.04, out: 0.1 }, [FRONTIER]: { in: 1.2, out: 4.1 } };

const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: 8, temperature: 0 });
const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: 8, temperature: 0 });
const costMilliUSD = (cl) => {
  const s = cl.stats();
  const p = PRICING[cl.model] ?? { in: 0, out: 0 };
  return ((s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out) * 1000;
};

async function propose(client, fn) {
  const r = await client.chatJSON([
    { role: 'system', content: 'You are a precise security analyst. Output ONLY JSON.' },
    { role: 'user', content: `In this Python module, give ONE concrete argument list that makes \`${fn}\` raise an UNHANDLED exception. Return JSON {"args": [...]} (a JSON array of the positional arguments). If impossible, return {"args": null}.\n\n${SOURCE}` },
  ], { maxTokens: 200 });
  const p = tryParseJson(r.raw);
  return p && Array.isArray(p.args) ? p.args : null;
}

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-'));
  const file = join(dir, 'c.py');
  writeFileSync(file, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception as e:\n    print(json.dumps({"t":True,"e":type(e).__name__}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    const res = JSON.parse(out.trim().split('\n').pop());
    return { triggered: res.t === true, evidenceClass: res.e };
  } catch { return { triggered: false }; } finally { rmSync(dir, { recursive: true, force: true }); }
}

const per = [];
for (const fn of FUNCS) {
  const ca = await propose(cheap, fn);
  const cheapV = ca ? verify(fn, ca) : { triggered: false };
  const fa = await propose(frontier, fn);
  const frontierV = fa ? verify(fn, fa) : { triggered: false };
  per.push({ fn, cheap: cheapV.triggered, cheapClass: cheapV.evidenceClass ?? null, frontier: frontierV.triggered, frontierClass: frontierV.evidenceClass ?? null, recoveredByFrontier: frontierV.triggered && !cheapV.triggered });
}

const cheapVerified = per.filter((p) => p.cheap).length;
const frontierVerified = per.filter((p) => p.frontier).length;
const recovered = per.filter((p) => p.recoveredByFrontier).length;
const cheapCost = costMilliUSD(cheap);
const frontierCost = costMilliUSD(frontier);
// Escalation lane: cheap for all; GLM only for the ones cheap missed. Verified =
// cheap-verified ∪ frontier-recovered; cost = cheapCost + (GLM cost for the misses).
const escalationVerified = per.filter((p) => p.cheap || p.recoveredByFrontier).length;
const cpp = (cost, v) => (v > 0 ? +(cost / v).toFixed(4) : null);

const receipt = {
  experiment: 'proposer bake-off on HARD discovery tasks — does the frontier lane earn its cost?',
  cheapModel: CHEAP, frontierModel: FRONTIER, functions: FUNCS.length,
  perFunction: per,
  cheapVerified, frontierVerified, recoveredByFrontier: recovered,
  cost: { cheapMilliUSD: +cheapCost.toFixed(3), frontierMilliUSD: +frontierCost.toFixed(3) },
  costPerVerifiedMilliUSD: {
    cheapOnly: cpp(cheapCost, cheapVerified),
    frontierOnly: cpp(frontierCost, frontierVerified),
    escalation: cpp(cheapCost + frontierCost * (recovered / Math.max(1, FUNCS.length)), escalationVerified),
  },
  note: 'Real LLM calls, single non-deterministic run. "Verified" = the proposed input actually crashes the function (execution-confirmed). clamp is a robust control and should be verified by NEITHER lane.',
};
writeFileSync(join(here, 'results', 'proposer-bakeoff.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Proposer bake-off on ${FUNCS.length} HARD functions (cheap=${CHEAP}, frontier=${FRONTIER})\n`);
for (const p of per) process.stdout.write(`   ${p.fn.padEnd(11)} cheap=${p.cheap ? '✅ ' + p.cheapClass : '❌'}  frontier=${p.frontier ? '✅ ' + p.frontierClass : '❌'}${p.recoveredByFrontier ? '  ← RECOVERED by frontier' : ''}\n`);
process.stdout.write(`  cheap verified ${cheapVerified}/${FUNCS.length} ($${receipt.costPerVerifiedMilliUSD.cheapOnly}/v) | frontier ${frontierVerified}/${FUNCS.length} ($${receipt.costPerVerifiedMilliUSD.frontierOnly}/v) | recovered by frontier: ${recovered}\n`);
process.stdout.write(`  receipt → bench/results/proposer-bakeoff.json\n`);
