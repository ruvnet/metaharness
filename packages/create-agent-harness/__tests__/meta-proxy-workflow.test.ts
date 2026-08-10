// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Meta-Proxy native lifecycle gate', () => {
  it('is a durable required macOS CI job rather than an opt-in-only local test', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );

    expect(workflow).toMatch(/meta-proxy-launchagent:\n[\s\S]*runs-on: macos-latest/);
    expect(workflow).toMatch(/RUN_REAL_LAUNCHD_ACCEPTANCE: ['"]1['"]/);
    expect(workflow).toContain('meta-proxy-launchagent.real.test.ts');
    expect(workflow).toMatch(/ci-pass:\n[\s\S]*needs:.*meta-proxy-launchagent/);
  });

  it('is a durable required Windows CI job rather than unit mocks only', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    );

    expect(workflow).toMatch(/meta-proxy-scheduled-task:\n[\s\S]*runs-on: windows-latest/);
    expect(workflow).toMatch(/RUN_REAL_SCHEDULED_TASK_ACCEPTANCE: ['"]1['"]/);
    expect(workflow).toContain('meta-proxy-scheduled-task.real.test.ts');
    expect(workflow).toMatch(/ci-pass:\n[\s\S]*needs:.*meta-proxy-scheduled-task/);
  });
});
