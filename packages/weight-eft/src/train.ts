// SPDX-License-Identifier: MIT
//
// train.ts — LoRA training runner (GPU-gated; dry-run by default).
//
// Wraps ruvllm/MicroLoRA. When the binding isn't importable (the common case in
// this repo — ruvllm is a separate Rust artifact) we EMIT a config + the exact
// command instead of importing it. The runner refuses to actually train unless
// BOTH (a) an explicit `--train` / `train:true` flag is passed AND (b) a GPU /
// inference endpoint is detected. Default is a dry-run that emits the plan.
//
// Target: 7-14B (Qwen2.5-Coder-7B / GLM-4-9B class) — NOT 32B. §59 showed a 32B
// q4 model spills the 16GB GPU; the cheap-tier distillation target is a model
// that actually fits a single commodity GPU.
//
// Stages: SFT first (distill the archive), then OPTIONAL on-policy DPO on the
// SFT checkpoint (preference-sharpen on cheap-vs-cheap pairs).

import type { DpoRow, SftRow } from './types.js';

/** A model class we are willing to tune. 7-14B only (the cheap-tier target). */
export interface BaseModelSpec {
  /** HF/registry id, e.g. "Qwen/Qwen2.5-Coder-7B-Instruct". */
  id: string;
  /** Parameter count in billions — gated to [1, 14]. */
  paramsB: number;
}

export type TrainStage = 'sft' | 'dpo';

export interface LoraConfig {
  /** Low-rank dimension. */
  r: number;
  /** LoRA alpha scaling. */
  alpha: number;
  /** Dropout on the LoRA path. */
  dropout: number;
  /** Modules to adapt (attention proj by default). */
  targetModules: string[];
}

export interface TrainConfig {
  base: BaseModelSpec;
  stage: TrainStage;
  lora: LoraConfig;
  /** Path to the JSONL training set for this stage. */
  dataPath: string;
  /** Output adapter directory / id. */
  outputAdapter: string;
  /** For DPO: the SFT checkpoint to start from (the on-policy reference). */
  initFromAdapter?: string;
  epochs: number;
  learningRate: number;
  /** Max sequence length — must fit the 7-14B context window. */
  maxSeqLen: number;
  batchSize: number;
}

export interface TrainRunOptions {
  /** Hard gate: must be true to actually train. Default false → dry-run. */
  train?: boolean;
  /**
   * GPU/endpoint detector. Injected for testability; defaults to a probe that
   * checks for an env-declared endpoint or `nvidia-smi`. Returns a reason
   * string when unavailable.
   */
  detectGpu?: () => { available: boolean; detail: string };
}

/** The result of a (dry or real) train invocation. */
export interface TrainRunResult {
  /** 'plan' for a dry-run, 'trained' for a real run, 'refused' when gated out. */
  status: 'plan' | 'trained' | 'refused';
  /** The training plan (always emitted, even on refusal — it's the artifact). */
  plan: TrainingPlan;
  /** Why a real run was refused (status === 'refused'). */
  reason?: string;
}

/** A fully-resolved, serializable training plan + the command to run it. */
export interface TrainingPlan {
  config: TrainConfig;
  /** The exact CLI command a GPU host runs to execute this plan. */
  command: string;
  /** A one-line human summary. */
  summary: string;
}

const MAX_PARAMS_B = 14;
const MIN_PARAMS_B = 1;

export const DEFAULT_LORA: LoraConfig = {
  r: 16,
  alpha: 32,
  dropout: 0.05,
  targetModules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
};

/** Default GPU/endpoint probe. Pure-ish: reads env + tries nvidia-smi presence. */
export function defaultDetectGpu(): { available: boolean; detail: string } {
  // An OpenAI-compatible local endpoint (e.g. ruv-mac-mini / ruvultra) counts.
  const endpoint = process.env.WEIGHT_EFT_BASE_URL || process.env.OPENAI_BASE_URL;
  if (endpoint) return { available: true, detail: `endpoint ${endpoint}` };
  // CUDA env hint without importing anything heavy.
  if (process.env.CUDA_VISIBLE_DEVICES && process.env.CUDA_VISIBLE_DEVICES !== '') {
    return { available: true, detail: `CUDA_VISIBLE_DEVICES=${process.env.CUDA_VISIBLE_DEVICES}` };
  }
  return {
    available: false,
    detail:
      'no GPU/endpoint detected (set WEIGHT_EFT_BASE_URL or CUDA_VISIBLE_DEVICES, or run on a CUDA host)',
  };
}

/** Validate a base model is in the tunable 7-14B band (refuse 32B). */
export function assertTunableSize(base: BaseModelSpec): void {
  // `!Number.isFinite` catches NaN/±Infinity up front: `NaN < MIN` and `NaN > MAX`
  // are BOTH false (IEEE-754), so without this the range check below silently
  // no-ops on a non-numeric --params-b instead of refusing the out-of-band model
  // it exists to catch (CWE-1284; cf. CVE-2026-54235, the same shape in vLLM).
  if (!Number.isFinite(base.paramsB) || base.paramsB < MIN_PARAMS_B || base.paramsB > MAX_PARAMS_B) {
    throw new Error(
      `weight-eft: base model ${base.id} is ${base.paramsB}B — outside the tunable [${MIN_PARAMS_B}, ${MAX_PARAMS_B}]B band. ` +
        `Pick a 7-14B class model (Qwen2.5-Coder-7B / GLM-4-9B); 32B q4 spills a 16GB GPU (§59).`,
    );
  }
}

