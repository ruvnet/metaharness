// Cell-key provenance for evaluator.mjs: everything that can change a measured outcome is hashed into the key,
// so a cached cell is reused ONLY for the same env source, runner source, runner arguments, served model and seeds.
//   serverSha     = sha256(canon({baseUrl (normalized), models: GET <baseUrl>/models -> [{id, root, max_model_len}]}))
//                   -> a ruvllm small-Qwen proxy and the A100 27B can never share a key, even with the same --model label.
//   runnerArgsSha = sha256(canon(fixed runner argv: max-total-tokens, tokenizer pin, max-steps, request timeout, token cap)).
// The API key is only ever sent to the configured endpoint (the same one calibrate.py calls) and is never hashed or logged.
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canon } from '../../../packages/flywheel/src/receipts.ts';
import { checkProvenance } from './cells.mjs';

export const RUNNER_FIXED = Object.freeze({ maxSteps: 8, requestTimeoutS: 900, maxTokensCap: 16384, accounting: 'arena' });
/** Worst case of ONE runner call (4 episodes x max_steps requests x request timeout), as calibrate.py's plan reports it
 *  (max_request_wait_seconds for one family), plus 10 minutes for env/tokenizer startup. */
export const RUNNER_CALL_WORST_CASE_S = 4 * RUNNER_FIXED.maxSteps * RUNNER_FIXED.requestTimeoutS + 600;
export const sha256 = (...parts) => parts.reduce((h, b) => h.update(b), createHash('sha256')).digest('hex');
export const DRY_SHA = sha256('openenv-arena-darwin:dry-run:v1');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** calibrate.py's rule (HTTPS without credentials, or loopback HTTP); returns scheme://host[:port]/path without trailing '/'. */
export function normalizeBaseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid --base-url'); }
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!ok || u.username || u.password || u.search || u.hash) throw new Error('--base-url must be https without credentials, or loopback http');
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
}

export function runnerArgsSha(o) {
  // thinking is part of the key: on/off measure different regimes and must never share a cached cell.
  return sha256(canon({ ...RUNNER_FIXED, maxTotalTokens: o.maxTotalTokens, tokenizerSha256: o.tokenizerSha256, thinking: o.thinking ?? 'off' }));
}

/** What the endpoint actually serves. Throws (fail closed) when unreachable, non-JSON, or not serving `model`. */
export async function probeServer(baseUrl, apiKey, model, { fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const url = `${baseUrl}/models`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`server_unreachable: GET ${url} (${error?.name ?? 'error'})`);
  }
  if (!res.ok) throw new Error(`server_probe_failed: GET ${url} -> HTTP ${res.status}`);
  let body;
  try { body = await res.json(); } catch { throw new Error(`server_probe_failed: GET ${url} returned non-JSON`); }
  if (!Array.isArray(body?.data)) throw new Error(`server_probe_failed: GET ${url} has no data[]`);
  const models = body.data.map((m) => ({ id: String(m?.id ?? ''), root: typeof m?.root === 'string' ? m.root : null,
    max_model_len: Number.isSafeInteger(m?.max_model_len) ? m.max_model_len : null })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!models.some((m) => m.id === model)) {
    throw new Error(`model_not_served: --model "${model}" is not in ${url} (${models.map((m) => m.id).slice(0, 8).join(', ') || 'none'})`);
  }
  return { serverSha: sha256(canon({ baseUrl, models })), models };
}

/** Provenance bound into every cell key (+ per-file digests and the served model ids, for humans only). */
export async function provenanceFor(o, env = process.env, { fetchImpl } = {}) {
  const common = { modelRevision: o.modelRevision, contextTokens: o.contextTokens, seedBase: o.seedBase, attempts: o.attempts,
    runnerArgsSha: runnerArgsSha(o) };
  if (o.dryRun) {
    return { prov: checkProvenance({ envSourceSha: DRY_SHA, runnerSha: DRY_SHA, serverSha: DRY_SHA, model: `dryrun.${o.model}`, ...common }),
      detail: { dryRun: true } };
  }
  const apiKey = env.ARENA_MODEL_API_KEY;
  if (!apiKey || !apiKey.trim()) throw new Error('ARENA_MODEL_API_KEY is not set (any value works for a local vLLM); refusing to run');
  const tasks = readFileSync(join(o.envDir, 'arena_env', 'tasks.py'));
  const environment = readFileSync(join(o.envDir, 'arena_env', 'environment.py'));
  const runner = readFileSync(o.runner);
  accessSync(o.tokenizerJson, constants.R_OK); // existence only; the runner verifies its sha256 pin
  const baseUrl = normalizeBaseUrl(o.baseUrl);
  const server = await probeServer(baseUrl, apiKey.trim(), o.model, { fetchImpl });
  const prov = checkProvenance({ envSourceSha: sha256(tasks, environment), runnerSha: sha256(runner), serverSha: server.serverSha,
    model: o.model, ...common });
  return { prov, detail: { tasksPySha256: sha256(tasks), environmentPySha256: sha256(environment), runner: resolve(o.runner),
    baseUrl, servedModels: server.models } };
}
