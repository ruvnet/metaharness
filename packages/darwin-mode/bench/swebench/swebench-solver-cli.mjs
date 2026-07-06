// D1-S3 (self-learning scale loop) — the REAL `runSolver` for the flywheel SWE-bench Evaluator: wrap
// solve.mjs as a subprocess. Maps a flywheel POLICY (operating-policy levers) into the solver's system
// prompt (via the SWE_POLICY_SYSTEM seam added to solve.mjs), runs the cheap-model search/replace solver
// over the given instances, and parses predictions.jsonl into the `runSolver` contract. The solver never
// runs tests — the official swebench Docker harness gold-scores (that is `gradePredictions`, D1-S4).
//
// This is injected into makeSwebenchEvaluator({ runSolver }). solveScript defaults to solve.mjs; tests
// pass a $0 stub so the CLI plumbing (manifest write → policy env → predictions parse → cost) is
// validated end-to-end WITHOUT cloning real repos or calling a model.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default policy → system-prompt: concatenate the lever texts (skip empties). The solver appends this
 *  to its base system message, so the flywheel evolves HOW the cheap solver operates. */
export function defaultPolicyToSystem(policy) {
  return Object.values(policy || {}).filter((v) => typeof v === 'string' && v.trim()).join('\n').trim();
}

export function makeCliSolver({
  solveScript = join(HERE, 'solve.mjs'),
  baseUrl = 'https://openrouter.ai/api/v1',
  model = 'z-ai/glm-5.2',
  apiKeyEnv = 'OPENROUTER_API_KEY',
  k = 12,
  policyToSystem = defaultPolicyToSystem,
  nodeArgs = [],
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  return async function runSolver(policy, instances) {
    const work = mkdtempSync(join(tmpdir(), 'fw-swebench-'));
    const manifest = join(work, 'manifest.json');
    const preds = join(work, 'preds.jsonl');
    const report = join(work, 'report.json');
    try {
      writeFileSync(manifest, JSON.stringify({ instances }));
      const res = spawnSync(
        'node',
        [...nodeArgs, solveScript, '--manifest', manifest, '--base-url', baseUrl, '--model', model,
          '--api-key-env', apiKeyEnv, '--out', preds, '--report', report, '--k', String(k)],
        { env: { ...process.env, SWE_POLICY_SYSTEM: policyToSystem(policy) }, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1 << 28 },
      );
      if (res.status !== 0 && !existsSync(preds)) {
        throw new Error(`solver exited ${res.status}: ${String(res.stderr || res.error).slice(0, 300)}`);
      }
      // parse predictions.jsonl (one {instance_id, model_patch} per line).
      const lines = existsSync(preds) ? readFileSync(preds, 'utf-8').split('\n').filter(Boolean) : [];
      const rows = lines.map((l) => JSON.parse(l));
      // total cost from the report (best-effort) → amortized per prediction for costPerWin.
      let totalCost = 0;
      try { totalCost = Number(JSON.parse(readFileSync(report, 'utf-8')).totalCost) || 0; } catch { /* report optional */ }
      const per = rows.length ? totalCost / rows.length : 0;
      return rows.map((r) => ({ instance_id: r.instance_id, model_patch: r.model_patch ?? '', costUsd: per }));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}
