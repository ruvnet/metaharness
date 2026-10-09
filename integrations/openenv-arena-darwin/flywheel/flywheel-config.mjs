// Flywheel orchestrator config: defaults, deep merge of ~/.config/arena-flywheel/config.json, strict
// validation of the sections the orchestrator owns. Sections owned by sibling modules (`gpu`, `caps`,
// `arena`, `checks`, `notify`) are passed through untouched for them to validate.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkTaskLimits } from './incumbent.mjs';

export class ConfigError extends Error {}

export const defaultConfigPath = (env = process.env, home = homedir()) =>
  join(env.XDG_CONFIG_HOME || join(home, '.config'), 'arena-flywheel', 'config.json');
export const defaultStateDir = (env = process.env, home = homedir()) =>
  join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'arena-flywheel');

export function defaultConfig(home = homedir()) {
  return {
    mode: 'dry-run', // dry-run never POSTs; only "auto" may submit, and only when decideSubmit says so
    schedule: { onCalendar: '*-*-* 10:17:00 America/Toronto' }, // informational; systemd/arena-flywheel.timer owns it
    image: 'ghcr.io/ruvnet/metaharness-arena@sha256:2f3f12b986574ac99ecae451f47408ea5c8cc12c4fa27bf1c5cafa6880676b37',
    dataset: 'ruv/metaharness-arena-tasks',
    submission: {
      idPrefix: 'metaharness-darwin', namePrefix: 'MetaHarness Darwin',
      // Arena defaults, explicit. rollout_wall_s is NOT measured by Darwin for 8-16k budgets: review before auto.
      taskLimits: { reset_wall_s: 180, rollout_wall_s: 1800, verifier_wall_s: 120, tool_wall_s: 120, tool_calls_total: 128,
        tool_calls_per_minute: 60, memory_gib: 2, cpu_floor_vcpus: 1, workspace_gib: 10 },
    },
    // searchAttempts: episodes per cell in the search (run-darwin's own --attempts; maxTotalNewCells counts runner calls =
    // attempts/4 per cell). Timeouts fit the unit's TimeoutStartSec=8h; GPU phases are also capped by the rental deadline.
    darwin: { generations: 2, children: 3, concurrency: 1, maxTotalNewCells: 14, seed: null, searchSeedBase: 700000, searchAttempts: 4,
      evaluatorTimeoutMs: 3 * 3600 * 1000, searchTimeoutMs: 5 * 3600 * 1000, gpuDeadlineMarginMs: 10 * 60 * 1000 },
    confirmation: { attempts: 8, seedBase0: 2_000_000, stride: 100, evaluateTimeoutMs: 3 * 3600 * 1000 },
    // rentGpuInDryRun: rehearse the GPU lifecycle with dry-run (fake) rows. Spends money, can never submit.
    evaluator: { envDir: null, python: null, tokenizerJson: null, tokenizerSha256: null, runner: null,
      model: 'qwen38', modelRevision: '1d4bf0f2', contextTokens: 16384, concurrency: 2,
      cacheDir: join(home, '.local', 'state', 'arena-flywheel', 'cell-cache'), dryRun: false, rentGpuInDryRun: false },
    // candidateBudget: alpha is split over it. null = gate.mjs v2's own default, the search's evaluated-candidate count.
    gate: { keyDir: join(home, '.config', 'arena-flywheel', 'gate-key'), expectPublicKey: null,
      alpha: 0.05, lambda: 0.5, candidateBudget: null },
    slot: { skipGpuWhenBusy: true, proceedIfFreeWithinS: 6 * 3600 },
    poll: { attempts: 20, intervalS: 60 },
    // gpu.mjs GPU_DEFAULTS overrides (validated by gpu.mjs). localPort is pinned because lib/provenance.mjs hashes the
    // base URL (incl. port) into serverSha: an ephemeral port would change every cell key per rental (no cache reuse)
    // and break a resumed confirmation's preregistered provenance. 8100 = evaluator.mjs's default --base-url.
    gpu: { localPort: 8100 },
    caps: { dailyUsd: 12, totalUsd: 200 }, // mapped to gpu dailyCapUsd/totalCapUsd unless gpu sets them
    checks: {}, // render-and-check.mjs overrides; mode auto REQUIRES {"expectEnvCommit": "<full sha of checks.envDir>"}
    arena: { user: 'ruv' }, // leaderboard user for the day-1 check; {"base": ...} only for loopback fakes
  };
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  return out;
}

const tilde = (v, home) => (typeof v === 'string' && v.startsWith('~/') ? join(home, v.slice(2)) : v);

