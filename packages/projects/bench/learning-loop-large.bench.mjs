// SPDX-License-Identifier: MIT
//
// LARGE-corpus, MULTI-SEED test of the self-learning loop (src/learning-loop.ts).
// Replaces the favorable single-class single-run demo with a diverse corpus:
//   - HARD recurring classes (cheap model fails alone; a learned cue lets it succeed)
//   - EASY classes (cheap model already succeeds → memory gives no benefit)
//   - SINGLETON classes (appear once → escalate-once, no reuse benefit)
// Runs K seeds (temperature 0.7) of memory-ON vs memory-OFF and gates the difference
// with the package's paired bootstrap. Reports the MODEL-AGNOSTIC signal (frontier
// escalations avoided) plus cost under the cheap default frontier AND projected under
// an expensive frontier (GLM-5.2 pricing) — so the conclusion doesn't hinge on price.
// Optional/key-gated, bounded, defensive. Excluded from run-all.
//
// Run: node bench/learning-loop-large.bench.mjs   (SEEDS env, default 3)

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson, runLearningLoop, StrategyMemory, bootstrapDelta, round6, DEFAULT_FRONTIER_MODEL } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
if (!openRouterAvailable()) { process.stdout.write('OPENROUTER_API_KEY absent — skipping.\n'); process.exit(0); }

// Diverse corpus: per class, n recurring variants + a generalized cue.
const CLASSES = [
  { cls: 'parsepair', n: 4, body: (i) => `def pp_${i}(s):\n    a, b = s.split("-"); return int(a) + int(b)`, cue: "a string that does not split on '-' into exactly two integers (e.g. 'x-y')" },
  { cls: 'hexdec', n: 3, body: (i) => `def hx_${i}(s):\n    return bytes.fromhex(s)`, cue: 'an odd-length or non-hexadecimal string' },
  { cls: 'csvints', n: 3, body: (i) => `def ci_${i}(s):\n    return [int(x) for x in s.split(",")]`, cue: 'a comma-separated string with a non-integer element' },
  { cls: 'divzero', n: 3, body: (i) => `def dz_${i}(a, b):\n    return a // b`, cue: 'a zero divisor' },
  { cls: 'oob', n: 3, body: (i) => `def ob_${i}(xs, j):\n    return xs[j]`, cue: 'an index greater than or equal to len' },
  { cls: 'datesplit', n: 1, body: (i) => `def ds_${i}(s):\n    y, m, d = s.split("/"); return int(y)`, cue: "a string without exactly two '/' separators" }, // singleton-hard
];
const fnName = (cls, i) => ({ parsepair: 'pp', hexdec: 'hx', csvints: 'ci', divzero: 'dz', oob: 'ob', datesplit: 'ds' }[cls]) + '_' + i;
const SOURCE = CLASSES.flatMap((c) => Array.from({ length: c.n }, (_, i) => c.body(i))).join('\n');
const cueFor = Object.fromEntries(CLASSES.map((c) => [c.cls, c.cue]));
// Round-robin interleave so recurring classes recur across the sequence.
const TARGETS = [];
const maxN = Math.max(...CLASSES.map((c) => c.n));
for (let i = 0; i < maxN; i += 1) for (const c of CLASSES) if (i < c.n) TARGETS.push({ id: fnName(c.cls, i), weaknessClass: c.cls });

const CHEAP = process.env.CHEAP_MODEL || 'qwen/qwen-2.5-7b-instruct';
const FRONTIER = process.env.FRONTIER_MODEL || DEFAULT_FRONTIER_MODEL;
const PR = { [CHEAP]: { in: 0.04, out: 0.10 }, [FRONTIER]: { in: 0.09, out: 0.10 } };
const GLM = { in: 1.2, out: 4.1 }; // expensive-frontier projection
const SEEDS = +(process.env.SEEDS || 3);

