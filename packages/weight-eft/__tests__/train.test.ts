// SPDX-License-Identifier: MIT
//
// Tests for the LoRA training runner: dry-run emits a valid plan; a real run
// refuses without BOTH a GPU AND the --train flag; the 7-14B size gate rejects
// 32B. All $0 — no training, no GPU job.

import { describe, it, expect } from 'vitest';
import {
  sftConfig,
  dpoConfig,
  buildCommand,
  buildPlan,
  runTraining,
  twoStagePlan,
  assertTunableSize,
  type BaseModelSpec,
} from '../src/train.js';

const QWEN: BaseModelSpec = { id: 'Qwen/Qwen2.5-Coder-7B-Instruct', paramsB: 7 };
const GLM: BaseModelSpec = { id: 'THUDM/glm-4-9b', paramsB: 9 };
const QWEN32: BaseModelSpec = { id: 'Qwen/Qwen2.5-Coder-32B', paramsB: 32 };

describe('train runner — size gate (7-14B only)', () => {
  it('accepts a 7-14B class model', () => {
    expect(() => assertTunableSize(QWEN)).not.toThrow();
    expect(() => assertTunableSize(GLM)).not.toThrow();
  });
  it('REJECTS a 32B model (it spills a 16GB GPU, §59)', () => {
    expect(() => assertTunableSize(QWEN32)).toThrow(/14.*B band|32B/i);
  });
  it('REJECTS a NaN paramsB (a malformed --params-b flag must fail loud, not silently pass)', () => {
    const BAD: BaseModelSpec = { id: 'typo/model', paramsB: NaN };
    expect(() => assertTunableSize(BAD)).toThrow(/NaN/);
  });
  it('REJECTS an Infinity paramsB', () => {
    const BAD: BaseModelSpec = { id: 'typo/model', paramsB: Infinity };
    expect(() => assertTunableSize(BAD)).toThrow(/Infinity/);
  });
});

describe('train runner — dry-run emits a valid plan', () => {
  it('default (no --train) returns status:plan and a runnable command', () => {
    const cfg = sftConfig(QWEN, '/tmp/sft.jsonl', 'glm-sft');
    const run = runTraining(cfg); // no opts → dry-run
    expect(run.status).toBe('plan');
    expect(run.plan.command).toContain('ruvllm microlora sft');
    expect(run.plan.command).toContain('--base Qwen/Qwen2.5-Coder-7B-Instruct');
    expect(run.plan.command).toContain('--data /tmp/sft.jsonl');
    expect(run.plan.summary).toContain('SFT LoRA');
  });

  it('a DPO plan starts from the SFT adapter (the on-policy reference)', () => {
    const cfg = dpoConfig(QWEN, '/tmp/dpo.jsonl', 'glm-sft-dpo', 'glm-sft');
    const cmd = buildCommand(cfg);
    expect(cmd).toContain('ruvllm microlora dpo');
    expect(cmd).toContain('--init-from glm-sft');
    // DPO uses a smaller LR than SFT
    expect(cfg.learningRate).toBeLessThan(sftConfig(QWEN, '/x', 'y').learningRate);
  });

  it('twoStagePlan chains SFT → SFT+DPO adapters', () => {
    const plans = twoStagePlan(QWEN, '/tmp/sft.jsonl', '/tmp/dpo.jsonl', 'cheap');
    expect(plans.sft.config.outputAdapter).toBe('cheap-sft');
    expect(plans.dpo.config.outputAdapter).toBe('cheap-sft-dpo');
    expect(plans.dpo.config.initFromAdapter).toBe('cheap-sft');
  });
});

describe('train runner — GPU gate (refuses to actually train without GPU+flag)', () => {
  it('--train WITHOUT a GPU/endpoint is REFUSED (no training happens)', () => {
    const cfg = sftConfig(QWEN, '/tmp/sft.jsonl', 'glm-sft');
    const run = runTraining(cfg, {
      train: true,
      detectGpu: () => ({ available: false, detail: 'no GPU in test' }),
    });
    expect(run.status).toBe('refused');
    expect(run.reason).toMatch(/refusing to train/i);
  });

  it('--train WITH a detected GPU/endpoint is permitted (returns the exec command)', () => {
    const cfg = sftConfig(QWEN, '/tmp/sft.jsonl', 'glm-sft');
    const run = runTraining(cfg, {
      train: true,
      detectGpu: () => ({ available: true, detail: 'endpoint http://localhost:11434' }),
    });
    expect(run.status).toBe('trained');
    expect(run.reason).toContain('ruvllm microlora sft');
  });

  it('without --train, a GPU presence does NOT trigger training (dry-run wins)', () => {
    const cfg = sftConfig(QWEN, '/tmp/sft.jsonl', 'glm-sft');
    const run = runTraining(cfg, {
      detectGpu: () => ({ available: true, detail: 'gpu present' }),
    });
    expect(run.status).toBe('plan'); // explicit flag is required
  });
});

describe('train runner — plan is the artifact even on refusal', () => {
  it('a refused run still carries the full plan', () => {
    const cfg = sftConfig(GLM, '/tmp/sft.jsonl', 'glm-sft');
    const run = runTraining(cfg, { train: true, detectGpu: () => ({ available: false, detail: 'none' }) });
    expect(run.plan.command.length).toBeGreaterThan(0);
    expect(buildPlan(cfg).command).toBe(run.plan.command);
  });
});
