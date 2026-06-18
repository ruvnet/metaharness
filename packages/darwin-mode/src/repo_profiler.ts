// SPDX-License-Identifier: MIT
//
// Repo profiler (ADR-070 §profile) — distil a repository into the small set of
// signals Darwin Mode needs: which files exist, how to run its tests, which
// package manager it uses, and which files are too risky to ever touch.
//
// Dependency-free (Node built-ins only). The walk is resilient: an unreadable
// directory is skipped rather than fatal, so a hostile or partial tree cannot
// abort a profile.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RepoProfile } from './types.js';

/** Directories never descended into during a profile walk. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.metaharness',
  'dist',
]);

/** File extensions collected by the profiler. */
const COLLECT_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
];

/** Paths that look like they hold deployment, infra, or sensitive material. */
const RISK_PATTERN = /(\.env|secret|credential|token|key|deploy|release|infra)/i;

/** True if a relative path should be collected (by extension). */
function isCollectable(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return COLLECT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Recursively walk `dir`, pushing collectable file paths (relative to `root`)
 * into `out`. Unreadable directories are skipped silently.
 */
async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip, do not fail the profile
  }

  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(root, join(dir, name), out);
    } else if (entry.isFile()) {
      const rel = relative(root, join(dir, name));
      if (isCollectable(rel)) out.push(rel.split(sep).join('/'));
    }
  }
}

/**
 * Resolve the package manager and test command from a parsed package.json.
 * Falls back to 'unknown' / 'npm test' when fields are absent or malformed.
 */
function resolveTooling(pkg: unknown): {
  packageManager: RepoProfile['packageManager'];
  testCommand: string;
} {
  let packageManager: RepoProfile['packageManager'] = 'unknown';
  let hasTestScript = false;

  if (pkg && typeof pkg === 'object') {
    const obj = pkg as Record<string, unknown>;
    const pm = obj.packageManager;
    if (typeof pm === 'string') {
      if (pm.startsWith('pnpm')) packageManager = 'pnpm';
      else if (pm.startsWith('yarn')) packageManager = 'yarn';
      else if (pm.startsWith('npm')) packageManager = 'npm';
    }
    const scripts = obj.scripts;
    if (scripts && typeof scripts === 'object') {
      const test = (scripts as Record<string, unknown>).test;
      if (typeof test === 'string' && test.trim().length > 0) hasTestScript = true;
    }
  }

  let testCommand = 'npm test';
  if (hasTestScript) {
    const runner =
      packageManager === 'pnpm'
        ? 'pnpm'
        : packageManager === 'yarn'
          ? 'yarn'
          : 'npm';
    testCommand = `${runner} test`;
  }
  return { packageManager, testCommand };
}

/**
 * Profile a repository at `root`. Walks the tree (skipping node_modules, .git,
 * .metaharness, dist), collects source/doc/json files, reads package.json if
 * present for tooling, and flags risk files. Never throws on an unreadable tree.
 */
export async function profileRepo(root: string): Promise<RepoProfile> {
  const sourceFiles: string[] = [];
  await walk(root, root, sourceFiles);
  sourceFiles.sort();

  let pkg: unknown = null;
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8');
    pkg = JSON.parse(raw);
  } catch {
    pkg = null; // no package.json, or it is unreadable / malformed
  }

  const { packageManager, testCommand } = resolveTooling(pkg);

  const riskFiles = sourceFiles.filter((f) => RISK_PATTERN.test(f));

  const summary =
    `${sourceFiles.length} files, ${packageManager} package manager, ` +
    `test via "${testCommand}", ${riskFiles.length} risk file(s)`;

  return {
    root,
    packageManager,
    testCommand,
    sourceFiles,
    riskFiles,
    summary,
  };
}
