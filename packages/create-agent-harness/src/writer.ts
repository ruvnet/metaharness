// SPDX-License-Identifier: MIT
//
// Filesystem writer. Atomically writes a RenderedFile[] to disk under a
// target directory. "Atomic" here means: stage everything in a temp dir,
// then rename to the target on success. A failure mid-stream leaves the
// target untouched.

import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RenderedFile } from './walker.js';

export interface WriteOptions {
  /** Overwrite an existing directory? Defaults to false (refuse to overwrite). */
  force?: boolean;
}

/**
 * Write a RenderedFile[] to `targetDir`. Stages in a temp dir first; only
 * renames into place on success.
 *
 * Returns the list of paths written (relative to targetDir).
 */
export async function writeAtomic(
  targetDir: string,
  files: RenderedFile[],
  opts: WriteOptions = {},
): Promise<string[]> {
  if (existsSync(targetDir) && !opts.force) {
    throw new Error(`${targetDir} already exists. Pass --force to overwrite.`);
  }

  // GH #42: stage ADJACENT to the target (same parent dir), not in os.tmpdir().
  // On Windows the temp dir is often on a different drive (C:) than the target
  // (D:), and `rename` across devices throws EXDEV. Staging next to the target
  // keeps the rename on one filesystem, so it stays atomic AND cross-drive-safe.
  const parent = dirname(resolve(targetDir));
  await mkdir(parent, { recursive: true });
  const staging = join(parent, `.create-agent-harness-${randomBytes(6).toString('hex')}`);
  await mkdir(staging, { recursive: true });

  try {
    for (const f of files) {
      const dst = join(staging, ...f.path.split('/'));
      await mkdir(dirname(dst), { recursive: true });
      await writeFile(dst, f.content, 'utf-8');
    }

    if (existsSync(targetDir) && opts.force) {
      await rm(targetDir, { recursive: true, force: true });
    }
    try {
      await rename(staging, targetDir);
    } catch (err) {
      // Belt-and-suspenders: if the parent is itself a mount boundary (rename
      // still EXDEV), fall back to a recursive copy + remove. Loses the atomic
      // guarantee but completes the scaffold.
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await cp(staging, targetDir, { recursive: true });
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      } else {
        throw err;
      }
    }
  } catch (err) {
    // Best-effort cleanup; ignore failures in the cleanup itself.
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return files.map(f => f.path);
}
