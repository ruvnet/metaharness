// SPDX-License-Identifier: MIT
//
// REAL typed-handoff A/B (ADR-163), driven by a real model via OpenRouter. This is
// the one benchmark that makes real LLM calls — it is OPTIONAL (skips with exit 0
// when OPENROUTER_API_KEY is absent) and is NOT part of the deterministic test
// suite. It measures the genuine effect of a typed handoff contract:
//
//   TYPED     : the hop's prompt names the contract's output schema (fields+types).
//   FREE-FORM : the hop's prompt asks for "JSON" but does NOT name the schema.
//
// BOTH validate the model's output against the SAME schema with the real
// validateHandoff(), and BOTH retry identically on invalid output (corrective
// re-prompt with the validation errors, bounded). The ONLY difference is whether
// the contract was specified up front. We count REAL retries (extra LLM calls) in
// each mode. Whatever the number, it is reported honestly — a strong cheap model
// may emit valid JSON even without a schema, shrinking the gap.
//
// Run: npm run -w @metaharness/projects build && node bench/handoff-llm.bench.mjs
// Optional: LLM_MODEL=<openrouter-model> (default openai/gpt-4o-mini)

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, validateHandoff } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

if (!openRouterAvailable()) {
  process.stdout.write('OPENROUTER_API_KEY absent — skipping the real handoff A/B.\n');
  process.exit(0);
}

// ── The 3-hop chain. Each hop has an output schema (the handoff contract). ──
const HOPS = [
  {
    from: 'planner', to: 'coder',
    outputSchema: [
      { name: 'steps', type: 'array', required: true },
      { name: 'targetFile', type: 'string', required: true },
    ],
    typedAsk: (task) => `Task: ${task}\nReturn a JSON object with EXACTLY these fields: "steps" (array of strings) and "targetFile" (string).`,
    freeAsk: (task) => `Task: ${task}\nRespond as JSON describing your plan.`,
  },
  {
    from: 'coder', to: 'tester',
    outputSchema: [
      { name: 'code', type: 'string', required: true },
      { name: 'language', type: 'string', required: true },
    ],
    typedAsk: (ctx) => `Plan: ${ctx}\nWrite the implementation. Return a JSON object with EXACTLY these fields: "code" (string) and "language" (string).`,
    freeAsk: (ctx) => `Plan: ${ctx}\nWrite the implementation. Respond as JSON.`,
  },
  {
    from: 'tester', to: 'done',
    outputSchema: [
      { name: 'passed', type: 'boolean', required: true },
      { name: 'summary', type: 'string', required: true },
    ],
    typedAsk: (ctx) => `Code: ${ctx}\nReview it. Return a JSON object with EXACTLY these fields: "passed" (boolean) and "summary" (string).`,
    freeAsk: (ctx) => `Code: ${ctx}\nReview it. Respond as JSON.`,
  },
];

const TASKS = [
  'a function that returns the factorial of n',
  'a function that reverses a string',
  'a function that checks whether a number is prime',
  'a function that returns the nth Fibonacci number',
  'a function that sums a list of integers',
  'a function that capitalizes the first letter of each word',
];

const MAX_RETRIES_PER_HOP = 2; // up to 3 calls per hop
const SYSTEM = { role: 'system', content: 'You are a precise software agent. Respond with a SINGLE JSON object and nothing else.' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const client = new OpenRouterClient({ maxRequests: 150, temperature: 0 });

/** Run one hop in one mode; returns { output, retries, firstTryValid }. */
async function runHop(hop, contextText, mode) {
  const ask = mode === 'typed' ? hop.typedAsk : hop.freeAsk;
  const messages = [SYSTEM, { role: 'user', content: ask(contextText) }];
  let retries = 0;
  let firstTryValid = false;
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_HOP; attempt += 1) {
    const r = await client.chatJSON(messages, { maxTokens: 300 });
    const output = isObj(r.parsed) ? r.parsed : {};
    const v = validateHandoff({ from: hop.from, to: hop.to, inputSchema: [], outputSchema: hop.outputSchema, riskLevel: 'low', allowedTools: [], budgetCostUnits: 1, escalationThreshold: 1 }, {}, output);
    if (v.ok) {
      if (attempt === 0) firstTryValid = true;
      return { output, retries, firstTryValid };
    }
    // Invalid → corrective retry (both modes learn the contract from the errors).
    retries += 1;
    messages.push({ role: 'assistant', content: r.raw.slice(0, 500) });
    messages.push({ role: 'user', content: `That was invalid: ${v.errors.join('; ')}. Return ONLY a JSON object with fields: ${hop.outputSchema.map((f) => `${f.name} (${f.type})`).join(', ')}.` });
  }
  return { output: {}, retries, firstTryValid }; // gave up after the cap
}

/** Run the full chain for one task in one mode; returns total retries. */
async function runChain(task, mode) {
  let retries = 0;
  let firstTryValid = 0;
  let ctx = task;
  for (const hop of HOPS) {
    const res = await runHop(hop, ctx, mode);
    retries += res.retries;
    if (res.firstTryValid) firstTryValid += 1;
    ctx = JSON.stringify(res.output).slice(0, 400);
  }
  return { retries, firstTryValid };
}

let retriesTyped = 0;
let retriesFree = 0;
let firstTryValidTyped = 0;
let firstTryValidFree = 0;
const hopsTotal = TASKS.length * HOPS.length;

for (const task of TASKS) {
  const t = await runChain(task, 'typed');
  const f = await runChain(task, 'free');
  retriesTyped += t.retries;
  retriesFree += f.retries;
  firstTryValidTyped += t.firstTryValid;
  firstTryValidFree += f.firstTryValid;
}

const retryReductionPct = retriesFree > 0 ? +(((retriesFree - retriesTyped) / retriesFree) * 100).toFixed(2) : 0;
const stats = client.stats();
// Rough cost estimate for gpt-4o-mini pricing ($0.15/1M in, $0.60/1M out); informational only.
const estCostUSD = +((stats.promptTokens / 1e6) * 0.15 + (stats.completionTokens / 1e6) * 0.6).toFixed(4);

const receipt = {
  experiment: 'real typed-vs-free-form handoff A/B (ADR-163)',
  model: client.model,
  tasks: TASKS.length,
  hopsPerChain: HOPS.length,
  hopsTotal,
  retriesTyped,
  retriesFree,
  retryReductionPct,
  firstTryValidRate: { typed: +(firstTryValidTyped / hopsTotal).toFixed(3), free: +(firstTryValidFree / hopsTotal).toFixed(3) },
  requests: stats.requests,
  tokens: { prompt: stats.promptTokens, completion: stats.completionTokens },
  estCostUSD,
  note: 'Real LLM calls; non-deterministic. Only difference between arms is whether the handoff schema was named in the prompt; both validate against the same schema with validateHandoff().',
};

writeFileSync(join(here, 'results', 'handoff-llm.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real handoff A/B (${client.model}): ${TASKS.length} tasks × ${HOPS.length} hops\n`);
process.stdout.write(`  retries: typed=${retriesTyped} free-form=${retriesFree} → reduction ${retryReductionPct}%\n`);
process.stdout.write(`  first-try valid rate: typed=${receipt.firstTryValidRate.typed} free-form=${receipt.firstTryValidRate.free}\n`);
process.stdout.write(`  ${stats.requests} requests, ${stats.promptTokens + stats.completionTokens} tokens, ~$${estCostUSD}\n`);
process.stdout.write(`  receipt → bench/results/handoff-llm.json\n`);
