#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// weight-eft CLI — export | train | eval | status.
//
// Also the delegation target for `metaharness weight-eft <...>` (the umbrella
// package forwards here). Everything is $0 by default: `export` reads an
// archive JSON and writes SFT/DPO JSONL; `train` is a dry-run plan unless
// --train AND a GPU/endpoint are present; `eval` folds outcome JSON into the
// cost-Pareto delta; `status` prints the recipe + guard summary.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportTrainingData, sftToJsonl, dpoToJsonl } from './export.js';
import {
  sftConfig,
  dpoConfig,
  buildPlan,
  runTraining,
  twoStagePlan,
  defaultDetectGpu,
  type BaseModelSpec,
} from './train.js';
import { costParetoDelta } from './eval.js';
import type { DarwinTrajectory } from './types.js';
import type { CascadeOutcome } from './eval.js';

export interface CliResult {
  code: number;
  lines: string[];
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}

/** `weight-eft export --archive a.json --eval-holdout h.json --out-dir ./out` */
export async function exportCmd(args: string[]): Promise<CliResult> {
  const archivePath = flag(args, '--archive');
  const holdoutPath = flag(args, '--eval-holdout');
  const outDir = flag(args, '--out-dir') ?? '.';
  const maxTokens = flag(args, '--max-tokens');
  const truncate = has(args, '--truncate');
  if (!archivePath) {
    return { code: 2, lines: ['Usage: weight-eft export --archive <archive.json> --eval-holdout <holdout.json> [--out-dir <dir>] [--max-tokens N] [--truncate]'] };
  }
  const archive = JSON.parse(await readFile(resolve(archivePath), 'utf8')) as DarwinTrajectory[];
  const evalHoldout: string[] = holdoutPath
    ? (JSON.parse(await readFile(resolve(holdoutPath), 'utf8')) as string[])
    : [];
  const result = exportTrainingData(archive, {
    evalHoldout,
    maxTokens: maxTokens ? Number(maxTokens) : undefined,
    truncateOverLength: truncate,
  });
  const outDirAbs = resolve(outDir);
  await mkdir(outDirAbs, { recursive: true });
  const sftPath = resolve(outDirAbs, 'sft.jsonl');
  const dpoPath = resolve(outDirAbs, 'dpo.jsonl');
  const reportPath = resolve(outDirAbs, 'export-report.json');
  await writeFile(sftPath, sftToJsonl(result.sft));
  await writeFile(dpoPath, dpoToJsonl(result.dpo));
  await writeFile(reportPath, JSON.stringify(result.report, null, 2));
  const r = result.report;
  return {
    code: 0,
    lines: [
      `weight-eft export (contamination guard ENFORCED):`,
      `  trajectories in:   ${r.totalTrajectories}`,
      `  excluded (holdout): ${r.excludedByHoldout}   (train/eval disjointness)`,
      `  dropped over-len:  ${r.droppedOverLength}    truncated: ${r.truncatedOverLength}`,
      `  reward-hack drops: ${r.droppedRewardHacked}    (gold-read / verification-tamper / sandbox-escape)`,
      `  SFT rows:          ${r.sftRows} → ${sftPath}`,
      `  DPO rows:          ${r.dpoRows} → ${dpoPath}   (on-policy cheap-vs-cheap only)`,
      `  report:            ${reportPath}`,
    ],
  };
}

/** `weight-eft train --base <id> --params-b N --sft sft.jsonl [--dpo dpo.jsonl] --adapter <prefix> [--train]` */
export async function trainCmd(args: string[]): Promise<CliResult> {
  const baseId = flag(args, '--base') ?? 'Qwen/Qwen2.5-Coder-7B-Instruct';
  const paramsB = Number(flag(args, '--params-b') ?? '7');
  const sftData = flag(args, '--sft');
  const dpoData = flag(args, '--dpo');
  const adapter = flag(args, '--adapter') ?? 'cheap-tier';
  const doTrain = has(args, '--train');
  const base: BaseModelSpec = { id: baseId, paramsB };
  const lines: string[] = [];

  if (!sftData) {
    return { code: 2, lines: ['Usage: weight-eft train --base <id> --params-b N --sft <sft.jsonl> [--dpo <dpo.jsonl>] --adapter <prefix> [--train]'] };
  }

  const gpu = defaultDetectGpu();
  lines.push(`weight-eft train (${doTrain ? '--train requested' : 'DRY-RUN — emit plan only'}):`);
  lines.push(`  GPU/endpoint: ${gpu.available ? 'available — ' : 'NOT available — '}${gpu.detail}`);

  if (dpoData) {
    const plans = twoStagePlan(base, sftData, dpoData, adapter);
    for (const stage of [plans.sft, plans.dpo]) {
      lines.push(`  PLAN ${stage.summary}`);
      lines.push(`       ${stage.command}`);
    }
    if (doTrain) {
      const sftRun = runTraining(plans.sft.config, { train: true });
      lines.push(`  SFT: ${sftRun.status}${sftRun.reason ? ' — ' + sftRun.reason : ''}`);
      const dpoRun = runTraining(plans.dpo.config, { train: true });
      lines.push(`  DPO: ${dpoRun.status}${dpoRun.reason ? ' — ' + dpoRun.reason : ''}`);
    }
  } else {
    const plan = buildPlan(sftConfig(base, sftData, `${adapter}-sft`));
    lines.push(`  PLAN ${plan.summary}`);
    lines.push(`       ${plan.command}`);
    if (doTrain) {
      const run = runTraining(plan.config, { train: true });
      lines.push(`  SFT: ${run.status}${run.reason ? ' — ' + run.reason : ''}`);
    }
  }
  return { code: 0, lines };
}

