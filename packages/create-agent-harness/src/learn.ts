// SPDX-License-Identifier: MIT
//
// `metaharness learn` — the ADR-235 managed-learning command surface.
//
// This is a THIN, repo-checkout-gated delegate to the GEPA learning harness at
// `packages/darwin-mode/bench/swebench/gepa/learn.mjs` (ADR-228). The harness needs the
// repo's bench scripts + Docker + the SWE-bench dataset, so it CANNOT ship in the npm
// tarball — the CLI locates a metaharness repo checkout (walking up from cwd, or via the
// METAHARNESS_REPO env var) and spawns `node learn.mjs <args>` with stdio inherited.
// It re-implements NO learn logic.
//
// House rules enforced here:
//   - $0 by default: without `--run`, `--dry-run` is ALWAYS passed to learn.mjs (prints
//     the plan, spends nothing). `--run` is the only way to unlock real spend.
//   - Secret hygiene: an `--api-key-env` value names an env var that holds a key — it is
//     forwarded to learn.mjs (which keeps it out of its own logs) and is NEVER echoed,
//     logged, or interpolated into any message by this module.
//   - `--seed cand6` resolves to the PACKAGED promoted cand-6 genome
//     (genomes/genome-promoted-cand6-edit-by-midpoint.json — the first holdout-confirmed
//     cheap-tier policy, see genomes/README.md). Absent --seed ⇒ learn.mjs's default seed.
//
// The managed-service path (gateway-side learn jobs, ADR-235 §9) is the follow-up; today
// `--via-gateway` only routes the ROLLOUTS through the cognitum meta-llm Completions API.
//
// Everything except the final spawn is a pure function, unit-tested $0 in
// __tests__/learn.test.ts.

