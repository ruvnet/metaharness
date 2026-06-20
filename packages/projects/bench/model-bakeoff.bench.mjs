// SPDX-License-Identifier: MIT
//
// REAL but tightly budget-capped model bake-off for the Darwin escalation router.
// Finds the best cost-per-PASSING-task model lanes across cheap candidates and
// open-frontier lanes (including GLM-5.2 and GLM-4.7). Modeled closely on
// bench/escalation-llm.bench.mjs: same extractCode, same isolated-subprocess
// verify (`python3 -I -B`, 5s timeout, clean env WITHOUT the API key), same
// token×pricing cost math. Optional (skips with exit 0 when OPENROUTER_API_KEY is
// absent); not part of the deterministic suite; key from env only (never logged).
//
// HARD budget guards:
//   - every client is built with maxRequests: 8 (the client throws past its cap).
//   - exactly 5 tasks × 6 models = 30 calls; GLM-5.2 sees exactly 5 calls (≤12 cap).
//   - temperature 0. Total expected spend well under $0.20.
//
// Run: node bench/model-bakeoff.bench.mjs

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping the real model bake-off bench.\n');
  process.exit(0);
}

// Per-model pricing ($/M tokens), from OpenRouter at time of writing (for cost math).
const PRICING = {
  'qwen/qwen-2.5-7b-instruct': { in: 0.04, out: 0.10 },
  'meta-llama/llama-3.3-70b-instruct': { in: 0.10, out: 0.32 },
  'google/gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'z-ai/glm-4.7-flash': { in: 0.06, out: 0.40 },
  'z-ai/glm-5.2': { in: 1.20, out: 4.10 },
  'z-ai/glm-4.7': { in: 0.40, out: 1.75 },
};

// Which lane each model belongs to for the recommendation logic.
const CHEAP_MODELS = [
  'qwen/qwen-2.5-7b-instruct',
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemini-2.5-flash-lite',
  'z-ai/glm-4.7-flash',
];
const FRONTIER_MODELS = ['z-ai/glm-5.2', 'z-ai/glm-4.7'];
const MODELS = [...CHEAP_MODELS, ...FRONTIER_MODELS];

// ── 5 tasks: a mix of easy + hard small Python functions with hidden unit tests
//    (drawn from escalation-llm.bench.mjs). tests are [args, expected]. ──
const TASKS = [
  { fn: 'factorial', desc: 'factorial(n): the factorial of a non-negative integer n', tests: [[[0], 1], [[5], 120], [[1], 1]] },
  { fn: 'is_prime', desc: 'is_prime(n): True iff n is prime', tests: [[[2], true], [[1], false], [[17], true], [[15], false]] },
  { fn: 'roman_to_int', desc: 'roman_to_int(s): convert a Roman numeral string to an integer', tests: [[['III'], 3], [['IV'], 4], [['MCMXCIV'], 1994], [['LVIII'], 58]] },
  { fn: 'longest_common_prefix', desc: 'longest_common_prefix(strs): the longest common prefix of a list of strings ("" if none)', tests: [[[['flower', 'flow', 'flight']], 'fl'], [[['dog', 'cat']], ''], [[['a']], 'a']] },
  { fn: 'two_sum', desc: 'two_sum(nums, target): return indices [i, j] (i<j) of the two numbers that add to target; exactly one solution exists', tests: [[[[2, 7, 11, 15], 9], [0, 1]], [[[3, 2, 4], 6], [1, 2]], [[[3, 3], 6], [0, 1]]] },
];

const SYSTEM = { role: 'system', content: 'You are an expert programmer. Output ONLY a single self-contained Python function definition — no prose, no tests, no markdown fences.' };

