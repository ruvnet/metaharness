// SPDX-License-Identifier: MIT
//
// Resource-bound checks (ADR-071 hard caps + sandbox maxBuffer):
//
//   1. inspectVariant rejects a >256KB file by SIZE and does NOT read it: the
//      oversized file's content contains a blocked pattern (`process.env`); if
//      the file were read, a *content* finding would appear. We assert the size
//      finding is present and NO content finding for that file is — proving the
//      `stat.size > MAX_FILE_BYTES` → `continue` short-circuit (no full read).
//   2. inspectVariant flags a directory with 33 entries (> MAX_FILES = 32).
//   3. A sandbox run whose command floods stdout past a small `maxBufferBytes`
//      is bounded: it terminates (does not hang/OOM) and is captured as a
//      non-zero trace rather than an exception.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectVariant, FILE_BY_SURFACE } from '../../src/safety.js';
import { runVariantTask } from '../../src/sandbox.js';
import type { HarnessVariant, RepoProfile } from '../../src/types.js';

const SAFE_STUB = "// SPDX-License-Identifier: MIT\nexport const policy = { name: 'stub' };\n";

async function writeApprovedVariant(dir: string): Promise<void> {
  for (const filename of Object.values(FILE_BY_SURFACE)) {
    await writeFile(join(dir, filename), SAFE_STUB, 'utf8');
  }
}

function makeVariant(dir: string): HarnessVariant {
  return {
    id: 'g1_v0_bounds',
    parentId: 'baseline',
    generation: 1,
    dir,
    mutationSurface: 'planner',
    mutationSummary: 'bounds test',
    createdAt: new Date().toISOString(),
  };
}

function makeProfile(root: string, testCommand: string): RepoProfile {
  return { root, packageManager: 'npm', testCommand, sourceFiles: [], riskFiles: [], summary: 'bounds repo' };
}

describe('inspectVariant — file SIZE cap (256KB) short-circuits before reading', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'darwin-bounds-size-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags an oversized approved file by size and does NOT read its content', async () => {
    // Use an APPROVED filename so the only findings can be size/content — this
    // isolates the size-vs-content question. Content embeds a blocked pattern.
    const big = 'process.env.SECRET; // ' + 'A'.repeat(300 * 1024); // ~300KB > 256KB
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(256 * 1024);
    await writeFile(join(dir, FILE_BY_SURFACE.planner), big, 'utf8');

    const findings = await inspectVariant(dir);

    const planner = FILE_BY_SURFACE.planner;
    const sizeFinding = findings.find((f) => f.includes(planner) && f.includes('too large'));
    const contentFinding = findings.find((f) => f.includes(planner) && f.includes('blocked content'));

    expect(sizeFinding).toBeDefined();
    expect(sizeFinding).toContain(String(256 * 1024)); // references the 262144-byte cap
    // The decisive assertion: the file was NOT read, so no content finding fired
    // even though the bytes contain `process.env`.
    expect(contentFinding).toBeUndefined();
  });
});

describe('inspectVariant — file COUNT cap (MAX_FILES = 32)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'darwin-bounds-count-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('flags a directory with 33 entries as too many', async () => {
    for (let i = 0; i < 33; i++) {
      await writeFile(join(dir, `f${i}.ts`), SAFE_STUB, 'utf8');
    }
    const findings = await inspectVariant(dir);
    const tooMany = findings.find((f) => f.includes('too many entries'));
    expect(tooMany).toBeDefined();
    expect(tooMany).toContain('33');
    expect(tooMany).toContain('32');
  });
});

describe('sandbox — maxBuffer bounds a flooding command (no hang / no OOM)', () => {
  let variantDir: string;
  let repoDir: string;
  beforeEach(async () => {
    variantDir = await mkdtemp(join(tmpdir(), 'darwin-bounds-var-'));
    repoDir = await mkdtemp(join(tmpdir(), 'darwin-bounds-repo-'));
    await writeApprovedVariant(variantDir);
  });
  afterEach(async () => {
    await rm(variantDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('kills a process that exceeds a small maxBufferBytes and records a failure trace', async () => {
    const variant = makeVariant(variantDir);
    // Print ~5MB to stdout; cap the buffer at 64KB so execFile aborts (ENOBUFS).
    const profile = makeProfile(
      repoDir,
      "node -e process.stdout.write('x'.repeat(5*1024*1024))",
    );

    const start = performance.now();
    const trace = await runVariantTask(variant, profile, 'task-flood', {
      maxBufferBytes: 64 * 1024,
      taskTimeoutMs: 15_000,
    });
    const elapsed = performance.now() - start;

    // It must terminate quickly (bounded), never throw, and be a non-zero trace.
    expect(elapsed).toBeLessThan(15_000); // did not hang to the timeout
    expect(trace.exitCode).not.toBe(0); // killed / failed, not a clean pass
    // Captured stdout cannot have grown unbounded past the cap (allow generous slack).
    expect(Buffer.byteLength(trace.stdout, 'utf8')).toBeLessThan(5 * 1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(
      `[bounds.maxBuffer] elapsed=${elapsed.toFixed(0)}ms exitCode=${trace.exitCode} timedOut=${trace.timedOut} stdoutBytes=${Buffer.byteLength(trace.stdout, 'utf8')}`,
    );
  });
});
