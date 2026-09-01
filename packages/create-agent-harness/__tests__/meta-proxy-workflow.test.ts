// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('Meta-Proxy native lifecycle gate', () => {
  it('is a durable required macOS CI job rather than an opt-in-only local test', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(workflow).toMatch(/meta-proxy-launchagent:\n[\s\S]*runs-on: macos-latest/);
    expect(workflow).toMatch(/RUN_REAL_LAUNCHD_ACCEPTANCE: ['"]1['"]/);
    expect(workflow).toContain('meta-proxy-launchagent.real.test.ts');
    expect(workflow).toMatch(/ci-pass:\n[\s\S]*needs:.*meta-proxy-launchagent/);
  });

  it('is a durable required Windows CI job rather than unit mocks only', () => {
    const workflow = readFileSync(
      fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');

    expect(workflow).toMatch(/meta-proxy-scheduled-task:\n[\s\S]*runs-on: windows-latest/);
    expect(workflow).toMatch(/RUN_REAL_SCHEDULED_TASK_ACCEPTANCE: ['"]1['"]/);
    expect(workflow).toContain('meta-proxy-scheduled-task.real.test.ts');
    expect(workflow).toMatch(/ci-pass:\n[\s\S]*needs:.*meta-proxy-scheduled-task/);
  });
});

describe('Meta-Proxy pin-drift watcher', () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
      .replace(/\r\n/g, '\n');

  // #174 — the watcher's decisions used to be inline shell in the cron workflow, where nothing
  // exercised them. Keeping the logic in a script is what makes it testable at all, so guard it.
  it('runs its comparison through the tested script rather than inline shell', () => {
    const workflow = read('proxy-pin-drift.yml');

    expect(workflow).toContain('node scripts/proxy-pin-drift.mjs');
    expect(workflow).toMatch(/permissions:\n[\s\S]*issues: write/);
    expect(workflow).toMatch(/GITHUB_REPOSITORY: \$\{\{ github\.repository \}\}/);
    expect(workflow).not.toContain('gh release list');
  });

  it('keeps the watcher gate in CI so its branches cannot silently rot again', () => {
    expect(read('ci.yml')).toContain('node scripts/proxy-pin-drift.test.mjs');
  });
});