function extractCode(raw) {
  const fenced = raw.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/** Run generated code against the task's hidden tests in an isolated subprocess. */
function verify(code, task) {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-bakeoff-'));
  const file = join(dir, 'cand.py');
  const driver = `${code}

import json
TESTS = ${JSON.stringify(task.tests)}
try:
    ok = True
    for args, expected in TESTS:
        if ${task.fn}(*args) != expected:
            ok = False
            break
    print(json.dumps({"passed": bool(ok)}))
except Exception as e:
    print(json.dumps({"passed": False, "error": type(e).__name__}))
`;
  writeFileSync(file, driver);
  try {
    const out = execFileSync('python3', ['-I', '-B', file], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, // clean env — no API key in the child
    });
    return JSON.parse(out.trim().split('\n').pop()).passed === true;
  } catch {
    return false; // timeout / crash / syntax error => not passing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function attempt(client, task) {
  const r = await client.chatJSON([SYSTEM, { role: 'user', content: `Write Python: ${task.desc}. The function must be named exactly \`${task.fn}\`.` }], { maxTokens: 500 });
  return verify(extractCode(r.raw), task);
}

const costOf = (client) => {
  const s = client.stats();
  const p = PRICING[client.model] ?? { in: 0, out: 0 };
  return +((s.promptTokens / 1e6) * p.in + (s.completionTokens / 1e6) * p.out).toFixed(6);
};

const cpp = (cost, passes) => (passes > 0 ? +(cost / passes).toFixed(6) : null);
const n = TASKS.length;

// ── Run each model over all 5 tasks (one client each, maxRequests 8). ──
const table = [];
for (const model of MODELS) {
  const client = new OpenRouterClient({ model, maxRequests: 8, temperature: 0 });
  let passed = 0;
  for (const t of TASKS) {
    if (await attempt(client, t)) passed += 1;
  }
  const costUSD = costOf(client);
  table.push({
    model,
    lane: CHEAP_MODELS.includes(model) ? 'cheap' : 'frontier',
    passed,
    of: n,
    costUSD,
    costPerPassingTaskUSD: cpp(costUSD, passed),
  });
}

// ── Recommendation ──
// best cheap lane = cheap candidate with lowest cost-per-passing-task that still
//   passes a majority (> n/2).
const majority = Math.floor(n / 2) + 1;
const cheapEligible = table
  .filter((r) => r.lane === 'cheap' && r.passed >= majority && r.costPerPassingTaskUSD != null)
  .sort((a, b) => a.costPerPassingTaskUSD - b.costPerPassingTaskUSD);
const bestCheap = cheapEligible[0] || null;

// best frontier lane = frontier model with the highest pass rate (tie → lower cost/pass).
const frontierSorted = table
  .filter((r) => r.lane === 'frontier')
  .sort((a, b) => b.passed - a.passed || ((a.costPerPassingTaskUSD ?? Infinity) - (b.costPerPassingTaskUSD ?? Infinity)));
const bestFrontier = frontierSorted[0] || null;

// Does any single cheap model already match the best frontier pass rate at far lower cost?
const bestFrontierPass = bestFrontier ? bestFrontier.passed : 0;
const cheapMatchingFrontier = table
  .filter((r) => r.lane === 'cheap' && r.passed >= bestFrontierPass && r.costPerPassingTaskUSD != null)
  .sort((a, b) => a.costPerPassingTaskUSD - b.costPerPassingTaskUSD);
const escalationUnnecessary = cheapMatchingFrontier.length > 0;

const recommendation = {
  bestCheapLane: bestCheap
    ? { model: bestCheap.model, passed: bestCheap.passed, costPerPassingTaskUSD: bestCheap.costPerPassingTaskUSD }
    : null,
  bestFrontierLane: bestFrontier
    ? { model: bestFrontier.model, passed: bestFrontier.passed, costPerPassingTaskUSD: bestFrontier.costPerPassingTaskUSD }
    : null,
  escalationUnnecessaryForThisTaskClass: escalationUnnecessary,
  cheapModelMatchingFrontier: escalationUnnecessary
    ? { model: cheapMatchingFrontier[0].model, passed: cheapMatchingFrontier[0].passed, costPerPassingTaskUSD: cheapMatchingFrontier[0].costPerPassingTaskUSD }
    : null,
  rationale: escalationUnnecessary
    ? `Cheap model ${cheapMatchingFrontier[0].model} matches the best frontier pass rate (${bestFrontierPass}/${n}) at far lower cost per passing task — escalation is unnecessary for this task class.`
    : `No single cheap model matches the best frontier pass rate (${bestFrontierPass}/${n}); an escalation lane (cheap → ${bestFrontier ? bestFrontier.model : 'frontier'}) is justified for the hard tasks.`,
};

const receipt = {
  experiment: 'Darwin model bake-off — cost per passing task across cheap + open-frontier lanes',
  tasks: n,
  taskNames: TASKS.map((t) => t.fn),
  perModel: table,
  recommendation,
  note: 'Real LLM calls; single non-deterministic run. Each client capped at maxRequests=8 (budget guard). GLM-5.2 sees exactly 5 calls (≤12 cap). "Passing" = generated function passes hidden unit tests run in an isolated python subprocess. Cost from token usage × OpenRouter pricing.',
};
writeFileSync(join(here, 'results', 'model-bakeoff.json'), JSON.stringify(receipt, null, 2) + '\n');

// ── Concise table to stdout ──
process.stdout.write(`Darwin model bake-off (${n} tasks: ${TASKS.map((t) => t.fn).join(', ')})\n`);
process.stdout.write('  model                                lane      pass   costUSD     $/passing\n');
for (const r of table) {
  const cppStr = r.costPerPassingTaskUSD == null ? '  n/a   ' : `$${r.costPerPassingTaskUSD.toFixed(6)}`;
  process.stdout.write(`  ${r.model.padEnd(36)} ${r.lane.padEnd(9)} ${String(r.passed)}/${n}    $${r.costUSD.toFixed(6).padEnd(9)} ${cppStr}\n`);
}
process.stdout.write('\nRecommendation:\n');
process.stdout.write(`  best cheap lane    : ${recommendation.bestCheapLane ? `${recommendation.bestCheapLane.model} (${recommendation.bestCheapLane.passed}/${n}, $${recommendation.bestCheapLane.costPerPassingTaskUSD}/passing)` : 'none passed a majority'}\n`);
process.stdout.write(`  best frontier lane : ${recommendation.bestFrontierLane ? `${recommendation.bestFrontierLane.model} (${recommendation.bestFrontierLane.passed}/${n}, $${recommendation.bestFrontierLane.costPerPassingTaskUSD}/passing)` : 'n/a'}\n`);
process.stdout.write(`  escalation needed? : ${recommendation.escalationUnnecessaryForThisTaskClass ? 'NO — ' + recommendation.rationale : 'YES — ' + recommendation.rationale}\n`);
process.stdout.write('  receipt → bench/results/model-bakeoff.json\n');