import { existsSync } from 'node:fs';
import { dirname, join, resolve, parse as parsePath, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Packaged genomes live at packages/create-agent-harness/genomes/, one level above dist/. */
const GENOMES_ROOT = resolve(__dirname, '..', 'genomes');

/** Where the learning harness lives inside a metaharness repo checkout. */
export const LEARN_MJS_REL = join(
  'packages', 'darwin-mode', 'bench', 'swebench', 'gepa', 'learn.mjs',
);

// The cognitum meta-llm Completions API backing --via-gateway (ADR-203/204). Mirrors the
// constants in packages/darwin-mode/bench/swebench/gepa/overnight-train.mjs. The key lives
// ONLY in the named env var and is never logged by this module or by learn.mjs.
export const GATEWAY_BASE_URL = 'https://apicompletions-63rzcdswba-uc.a.run.app/v1';
export const GATEWAY_API_KEY_ENV = 'COGNITUM_DEV_KEY';

/** Packaged seed aliases → tarball-shipped genome files (resolved against GENOMES_ROOT). */
export const PACKAGED_SEEDS: Record<string, string> = {
  cand6: 'genome-promoted-cand6-edit-by-midpoint.json',
};

export interface LearnArgs {
  host?: string;
  model?: string;
  slice?: string;
  seed?: string;
  trainFirst?: string;
  maxCost?: string;
  viaGateway: boolean;
  run: boolean;
  /** Unrecognized `--flag [value]` pairs, forwarded to learn.mjs verbatim. */
  passthrough: string[];
  errors: string[];
}

/** Flags whose next token is a value (for pass-through parsing). */
const VALUE_FLAGS = new Set([
  '--host', '--model', '--slice', '--manifest', '--seed', '--train-first', '--max-cost',
  // learn.mjs pass-throughs we forward untouched:
  '--reflection-model', '--max-candidates', '--max-steps', '--concurrency',
  '--per-eval-max-cost', '--run-id', '--vertical', '--language', '--task-class',
  '--base-url', '--api-key-env', '--work-dir', '--out', '--report',
]);

/** Parse `metaharness learn` argv. Pure. */
export function parseLearnArgs(rest: string[]): LearnArgs {
  const out: LearnArgs = { viaGateway: false, run: false, passthrough: [], errors: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a) continue;
    const takeValue = (): string | undefined => {
      const v = rest[++i];
      if (v === undefined) out.errors.push(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--host': out.host = takeValue(); break;
      case '--model': out.model = takeValue(); break;
      case '--slice':
      case '--manifest': out.slice = takeValue(); break;
      case '--seed': out.seed = takeValue(); break;
      case '--train-first': out.trainFirst = takeValue(); break;
      case '--max-cost': out.maxCost = takeValue(); break;
      case '--via-gateway': out.viaGateway = true; break;
      case '--run': out.run = true; break;
      case '--dry-run': break; // dry-run is the default; absorb it silently
      default:
        out.passthrough.push(a);
        if (VALUE_FLAGS.has(a)) {
          const v = takeValue();
          if (v !== undefined) out.passthrough.push(v);
        }
    }
  }
  return out;
}

/**
 * Locate the GEPA learning harness. Honors `env.METAHARNESS_REPO` first, then walks up
 * from `startDir` looking for LEARN_MJS_REL. Returns the absolute learn.mjs path or null.
 * Pure given the injected `exists` predicate.
 */
export function findLearnHarness(
  startDir: string,
  env: Record<string, string | undefined> = {},
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (env.METAHARNESS_REPO) {
    const p = join(resolve(env.METAHARNESS_REPO), LEARN_MJS_REL);
    return exists(p) ? p : null;
  }
  let dir = resolve(startDir);
  const { root } = parsePath(dir);
  for (;;) {
    const p = join(dir, LEARN_MJS_REL);
    if (exists(p)) return p;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/**
 * Resolve `--seed`. `cand6` (any case) → the packaged promoted genome; any other value
 * passes through unchanged (learn.mjs resolves relative paths against its bench dir);
 * undefined → undefined (learn.mjs uses its default frozen seed). Pure.
 */
export function resolveSeed(
  seed: string | undefined,
  genomesRoot: string = GENOMES_ROOT,
): string | undefined {
  if (seed === undefined) return undefined;
  const packaged = PACKAGED_SEEDS[seed.toLowerCase()];
  return packaged ? join(genomesRoot, packaged) : seed;
}

/**
 * Assemble the argv for `node learn.mjs`. Pure.
 *
 * $0-default rule: `--dry-run` is appended UNLESS args.run is true. `--via-gateway`
 * expands to `--base-url` + `--api-key-env` (cognitum meta-llm Completions API) unless the
 * caller already supplied either flag explicitly.
 */
export function buildLearnArgs(args: LearnArgs, seedPath?: string): string[] {
  const out: string[] = [];
  if (args.host !== undefined) out.push('--host', args.host);
  if (args.model !== undefined) out.push('--model', args.model);
  if (args.slice !== undefined) out.push('--slice', args.slice);
  if (seedPath !== undefined) out.push('--seed', seedPath);
  if (args.trainFirst !== undefined) out.push('--train-first', args.trainFirst);
  if (args.maxCost !== undefined) out.push('--max-cost', args.maxCost);
  if (args.viaGateway) {
    if (!args.passthrough.includes('--base-url')) out.push('--base-url', GATEWAY_BASE_URL);
    if (!args.passthrough.includes('--api-key-env')) out.push('--api-key-env', GATEWAY_API_KEY_ENV);
  }
  out.push(...args.passthrough);
  if (!args.run) out.push('--dry-run'); // $0 by default — real spend only behind --run
  return out;
}

/** The actionable no-repo message (no stack trace — printed and exited cleanly). Pure. */
export function repoRequiredMessage(): string[] {
  return [
    '`metaharness learn` requires a metaharness repo checkout.',
    '',
    'The learning harness (GEPA + SWE-bench + Docker) is too heavy to ship in the npm',
    'package, so this command runs against a local clone of the repo:',
    '',
    '  git clone https://github.com/ruvnet/metaharness.git',
    '  cd metaharness',
    '  npx metaharness learn --host <h> --model <m> --slice <manifest>',
    '',
    'Alternatively point METAHARNESS_REPO at an existing checkout:',
    '',
    '  METAHARNESS_REPO=/path/to/metaharness npx metaharness learn ...',
    '',
    'The managed-service path — gateway-side learn jobs, no local checkout needed — is the',
    'ADR-235 follow-up and is not available yet.',
  ];
}

/**
 * `metaharness learn` entrypoint: gate on a repo checkout, resolve the seed, then spawn
 * `node learn.mjs <args>` with stdio inherited, propagating its exit code.
 */
export async function learnCmd(
  rest: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  // bin.js historically discards main()'s return value (usage exits 0). A learn run —
  // especially a real --run — must propagate failure to CI, so this command sets
  // process.exitCode itself (scoped: no other subcommand's behavior changes).
  const code = await runLearn(rest, opts);
  process.exitCode = code;
  return code;
}

async function runLearn(
  rest: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const args = parseLearnArgs(rest);
  if (args.errors.length) {
    for (const e of args.errors) console.error(`metaharness learn: ${e}`);
    return 2;
  }

  const learnMjs = findLearnHarness(cwd, env);
  if (!learnMjs) {
    for (const line of repoRequiredMessage()) console.error(line);
    return 2;
  }

  const seedPath = resolveSeed(args.seed);
  if (seedPath !== undefined && isAbsolute(seedPath) && !existsSync(seedPath)) {
    console.error(`metaharness learn: seed genome not found at ${seedPath}`);
    return 2;
  }

  const spawnArgs = buildLearnArgs(args, seedPath);
  if (!args.run) {
    console.error('[metaharness learn] $0 mode — forwarding --dry-run (pass --run to spend).');
  }
  // NOTE: spawnArgs may carry an --api-key-env pair; never log spawnArgs. learn.mjs
  // applies the same rule to its own output.
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['--no-warnings', learnMjs, ...spawnArgs], {
    stdio: 'inherit',
    env: env as NodeJS.ProcessEnv,
  });
  if (r.error) {
    console.error(`metaharness learn: failed to launch harness: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}
