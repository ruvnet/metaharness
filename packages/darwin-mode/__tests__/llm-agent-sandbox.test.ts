// SPDX-License-Identifier: MIT
//
// $0-cost tests only — the llm-agent sandbox's core value (a real LLM call
// genuinely steered by mutated surface content) is validated manually per
// ADR-273, since asserting on real model output would be neither deterministic
// nor free. This file covers the one deterministic, no-LLM-call path: the
// ADR-071 safety gate must run BEFORE any real spend, exactly like every other
// sandbox mode.
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVariantTaskLlmAgent, DEFAULT_LLM_AGENT_TASKS } from '../src/llm-agent-sandbox.js';
import type { HarnessVariant } from '../src/types.js';

function makeVariant(dir: string): HarnessVariant {
  return {
    id: 'g1_v0_test',
    parentId: 'baseline',
    generation: 1,
    dir,
    mutationSurface: 'reviewer',
    mutationSummary: 'test stub',
    createdAt: new Date().toISOString(),
  };
}

describe('runVariantTaskLlmAgent — safety gate precedes any real LLM call', () => {
  let variantDir: string;

  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-llm-agent-'));
  });

  afterEach(async () => {
    await rm(variantDir, { recursive: true, force: true });
  });

  it('disqualifies a variant with blocked content before any real LLM call, exitCode 99', async () => {
    await writeFile(
      join(variantDir, 'reviewer.ts'),
      "// SPDX-License-Identifier: MIT\nexport const policy = require('node:child_process');\n",
      'utf8',
    );
    const variant = makeVariant(variantDir);
    const trace = await runVariantTaskLlmAgent(variant, DEFAULT_LLM_AGENT_TASKS[0], 5_000);

    expect(trace.exitCode).toBe(99);
    expect(trace.blockedActions.length).toBeGreaterThan(0);
    expect(trace.stdout).toBe('');
    expect(trace.durationMs).toBe(0);
  });

  it('disqualifies a variant with a symlink before any real LLM call', async () => {
    // Only assert this on platforms where symlink creation succeeds without
    // elevation (matches the existing __tests__/security/inspect-bypass.test.ts
    // platform tolerance for Windows EPERM).
    let symlinked = true;
    try {
      const { symlink } = await import('node:fs/promises');
      await writeFile(join(variantDir, 'planner.ts'), '// SPDX-License-Identifier: MIT\n', 'utf8');
      await rm(join(variantDir, 'planner.ts'));
      await symlink(join(variantDir, 'reviewer.ts'), join(variantDir, 'planner.ts')).catch(() => {
        symlinked = false;
      });
    } catch {
      symlinked = false;
    }
    if (!symlinked) return; // platform cannot create symlinks without elevation; not this module's concern
    await writeFile(join(variantDir, 'reviewer.ts'), '// SPDX-License-Identifier: MIT\n', 'utf8');

    const variant = makeVariant(variantDir);
    const trace = await runVariantTaskLlmAgent(variant, DEFAULT_LLM_AGENT_TASKS[0], 5_000);

    expect(trace.exitCode).toBe(99);
    expect(trace.blockedActions.some((f) => f.includes('symlink'))).toBe(true);
  });
});

describe('DEFAULT_LLM_AGENT_TASKS', () => {
  it('is a non-empty suite with a well-formed desiredAnswer per task', () => {
    expect(DEFAULT_LLM_AGENT_TASKS.length).toBeGreaterThan(0);
    for (const task of DEFAULT_LLM_AGENT_TASKS) {
      expect(['YES', 'NO']).toContain(task.desiredAnswer);
      expect(task.prompt.length).toBeGreaterThan(0);
    }
  });
});
