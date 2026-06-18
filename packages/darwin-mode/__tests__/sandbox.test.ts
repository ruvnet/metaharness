// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runVariantTask, runVariantTasks } from '../src/sandbox.js';
import { FILE_BY_SURFACE } from '../src/safety.js';
import type { HarnessVariant, RepoProfile } from '../src/types.js';

/** Safe, dependency-free stub content for an approved mutation-surface file. */
const SAFE_STUB = `// SPDX-License-Identifier: MIT
export const policy = { name: 'stub' };
`;

/** Write the seven approved files (clean stubs) into a variant directory. */
async function writeApprovedVariant(dir: string): Promise<void> {
  for (const filename of Object.values(FILE_BY_SURFACE)) {
    await writeFile(join(dir, filename), SAFE_STUB, 'utf8');
  }
}

function makeVariant(dir: string, id = 'g1_v0_test'): HarnessVariant {
  return {
    id,
    parentId: 'baseline',
    generation: 1,
    dir,
    mutationSurface: 'planner',
    mutationSummary: 'test stub',
    createdAt: new Date().toISOString(),
  };
}

function makeProfile(root: string, testCommand: string): RepoProfile {
  return {
    root,
    packageManager: 'npm',
    testCommand,
    sourceFiles: [],
    riskFiles: [],
    summary: 'test repo',
  };
}

describe('runVariantTask — execution', () => {
  let variantDir: string;
  let repoDir: string;

  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-variant-'));
    repoDir = await mkdtemp(join(tmpdir(), 'darwin-repo-'));
    await writeApprovedVariant(variantDir);
  });

  afterEach(async () => {
    await rm(variantDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('runs a passing command and records exitCode 0, durationMs, timedOut false', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node --version');

    const trace = await runVariantTask(variant, profile, 'task-pass');

    expect(trace.exitCode).toBe(0);
    expect(trace.timedOut).toBe(false);
    expect(trace.blockedActions).toEqual([]);
    expect(typeof trace.durationMs).toBe('number');
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.stdout).toContain('v'); // node prints e.g. "v20.x.x"
    expect(trace.variantId).toBe('g1_v0_test');
    expect(trace.taskId).toBe('task-pass');
    expect(typeof trace.startedAt).toBe('string');
    expect(typeof trace.finishedAt).toBe('string');
  });

  it('records a non-zero exit code from a failing command without throwing', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node -e process.exit(3)');

    const trace = await runVariantTask(variant, profile, 'task-fail');

    expect(trace.exitCode).toBe(3);
    expect(trace.timedOut).toBe(false);
    expect(trace.blockedActions).toEqual([]);
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runVariantTask — safety gate (disqualification)', () => {
  let variantDir: string;
  let repoDir: string;

  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-variant-'));
    repoDir = await mkdtemp(join(tmpdir(), 'darwin-repo-'));
  });

  afterEach(async () => {
    await rm(variantDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('disqualifies a variant with an unapproved file and runs NO command', async () => {
    await writeApprovedVariant(variantDir);
    // An extra, unapproved file trips the ADR-071 allowlist.
    await writeFile(join(variantDir, 'rogue.ts'), SAFE_STUB, 'utf8');

    const variant = makeVariant(variantDir);
    // A command that would visibly succeed IF it ran — it must not run.
    const profile = makeProfile(repoDir, 'node --version');

    const trace = await runVariantTask(variant, profile, 'task-dq');

    expect(trace.exitCode).toBe(99);
    expect(trace.timedOut).toBe(false);
    expect(trace.blockedActions.length).toBeGreaterThan(0);
    expect(trace.stdout).toBe(''); // no command output ⇒ nothing ran
    // stderr equals the joined findings — proof the gate short-circuited.
    expect(trace.stderr).toBe(trace.blockedActions.join('\n'));
    expect(trace.blockedActions.join(' ')).toContain('rogue.ts');
  });
});

describe('runVariantTask — environment scrubbing', () => {
  let variantDir: string;
  let repoDir: string;

  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-variant-'));
    repoDir = await mkdtemp(join(tmpdir(), 'darwin-repo-'));
    await writeApprovedVariant(variantDir);
    process.env.DARWIN_SECRET = 'leak';
  });

  afterEach(async () => {
    delete process.env.DARWIN_SECRET;
    await rm(variantDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('does not leak ambient env vars into the variant command', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(
      repoDir,
      'node -e console.log(process.env.DARWIN_SECRET)',
    );

    const trace = await runVariantTask(variant, profile, 'task-env');

    expect(trace.exitCode).toBe(0);
    expect(trace.stdout).not.toContain('leak');
    expect(trace.stdout.trim()).toBe('undefined');
  });

  it('exposes the scrubbed identifying variables to the command', async () => {
    const variant = makeVariant(variantDir, 'g2_v1_abc');
    const profile = makeProfile(
      repoDir,
      'node -e console.log(process.env.METAHARNESS_VARIANT,process.env.METAHARNESS_TASK,process.env.NODE_ENV)',
    );

    const trace = await runVariantTask(variant, profile, 'task-ids');

    expect(trace.exitCode).toBe(0);
    expect(trace.stdout.trim()).toBe('g2_v1_abc task-ids test');
  });
});

describe('runVariantTasks — sequential batch', () => {
  let variantDir: string;
  let repoDir: string;

  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-variant-'));
    repoDir = await mkdtemp(join(tmpdir(), 'darwin-repo-'));
    await writeApprovedVariant(variantDir);
  });

  afterEach(async () => {
    await rm(variantDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('returns one trace per task id, in order', async () => {
    const variant = makeVariant(variantDir);
    const profile = makeProfile(repoDir, 'node --version');

    const traces = await runVariantTasks(variant, profile, ['a', 'b', 'c']);

    expect(traces.map((t) => t.taskId)).toEqual(['a', 'b', 'c']);
    expect(traces.every((t) => t.exitCode === 0)).toBe(true);
  });
});