export function validateConfig(c, home = homedir()) {
  const errs = [];
  const need = (ok, msg) => { if (!ok) errs.push(msg); };
  const int = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  const str = v => typeof v === 'string' && v.length > 0;
  need(c.mode === 'dry-run' || c.mode === 'auto', 'mode must be "dry-run" or "auto"');
  need(/^(ghcr\.io|docker\.io)\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(c.image ?? ''), 'image must be ghcr.io|docker.io/...@sha256:<64 hex>');
  need(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(c.dataset ?? ''), 'dataset must be owner/name (no revision)');
  need(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(c.submission?.idPrefix ?? ''), 'submission.idPrefix invalid');
  need(str(c.submission?.namePrefix) && c.submission.namePrefix.length <= 150, 'submission.namePrefix must be 1..150 chars');
  try { checkTaskLimits(c.submission?.taskLimits); } catch (e) { errs.push(e.message); }
  const d = c.darwin ?? {};
  need(int(d.generations, 0, 50) && int(d.children, 1, 64) && int(d.concurrency, 1, 16), 'darwin.generations/children/concurrency out of range');
  need(int(d.maxTotalNewCells, 0, 1000), 'darwin.maxTotalNewCells must be 0..1000');
  need(d.seed === null || int(d.seed, 0, 2 ** 31 - 1), 'darwin.seed must be null or an integer');
  need(int(d.searchSeedBase, 0, 2 ** 40), 'darwin.searchSeedBase must be a non-negative integer');
  need(int(d.searchAttempts, 4, 64) && d.searchAttempts % 4 === 0, 'darwin.searchAttempts must be a multiple of 4 in 4..64');
  need(int(d.evaluatorTimeoutMs, 1000, 7 * 86400e3) && int(d.searchTimeoutMs, 1000, 14 * 86400e3), 'darwin timeouts out of range');
  need(int(d.gpuDeadlineMarginMs, 0, 3600e3), 'darwin.gpuDeadlineMarginMs must be 0..3600000');
  const q = c.confirmation ?? {};
  need(int(q.attempts, 4, 64) && q.attempts % 4 === 0, 'confirmation.attempts must be a multiple of 4 in 4..64');
  need(int(q.stride, q.attempts ?? 4, 1e6), 'confirmation.stride must be >= attempts');
  need(int(q.seedBase0, 0, 2 ** 40), 'confirmation.seedBase0 must be a non-negative integer');
  need(int(q.evaluateTimeoutMs, 1000, 7 * 86400e3), 'confirmation.evaluateTimeoutMs out of range');
  // Confirmation seeds (any date, ~100 years) must never overlap the search block [searchSeedBase, +64).
  const confLo = q.seedBase0, confHi = q.seedBase0 + q.stride * 36_600;
  need(!(confLo < d.searchSeedBase + 64 && d.searchSeedBase < confHi), 'confirmation seed range overlaps darwin.searchSeedBase');
  const ev = c.evaluator ?? {};
  for (const k of ['envDir', 'python', 'tokenizerJson', 'tokenizerSha256', 'runner']) need(ev[k] === null || str(ev[k]), `evaluator.${k} must be null or a path/string`);
  need(str(ev.model) && str(ev.modelRevision) && str(ev.cacheDir), 'evaluator.model/modelRevision/cacheDir required');
  need(int(ev.contextTokens, 1, 32768) && int(ev.concurrency, 1, 16), 'evaluator.contextTokens/concurrency out of range');
  need(typeof ev.dryRun === 'boolean' && typeof ev.rentGpuInDryRun === 'boolean', 'evaluator.dryRun/rentGpuInDryRun must be boolean');
  const g = c.gate ?? {};
  need(str(g.keyDir), 'gate.keyDir required (outside the repo)');
  need(g.expectPublicKey === null || /^[A-Za-z0-9+/]{40,}={0,2}$/.test(g.expectPublicKey ?? ''), 'gate.expectPublicKey must be null or base64 SPKI');
  need(typeof g.alpha === 'number' && g.alpha > 0 && g.alpha < 1 && typeof g.lambda === 'number' && g.lambda > 0 && g.lambda < 1, 'gate.alpha/lambda must be in (0,1)');
  need(g.candidateBudget === null || int(g.candidateBudget, 1, 1000), 'gate.candidateBudget must be null (gate default) or an integer >= 1');
  need(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(c.arena?.user ?? ''), 'arena.user must be a Hugging Face user name');
  need(typeof c.slot?.skipGpuWhenBusy === 'boolean' && int(c.slot?.proceedIfFreeWithinS, 0, 86400), 'slot.skipGpuWhenBusy/proceedIfFreeWithinS invalid');
  need(int(c.poll?.attempts, 0, 240) && int(c.poll?.intervalS, 1, 3600), 'poll.attempts 0..240 and poll.intervalS 1..3600');
  for (const k of ['gpu', 'checks', 'arena']) need(isObj(c[k]), `${k} must be an object`);
  // auto runs the env lane's scripts (renderer, replay, validator) on every tick: they must be a pinned, clean commit
  need(c.mode !== 'auto' || /^[0-9a-f]{40}$/.test(c.checks?.expectEnvCommit ?? ''),
    'mode "auto" requires checks.expectEnvCommit (the full 40-hex commit of checks.envDir; the worktree must be clean)');
  need([c.caps?.dailyUsd, c.caps?.totalUsd].every(v => typeof v === 'number' && Number.isFinite(v) && v > 0), 'caps.dailyUsd/totalUsd must be finite > 0');
  if (errs.length) throw new ConfigError(`invalid flywheel config: ${errs.join('; ')}`);
  for (const k of ['envDir', 'python', 'tokenizerJson', 'runner', 'cacheDir']) ev[k] = tilde(ev[k], home);
  g.keyDir = tilde(g.keyDir, home);
  return c;
}

/** Defaults <- file (if present). A missing file means pure defaults (mode dry-run). */
export function loadConfig(path = defaultConfigPath(), { home = homedir() } = {}) {
  let user = {};
  if (existsSync(path)) {
    try { user = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new ConfigError(`unreadable config ${path}: ${e.message}`); }
    if (!isObj(user)) throw new ConfigError(`config ${path} must be a JSON object`);
  }
  return validateConfig(deepMerge(defaultConfig(home), user), home);
}
