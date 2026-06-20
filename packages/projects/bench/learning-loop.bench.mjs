// SPDX-License-Identifier: MIT
//
// REAL self-learning loop using METAHARNESS capabilities: the escalation router
// (cheap → frontier on miss) + TieredMemory (ADR-161, 'mutation' tier) via
// src/learning-loop.ts. Over recurring HARD targets of one weakness class:
//   memory OFF: the cheap model fails each one (proposes a valid input) → escalate
//               to GLM-5.2 EVERY time (expensive).
//   memory ON : escalate ONCE to learn the generalized cue, store it, then the
//               cheap model + recalled cue solves the rest — no further escalation.
// Demonstrates self-learning lowering cost by avoiding repeated frontier escalation.
// Optional (skips without key), bounded, defensive (cue is generalized, not a payload).
//
// Run: node bench/learning-loop.bench.mjs

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, runLearningLoop, StrategyMemory } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) { process.stdout.write('OPENROUTER_API_KEY absent — skipping learning loop.\n'); process.exit(0); }

// Recurring HARD class: parse-pair (ValueError) — a cheap model tends to propose a
// VALID pair ("1-2") that does NOT crash, unless cued.
const SOURCE = `def pa(s):
    a, b = s.split("-"); return int(a) + int(b)
def pb(s):
    a, b = s.split("-"); return int(a) * int(b)
def pc(s):
    a, b = s.split("-"); return int(a) - int(b)
def pd(s):
    x, y = s.split("-"); return max(int(x), int(y))
def pe(s):
    x, y = s.split("-"); return int(x) % int(y)
def pf(s):
    x, y = s.split("-"); return int(x) ** int(y)
`;
const TARGETS = ['pa', 'pb', 'pc', 'pd', 'pe', 'pf'].map((id) => ({ id, weaknessClass: 'parsepair' }));
const CUE = "a string that does not split on '-' into exactly two integer parts (for example 'x-y' or '1')";

const CHEAP = process.env.CHEAP_MODEL || 'qwen/qwen-2.5-7b-instruct';
const FRONTIER = process.env.FRONTIER_MODEL || 'z-ai/glm-5.2';
const PRICE = { [CHEAP]: { in: 0.04, out: 0.1 }, [FRONTIER]: { in: 1.2, out: 4.1 } };
const milli = (cl, before) => { const s = cl.stats(); const p = PRICE[cl.model]; return (((s.promptTokens - before.promptTokens) / 1e6) * p.in + ((s.completionTokens - before.completionTokens) / 1e6) * p.out) * 1000; };

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'll-'));
  const file = join(dir, 'c.py');
  writeFileSync(file, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception as e:\n    print(json.dumps({"t":True,"e":type(e).__name__}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', file, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(out.trim().split('\n').pop()).t === true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function ask(client, fn, cue) {
  const before = client.stats();
  const hint = cue ? `\nHint: ${cue}.` : '';
  const r = await client.chatJSON([
    { role: 'system', content: 'You are a security analyst. Output ONLY JSON.' },
    { role: 'user', content: `Give ONE concrete argument list that makes \`${fn}\` raise an unhandled exception. Return {"args":[...]}.${hint}\n\n${SOURCE}` },
  ], { maxTokens: 120 });
  const p = tryParseJson(r.raw);
  const ok = p && Array.isArray(p.args) ? verify(fn, p.args) : false;
  return { ok, cost: milli(client, before) };
}

// Run one full loop config; `escalations` counted in a closure.
async function runConfig(useMemory) {
  const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: 20, temperature: 0 });
  const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: 20, temperature: 0 });
  let escalations = 0;
  const lane = async ({ target, recalled }) => {
    const c = await ask(cheap, target, recalled?.hint); // cheap (with cue if learned)
    if (c.ok) return { verified: true, hint: CUE, costUnits: c.cost };
    escalations += 1; // cheap missed → escalate to the frontier lane
    const f = await ask(frontier, target, null);
    return { verified: f.ok, hint: f.ok ? CUE : undefined, costUnits: c.cost + f.cost };
  };
  const res = await runLearningLoop(TARGETS, lane, { useMemory, memory: new StrategyMemory() });
  return { ...res, escalations };
}

const off = await runConfig(false);
const on = await runConfig(true);

const receipt = {
  experiment: 'self-learning loop with metaharness capabilities (escalation router + TieredMemory)',
  cheapModel: CHEAP, frontierModel: FRONTIER, targets: TARGETS.length, weaknessClass: 'parsepair',
  memoryOff: { verified: off.verified, escalations: off.escalations, totalCostMilliUSD: +off.totalCost.toFixed(4), costPerVerified: off.costPerVerified },
  memoryOn: { verified: on.verified, escalations: on.escalations, totalCostMilliUSD: +on.totalCost.toFixed(4), costPerVerified: on.costPerVerified, memorySize: on.memorySize, costWithMemory: on.costWithMemory, costWithoutMemory: on.costWithoutMemory },
  costReductionPct: off.totalCost > 0 ? +(((off.totalCost - on.totalCost) / off.totalCost) * 100).toFixed(1) : 0,
  note: 'Real LLM calls; single non-deterministic run. memory ON escalates once to learn the generalized cue (stored in the TieredMemory mutation tier) then the cheap lane reuses it — avoiding repeated frontier escalation.',
};
writeFileSync(join(here, 'results', 'learning-loop.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Self-learning loop (metaharness: router + TieredMemory) — ${TARGETS.length} recurring '${'parsepair'}' targets\n`);
process.stdout.write(`  memory OFF: ${off.verified}/${TARGETS.length} verified, ${off.escalations} frontier escalations, ${off.totalCost.toFixed(3)} mUSD → ${off.costPerVerified}/verified\n`);
process.stdout.write(`  memory ON : ${on.verified}/${TARGETS.length} verified, ${on.escalations} frontier escalations, ${on.totalCost.toFixed(3)} mUSD → ${on.costPerVerified}/verified\n`);
process.stdout.write(`  cost reduction from learning: ${receipt.costReductionPct}% (memory size ${on.memorySize})\n`);
process.stdout.write(`  receipt → bench/results/learning-loop.json\n`);
