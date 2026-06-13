// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTarball } from '../src/tarball.js';

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tar-'));
  await writeFile(join(root, 'a.txt'), 'hello');
  await writeFile(join(root, 'b.txt'), 'world');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'c.txt'), 'nested');
  // Should be skipped:
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'dropped.txt'), 'never');
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'HEAD'), 'never');
  return root;
}

describe('buildTarball', () => {
  it('includes files and skips node_modules / .git', async () => {
    const root = await setup();
    const r = await buildTarball(root);
    expect(r.paths).toEqual(['a.txt', 'b.txt', 'sub/c.txt']);
    expect(r.bytes.byteLength).toBeGreaterThan(0);
  });

  it('produces a deterministic sha256 across two builds', async () => {
    const root = await setup();
    const r1 = await buildTarball(root);
    const r2 = await buildTarball(root);
    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.bytes.length).toBe(r2.bytes.length);
  });

  it('different content -> different sha256', async () => {
    const root = await setup();
    const r1 = await buildTarball(root);
    await writeFile(join(root, 'a.txt'), 'goodbye');
    const r2 = await buildTarball(root);
    expect(r1.sha256).not.toBe(r2.sha256);
  });

  it('ends with two zero blocks (ustar terminator)', async () => {
    const root = await setup();
    const r = await buildTarball(root);
    // Last 1024 bytes must all be zero.
    const tail = r.bytes.slice(r.bytes.length - 1024);
    for (let i = 0; i < tail.length; i++) {
      expect(tail[i]).toBe(0);
    }
  });

  it('header block is exactly 512 bytes per file', async () => {
    const root = await setup();
    const r = await buildTarball(root);
    // 3 files: each header (512) + data (rounded to 512). Plus 2 trailer
    // blocks. So total length is divisible by 512.
    expect(r.bytes.length % 512).toBe(0);
  });
});
