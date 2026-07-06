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

// ── STRUCTURAL capability lever (ADR-236 §6) ────────────────────────────────────────────────────────
// The prose levers (editPolicy/…) only ADD system-prompt text — the ADR-226 "zero-marginal-advisor" risk,
// and the documented root cause of the D1 compounding-null (prompt-only hints ⇒ little headroom). This
// lever lets the flywheel evolve WHICH real solver capabilities are ON — structural behaviour, not prose:
// `repro-gate` = write a failing reproduction test first and iterate against it; `reviewer` = a critic
// sub-agent reviews and revises the patch. Both hit the SAME chat endpoint (so they stay $0 on a local
// endpoint). Not `localize` — it needs a hosted embedder.
//
// SECURITY: the lever value is produced by an LLM PROPOSER, so it is NEVER passed through to the spawned
// solver's argv. Only tokens on this fixed allowlist become flags — no arbitrary arg/flag/command
// injection (input validation at the process boundary).
export const CAPABILITY_LEVER = 'solverCapabilities';
export const CAPABILITY_ALLOWLIST = { 'repro-gate': '--repro-gate', reviewer: '--reviewer' };

/** Map an (untrusted) capability-lever value to a deduped, order-stable list of ALLOWLISTED solver flags.
 *  Anything not on the allowlist is dropped. Empty/garbage ⇒ [] ⇒ the solver runs at its default. */
export function capabilitiesToFlags(value, allowlist = CAPABILITY_ALLOWLIST) {
  const toks = String(value ?? '').split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const seen = new Set();
  const flags = [];
  for (const t of toks) {
    if (Object.prototype.hasOwnProperty.call(allowlist, t) && !seen.has(t)) { seen.add(t); flags.push(allowlist[t]); }
  }
  return flags;
}

export function makeCliSolver({
  solveScript = join(HERE, 'solve.mjs'),
  baseUrl = 'https://openrouter.ai/api/v1',
  model = 'z-ai/glm-5.2',
  apiKeyEnv = 'OPENROUTER_API_KEY',
  k = 12,
  policyToSystem = defaultPolicyToSystem,
  nodeArgs = [],
  extraArgs = [], // appended to the solver argv (e.g. agentic's --max-steps/--concurrency); unknown flags are ignored
  capabilityLever = CAPABILITY_LEVER,   // the structural lever's key in the policy (excluded from the prose system prompt)
  capabilityAllowlist = CAPABILITY_ALLOWLIST,
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  return async function runSolver(policy, instances) {
    const work = mkdtempSync(join(tmpdir(), 'fw-swebench-'));
    const manifest = join(work, 'manifest.json');
    const preds = join(work, 'preds.jsonl');
    const report = join(work, 'report.json');
    try {
      writeFileSync(manifest, JSON.stringify({ instances }));
      // Split the STRUCTURAL lever out of the prose levers: it maps to allowlisted argv flags (behaviour),
      // NOT to system-prompt text. So it never leaks into SWE_POLICY_SYSTEM, and untrusted proposer output
      // can only ever become a known flag.
      const { [capabilityLever]: capValue, ...proseLevers } = policy || {};
      const capFlags = capabilitiesToFlags(capValue, capabilityAllowlist);
      const res = spawnSync(
        'node',
        [...nodeArgs, solveScript, '--manifest', manifest, '--base-url', baseUrl, '--model', model,
          '--api-key-env', apiKeyEnv, '--out', preds, '--report', report, '--k', String(k), ...extraArgs, ...capFlags],
        { env: { ...process.env, SWE_POLICY_SYSTEM: policyToSystem(proseLevers) }, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1 << 28 },
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