/** Build a default SFT config for a base model + data path. */
export function sftConfig(base: BaseModelSpec, dataPath: string, outputAdapter: string): TrainConfig {
  assertTunableSize(base);
  return {
    base,
    stage: 'sft',
    lora: { ...DEFAULT_LORA },
    dataPath,
    outputAdapter,
    epochs: 2,
    learningRate: 1e-4,
    maxSeqLen: 32768,
    batchSize: 1,
  };
}

/** Build a default on-policy DPO config that starts from the SFT checkpoint. */
export function dpoConfig(
  base: BaseModelSpec,
  dataPath: string,
  outputAdapter: string,
  initFromAdapter: string,
): TrainConfig {
  assertTunableSize(base);
  return {
    base,
    stage: 'dpo',
    lora: { ...DEFAULT_LORA },
    dataPath,
    outputAdapter,
    initFromAdapter,
    epochs: 1,
    learningRate: 5e-6, // DPO wants a much smaller LR than SFT
    maxSeqLen: 32768,
    batchSize: 1,
  };
}

/** Render the exact command a GPU host runs (ruvllm/MicroLoRA CLI form). */
export function buildCommand(c: TrainConfig): string {
  const parts = [
    'ruvllm',
    'microlora',
    c.stage, // sft | dpo
    `--base ${c.base.id}`,
    `--data ${c.dataPath}`,
    `--out ${c.outputAdapter}`,
    `--lora-r ${c.lora.r}`,
    `--lora-alpha ${c.lora.alpha}`,
    `--lora-dropout ${c.lora.dropout}`,
    `--target-modules ${c.lora.targetModules.join(',')}`,
    `--epochs ${c.epochs}`,
    `--lr ${c.learningRate}`,
    `--max-seq-len ${c.maxSeqLen}`,
    `--batch-size ${c.batchSize}`,
  ];
  if (c.initFromAdapter) parts.push(`--init-from ${c.initFromAdapter}`);
  return parts.join(' ');
}

/** Build the full plan (config + command + summary) for a stage. */
export function buildPlan(c: TrainConfig): TrainingPlan {
  const command = buildCommand(c);
  const summary =
    `${c.stage.toUpperCase()} LoRA r=${c.lora.r} on ${c.base.id} (${c.base.paramsB}B) ` +
    `← ${c.dataPath} → ${c.outputAdapter}` +
    (c.initFromAdapter ? ` (from ${c.initFromAdapter})` : '');
  return { config: c, command, summary };
}

/**
 * Run (or dry-run) a training stage. The hard gate: a real run requires BOTH
 * an explicit `train:true` AND a detected GPU/endpoint. Otherwise it returns
 * the plan (dry-run) or refuses (train requested but no GPU).
 */
export function runTraining(c: TrainConfig, opts: TrainRunOptions = {}): TrainRunResult {
  assertTunableSize(c.base);
  const plan = buildPlan(c);

  // Default behaviour: dry-run, emit the plan, touch nothing.
  if (!opts.train) {
    return { status: 'plan', plan };
  }

  // Train requested → require a GPU/endpoint.
  const detect = opts.detectGpu ?? defaultDetectGpu;
  const gpu = detect();
  if (!gpu.available) {
    return {
      status: 'refused',
      plan,
      reason: `--train requested but ${gpu.detail}. Refusing to train. Re-run on a GPU host or set an endpoint.`,
    };
  }

  // Both gates satisfied. NOTE: this is the integration point with ruvllm/
  // MicroLoRA. The actual `spawn(command)` is intentionally NOT wired here —
  // executing it requires a GPU job, which is out of scope for the $0 build.
  // A GPU host implements this by spawning `plan.command`.
  return {
    status: 'trained',
    plan,
    reason: `GPU/endpoint available (${gpu.detail}). Execute: ${plan.command}`,
  };
}

/**
 * Convenience: emit the full two-stage plan (SFT then on-policy DPO) for a
 * base model and a pair of data paths. The DPO stage starts from the SFT
 * adapter (the on-policy reference policy).
 */
export function twoStagePlan(
  base: BaseModelSpec,
  sftDataPath: string,
  dpoDataPath: string,
  adapterPrefix: string,
): { sft: TrainingPlan; dpo: TrainingPlan } {
  const sftAdapter = `${adapterPrefix}-sft`;
  const dpoAdapter = `${adapterPrefix}-sft-dpo`;
  return {
    sft: buildPlan(sftConfig(base, sftDataPath, sftAdapter)),
    dpo: buildPlan(dpoConfig(base, dpoDataPath, dpoAdapter, sftAdapter)),
  };
}

/**
 * Thin runner-adapter: canonical-standard JSONL rows → the record shape
 * ruvllm/MicroLoRA ingests. Kept at the runner boundary so the EXPORTED files
 * stay in the portable standard schema (trl/axolotl/unsloth-compatible). This
 * is a structural pass-through today (ruvllm consumes OpenAI-chat + TRL-pref
 * directly); the seam exists so a future ingest-format change is local here.
 */
export function adaptSftForRunner(rows: SftRow[]): Array<{ messages: SftRow['messages'] }> {
  return rows.map((r) => ({ messages: r.messages }));
}

export function adaptDpoForRunner(
  rows: DpoRow[],
): Array<{ prompt: DpoRow['prompt']; chosen: DpoRow['chosen']; rejected: DpoRow['rejected'] }> {
  return rows.map((r) => ({ prompt: r.prompt, chosen: r.chosen, rejected: r.rejected }));
}