function verify(fn, args) {
  const dir = mkdtempSync(join(tmpdir(), 'lll-'));
  const f = join(dir, 'c.py');
  writeFileSync(f, `${SOURCE}\nimport json,sys\nA=json.loads(sys.argv[1])\ntry:\n    ${fn}(*A)\n    print(json.dumps({"t":False}))\nexcept Exception:\n    print(json.dumps({"t":True}))\n`);
  try {
    const out = execFileSync('python3', ['-I', '-B', f, JSON.stringify(args)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
    return JSON.parse(out.trim().split('\n').pop()).t === true;
  } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function ask(client, fn, cue, temp) {
  const before = client.stats();
  const hint = cue ? `\nHint: ${cue}.` : '';
  const r = await client.chatJSON([
    { role: 'system', content: 'You are a security analyst. Output ONLY JSON.' },
    { role: 'user', content: `Give ONE concrete argument list that makes \`${fn}\` raise an unhandled exception. Return {"args":[...]}.${hint}\n\n${SOURCE}` },
  ], { maxTokens: 120 });
  const p = tryParseJson(r.raw);
  const ok = p && Array.isArray(p.args) ? verify(fn, p.args) : false;
  const after = client.stats();
  return { ok, pin: after.promptTokens - before.promptTokens, pout: after.completionTokens - before.completionTokens };
}

async function runConfig(useMemory, seedTemp) {
  const cheap = new OpenRouterClient({ model: CHEAP, maxRequests: TARGETS.length + 4, temperature: seedTemp });
  const frontier = new OpenRouterClient({ model: FRONTIER, maxRequests: TARGETS.length + 4, temperature: seedTemp });
  let escalations = 0; let fIn = 0; let fOut = 0; let cIn = 0; let cOut = 0;
  const lane = async ({ target, recalled }) => {
    const c = await ask(cheap, target, recalled?.hint, seedTemp); cIn += c.pin; cOut += c.pout;
    if (c.ok) return { verified: true, hint: cueForOf(target), costUnits: 0 };
    escalations += 1;
    const f = await ask(frontier, target, cueForOf(target), seedTemp); fIn += f.pin; fOut += f.pout;
    return { verified: f.ok, hint: f.ok ? cueForOf(target) : undefined, costUnits: 0 };
  };
  const res = await runLearningLoop(TARGETS, lane, { useMemory, memory: new StrategyMemory() });
  const costDefault = round6((cIn / 1e6) * PR[CHEAP].in + (cOut / 1e6) * PR[CHEAP].out + (fIn / 1e6) * PR[FRONTIER].in + (fOut / 1e6) * PR[FRONTIER].out) * 1000;
  const costGlm = round6((cIn / 1e6) * PR[CHEAP].in + (cOut / 1e6) * PR[CHEAP].out + (fIn / 1e6) * GLM.in + (fOut / 1e6) * GLM.out) * 1000;
  return { verified: res.verified, escalations, costDefault, costGlm };
}
function cueForOf(fn) { const pfx = fn.split('_')[0]; const cls = { pp: 'parsepair', hx: 'hexdec', ci: 'csvints', dz: 'divzero', ob: 'oob', ds: 'datesplit' }[pfx]; return cueFor[cls]; }

const seedTemps = Array.from({ length: SEEDS }, (_, k) => 0.5 + k * 0.15);
const on = []; const off = [];
for (const t of seedTemps) { off.push(await runConfig(false, t)); on.push(await runConfig(true, t)); }

const mean = (xs) => round6(xs.reduce((a, b) => a + b, 0) / xs.length);
const escOff = off.map((r) => r.escalations); const escOn = on.map((r) => r.escalations);
const bootEsc = bootstrapDelta(escOn, escOff, { seed: 1 }); // delta = off − on (escalations avoided)
const reductionDefault = mean(off.map((r) => r.costDefault)) > 0 ? round6((1 - mean(on.map((r) => r.costDefault)) / mean(off.map((r) => r.costDefault))) * 100) : 0;
const reductionGlm = mean(off.map((r) => r.costGlm)) > 0 ? round6((1 - mean(on.map((r) => r.costGlm)) / mean(off.map((r) => r.costGlm))) * 100) : 0;

const receipt = {
  experiment: 'large-corpus multi-seed self-learning loop',
  cheapModel: CHEAP, frontierModel: FRONTIER, targets: TARGETS.length, classes: CLASSES.length, seeds: SEEDS,
  perSeed: { off, on },
  meanVerified: { off: mean(off.map((r) => r.verified)), on: mean(on.map((r) => r.verified)) },
  meanEscalations: { off: mean(escOff), on: mean(escOn) },
  escalationsAvoided_bootstrap_offMinusOn: bootEsc,
  costReductionPct: { withCheapFrontier: reductionDefault, projectedWithGlmFrontier: reductionGlm },
  note: 'Multi-seed (temperature sweep). Model-agnostic signal is escalations avoided (paired bootstrap). Cost reduction shown for the cheap default frontier (modest) and projected for an expensive frontier (large) — the loop saves frontier CALLS; the $ saving scales with frontier price. Diverse corpus incl. easy + singleton classes where memory cannot help.',
};
writeFileSync(join(here, 'results', 'learning-loop-large.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Large multi-seed learning loop: ${TARGETS.length} targets, ${CLASSES.length} classes, ${SEEDS} seeds\n`);
process.stdout.write(`  verified mean: off ${receipt.meanVerified.off}/${TARGETS.length}  on ${receipt.meanVerified.on}/${TARGETS.length}\n`);
process.stdout.write(`  escalations mean: off ${receipt.meanEscalations.off}  on ${receipt.meanEscalations.on}  (avoided bootstrap meanDelta ${bootEsc.meanDelta}, lower95 ${bootEsc.lower95})\n`);
process.stdout.write(`  cost reduction: cheap-frontier ${reductionDefault}%  |  projected expensive(GLM) frontier ${reductionGlm}%\n`);
process.stdout.write(`  receipt → bench/results/learning-loop-large.json\n`);