/** `weight-eft eval --base-outcomes b.json --adapter-outcomes a.json` */
export async function evalCmd(args: string[]): Promise<CliResult> {
  const basePath = flag(args, '--base-outcomes');
  const adapterPath = flag(args, '--adapter-outcomes');
  if (!basePath || !adapterPath) {
    return { code: 2, lines: ['Usage: weight-eft eval --base-outcomes <base.json> --adapter-outcomes <adapter.json>'] };
  }
  const baseOutcomes = JSON.parse(await readFile(resolve(basePath), 'utf8')) as CascadeOutcome[];
  const adapterOutcomes = JSON.parse(await readFile(resolve(adapterPath), 'utf8')) as CascadeOutcome[];
  const d = costParetoDelta(baseOutcomes, adapterOutcomes);
  return {
    code: 0,
    lines: [
      `weight-eft eval (cost-Pareto, NOT hard-tail):`,
      `  cheap-resolve lift:      ${(d.cheapResolveLift * 100).toFixed(1)}pp`,
      `  escalation reduction:    ${(d.escalationRateReduction * 100).toFixed(1)}pp  (the cost-Pareto win)`,
      `  cost/resolved reduction: $${d.costPerResolvedReduction.toFixed(4)}`,
      `  resolve-rate delta:      ${(d.resolveRateDelta * 100).toFixed(1)}pp  (expected ≈0 — ceiling unmoved)`,
      `  verdict: ${d.verdict}`,
    ],
  };
}

export function statusCmd(): CliResult {
  return {
    code: 0,
    lines: [
      `@metaharness/weight-eft — evolutionary fine-tuning (ADR-198)`,
      ``,
      `THESIS: distill the archive into the open cheap tier (GLM/Qwen) via LoRA so`,
      `the cost-cascade escalates to a frontier model LESS often. Cost-Pareto axis,`,
      `NOT the frontier ceiling — a 7-14B tune will not crack the hard tail.`,
      ``,
      `DATA RECIPE:`,
      `  SFT = ALL gold-resolved trajectories (cheap-own AND frontier-escalation;`,
      `        frontier successes for off-policy-safe DISTILLATION).`,
      `  DPO = ON-POLICY cheap-vs-cheap pairs ONLY (chosen=resolved, rejected=failed,`,
      `        same model + same instance). No frontier-chosen pairs (off-policy).`,
      ``,
      `GUARDS:`,
      `  - Contamination: strict train/eval instance-ID disjointness (throws on overlap).`,
      `  - Long-context: drop/truncate over-budget trajectories, always reported.`,
      `  - Tool-call fidelity: tool_calls preserved (never stringified).`,
      ``,
      `TRAIN: GPU-gated. Dry-run (plan) unless --train AND a GPU/endpoint is detected.`,
      `       Target 7-14B (Qwen2.5-Coder-7B / GLM-4-9B), NOT 32B.`,
      ``,
      `Subcommands: export | train | eval | status`,
    ],
  };
}

export async function dispatch(sub: string | undefined, args: string[]): Promise<CliResult> {
  switch (sub) {
    case 'export':
      return exportCmd(args);
    case 'train':
      return trainCmd(args);
    case 'eval':
      return evalCmd(args);
    case 'status':
    case undefined:
    case '--help':
    case '-h':
      return statusCmd();
    default:
      return { code: 2, lines: [`Unknown subcommand: ${sub}`, `Run 'weight-eft status' for usage.`] };
  }
}

// Direct CLI entry (when invoked as the `weight-eft` bin).
// npm installs bins as symlinks, so compare real paths: a raw `file://${argv[1]}`
// check never matches through node_modules/.bin and the CLI silently did nothing.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [, , sub, ...rest] = process.argv;
  dispatch(sub, rest)
    .then((r) => {
      for (const l of r.lines) console.log(l);
      process.exit(r.code);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
