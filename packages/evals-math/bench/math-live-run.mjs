#!/usr/bin/env node
// LIVE GSM8K flywheel run — the math analog of the SWE-bench d1s4-live-run.mjs, but FAST + $0-local:
// text Q&A, exact-match gold-scoring (no Docker, no multi-hour). A real model answers frozen GSM8K under a
// candidate operating-policy; the flywheel evolves the policy (verification/self-consistency/confidence/
// normalization levers) over generations; the FROZEN meetsPromotionRule (composed verbatim in
// mathPromotionRule) gates every promotion; the anchor (publicDev) is never optimized against.
//
// HONESTY: only exact-match against the committed GSM8K gold scores here — no judge, no fabrication. The
// $0-local endpoint (`--api-key-env NONE` / a localhost --base-url) makes a real compounding experiment
// cost $0. dataSource is LIVE; the signed replay bundle is externally verifiable.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  runFlywheelGenerations, makeSigner, verifyReplayBundle, gateFingerprint, analyzeBundle, formatAnalysis,
} from '@metaharness/flywheel';
import {
  rootGenome, genomeToPolicy, makeMathEvaluator, makeMathProposer, mathPromotionRule,
} from '../dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

const MODEL = arg('--model', 'qwen2.5-coder:32b');
const BASE_URL = arg('--base-url', 'http://localhost:11434/v1').replace(/\/$/, '');
const API_KEY_ENV = arg('--api-key-env', 'NONE');
const HOLDOUT_N = +arg('--holdout', 40);
const ANCHOR_N = +arg('--anchor', 30);
const GENERATIONS = +arg('--generations', 6);
const BUDGET_USD = +arg('--budget', 5);
const MAX_TOKENS = +arg('--max-tokens', 512);

// A local no-auth endpoint (ollama / ruvllm serve at localhost, or explicit NONE) needs no key and is $0.
const NO_AUTH = API_KEY_ENV === 'NONE' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(BASE_URL);
const KEY = NO_AUTH ? '' : (process.env[API_KEY_ENV] || '').trim();

const frozen = JSON.parse(readFileSync(join(HERE, 'gsm8k-frozen.json'), 'utf-8'));
const holdout = frozen.sets.privateValidation.slice(0, HOLDOUT_N);
const anchor = frozen.sets.publicDev.slice(0, ANCHOR_N);

let spend = 0;
const priceOf = (u) => NO_AUTH ? 0 : ((u?.prompt_tokens ?? 0) * 0.5e-6 + (u?.completion_tokens ?? 0) * 1.5e-6);

async function fetchJSON(url, init, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status >= 500 || r.status === 429) lastErr = new Error(`http_${r.status}`);
      else return await r.json();
    } catch (e) { lastErr = e; }
    await new Promise((s) => setTimeout(s, Math.min(15000, 500 * 2 ** i)));
  }
  throw lastErr;
}

// The policy's solverStyle/answerFormat shape the prompt; maxCandidates = self-consistency depth.
function systemFor(style, format) {
  const base = 'You are solving a grade-school math word problem. ';
  const styleTxt = {
    'direct': 'Give the final numeric answer.',
    'chain-of-thought': 'Reason step by step, then give the final numeric answer.',
    'answer-first': 'State the final numeric answer first, then briefly justify.',
    'verify-then-answer': 'Solve, verify your arithmetic, then give the final numeric answer.',
  }[style] ?? 'Reason step by step, then give the final numeric answer.';
  return `${base}${styleTxt} End with a line "Final answer: <number>" (a plain ${format}, digits only).`;
}

