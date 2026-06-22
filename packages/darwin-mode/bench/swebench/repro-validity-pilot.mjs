// SPDX-License-Identifier: MIT
// ADR-174 L1′ — measure the LINCHPIN: how often does the cheap base model write a
// VALID conformant repro (one that FAILS on the unmodified buggy code)? Runs the
// Test-Critic over N instances with the chosen model; reports the validity rate +
// cost. $0-of-gold (Docker conformant only). Cheap (~cents/instance).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReproTest } from './test-critic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MODEL = argv('--model', 'deepseek/deepseek-v4-flash');
const N = +argv('--n', 8);
const ATT = +argv('--attempts', 3);
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const key = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();

async function llm(prompt, system) {
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
  for (let a = 0; a < 4; a++) {
    if (a) await new Promise((r) => setTimeout(r, 1500 * 2 ** a));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages, max_tokens: 2048, temperature: 0 }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
      const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
    } catch { /* retry */ }
  }
  return { raw: '', cost: 0 };
}

const insts = JSON.parse(readFileSync(join(HERE, argv('--manifest', 'full-300.json')), 'utf8')).instances.slice(0, N);
let valid = 0, cost = 0;
console.error(`repro-validity pilot: ${insts.length} instances, model=${MODEL}, attempts=${ATT}`);
for (const inst of insts) {
  const r = await buildReproTest(inst.instance_id, inst.problem_statement, llm, { maxAttempts: ATT });
  cost += r.cost; if (r.valid) valid++;
  console.error(`${r.valid ? 'VALID  ' : 'invalid'} ${inst.instance_id} (att ${r.attempts}) ${(r.logTail.match(/\d+ (passed|failed|error)[^\n]*/) || [''])[0]}`);
}
console.error(`\nREPRO-VALIDITY: ${valid}/${insts.length} = ${(valid / insts.length * 100).toFixed(0)}% valid failing repros | $${cost.toFixed(3)} | ~$${(cost / insts.length).toFixed(4)}/inst`);