// LIVE SolveFn: one greedy pass (raw) + (maxCandidates-1) temp>0 samples for self-consistency.
const solve = async ({ question, style, format, maxCandidates }) => {
  const headers = { 'Content-Type': 'application/json', ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) };
  const n = Math.max(1, maxCandidates | 0);
  const outs = [];
  for (let i = 0; i < n; i++) {
    let content = '';
    try {
      const j = await fetchJSON(`${BASE_URL}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: systemFor(style, format) }, { role: 'user', content: question }], max_tokens: MAX_TOKENS, temperature: i === 0 ? 0 : 0.7 }),
      });
      content = j.choices?.[0]?.message?.content ?? '';
      spend += priceOf(j.usage);
    } catch { content = ''; } // an unreachable/failed call yields no answer (scored against), never a fake
    outs.push(content);
  }
  return { raw: outs[0], samples: outs.slice(1), costUsd: 0 /* summed into `spend` globally */ };
};

const evaluate = makeMathEvaluator({ solve, publicExamples: anchor.map((i) => i.question) });
const proposer = makeMathProposer(); // $0 deterministic, schema-valid enum mutations
const out = join(HERE, 'proof-bundle-gsm8k.json');
const ckpt = join(HERE, 'proof-bundle-gsm8k.partial.json');

if (process.argv.includes('--plan') || process.argv.includes('--dry-run')) {
  const ck = (ok) => (ok ? 'GREEN' : 'BLOCKED');
  const suitesOk = holdout.length >= 1 && anchor.length >= 1;
  const authOk = NO_AUTH || KEY.length > 0;
  let modelOk = null;
  if (NO_AUTH) { try { const r = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(5000) }); const ids = new Set(((await r.json())?.data ?? []).map((m) => m.id)); modelOk = ids.has(MODEL); } catch { modelOk = false; } }
  const ready = suitesOk && authOk && (modelOk !== false);
  console.log([
    '── GSM8K LIVE RUN PLAN (dry-run — no spend) ──',
    `  model=${MODEL} @ ${BASE_URL}  auth=${ck(authOk)}${NO_AUTH ? ' (LOCAL no-auth $0)' : ''}`,
    `  frozen split fp=${frozen.splitFingerprint.slice(0, 12)}  holdout=${holdout.length}  anchor=${anchor.length}  generations=${GENERATIONS}`,
    `  mutation targets: verificationMode, maxCandidates, confidenceRule, normalizeFinalAnswer`,
    `  HARD budget cap: $${BUDGET_USD}  (local endpoint ⇒ $0)`,
    NO_AUTH ? `  model served locally: ${ck(modelOk)}${modelOk === false ? ` — ${MODEL} NOT in ${BASE_URL}/models` : ''}` : '',
    `  frozen suites present: ${ck(suitesOk)}`,
    '',
    `  READY: ${ready ? 'YES — drop --plan to run for real' : 'NO — resolve BLOCKED item(s)'}`,
    '  SCOPE: only exact-match vs committed GSM8K gold scores; LIVE, replay-verifiable.',
  ].filter(Boolean).join('\n'));
  process.exit(ready ? 0 : 1);
}

let resumeFrom;
if (process.argv.includes('--resume') && existsSync(ckpt)) {
  const saved = JSON.parse(readFileSync(ckpt, 'utf-8'));
  if (saved.resumeState) { resumeFrom = saved.resumeState; spend = saved.spent || 0; console.log(`[resume] from gen ${resumeFrom.fromGeneration}`); }
}

console.log(`GSM8K LIVE flywheel: model=${MODEL} holdout=${holdout.length} anchor=${anchor.length} gens=${GENERATIONS} cap=$${BUDGET_USD}`);
const result = await runFlywheelGenerations({
  rootPolicy: genomeToPolicy(rootGenome()),
  proposer, evaluator: evaluate, promotionRule: mathPromotionRule,
  holdout: { id: 'gsm8k-validation', items: holdout },
  anchor: { id: 'gsm8k-anchor', items: anchor },
  mutationTargets: ['verificationMode', 'maxCandidates', 'confidenceRule', 'normalizeFinalAnswer'],
  maxGenerations: GENERATIONS, signer: makeSigner(), dataSource: 'LIVE', resumeFrom,
  budget: { total: BUDGET_USD, spent: () => spend },
  onGeneration: (info) => { try { writeFileSync(ckpt, JSON.stringify({ partialBundle: info.partialBundle, resumeState: info.resumeState, spent: info.spent }, null, 2)); } catch { /* checkpoint best-effort */ } },
});

const curve = result.liftCurve;
console.log('\n── LIFT CURVE (primary = accuracy on the frozen holdout; anchor = never-optimized guard) ──');
for (const p of curve) console.log(`  gen ${p.generation}: primary=${p.primary?.toFixed?.(3) ?? p.primary}  Δ=${(p.delta ?? 0).toFixed?.(3) ?? p.delta}  anchor=${p.anchor?.toFixed?.(3) ?? p.anchor}`);
console.log(`milestone_reached=${result.milestoneReached}  promotions=${result.replayBundle?.chain?.length ?? 0}  spend=$${spend.toFixed(4)}`);
const v = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: gateFingerprint(mathPromotionRule), promotionRule: mathPromotionRule });
console.log(`replay: ${v.pass ? 'PASS' : 'FAIL'}  data_source=${result.replayBundle.data_source}`);
writeFileSync(out, JSON.stringify(result.replayBundle, null, 2) + '\n');
try { writeFileSync(join(HERE, 'analyze-gsm8k.json'), JSON.stringify(analyzeBundle(result.replayBundle), null, 2)); console.log('\n' + formatAnalysis(analyzeBundle(result.replayBundle))); } catch { /* analyze best-effort */ }
console.log(`\nproof bundle → ${out}`);
