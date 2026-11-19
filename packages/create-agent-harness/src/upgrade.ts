// SPDX-License-Identifier: MIT
//
// `harness upgrade` — copier-style regenerate-diff-merge.
//
// Algorithm (per ADR-008 + copier docs):
//   1. Read the existing .harness/manifest.json — the source of truth for
//      what choices were made at generation time.
//   2. Re-run the scaffold with the SAME vars against the LATEST template
//      version. Produce fresh fingerprints in-memory.
//   3. Diff old-fingerprints vs new-fingerprints to find changed/added/
//      removed files.
//   4. For each changed file: compare CURRENT (on-disk) vs OLD (manifest)
//      vs NEW (template). Three-way:
//        - file unchanged from old -> overwrite with new
//        - file changed from old, identical to new -> no-op
//        - file changed from old, different from new -> CONFLICT
//   5. Write conflicts as inline Git markers (<<<<<<< current ======= new
//      >>>>>>> upstream) OR as .rej files alongside, depending on user's
//      preference. Default: inline markers for source/text; structured configuration uses .rej files.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { HarnessManifest } from './manifest.js';
import { diffFingerprints, sha256 } from './manifest.js';

export interface UpgradePlan {
  /** Files that exist in old but not in new — should we delete them? */
  removed: string[];
  /** Files that are new in the upstream template. Safe to add. */
  added: string[];
  /** Files where the upstream version differs from what was generated. */
  changed: Array<{
    path: string;
    /** 'clean' = local matches old (safe overwrite); 'conflict' = local diverged. */
    kind: 'clean' | 'conflict';
  }>;
}

/** Structured host/configuration files must stay parseable while conflicts await review. */
export function requiresConfigRejection(path: string): boolean {
  return /\.(?:jsonc?|toml|ya?ml)$/i.test(path);
}

/** New overlay files must not follow user-created links outside the harness. */
function checkUpgradePath(projectDir: string, path: string): void {
  const parts = path.split('/');
  if (isAbsolute(path) || path.includes('\\') || parts.some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe upgrade path: ${path}`);
  }
  let current = projectDir;
  for (const part of parts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Upgrade refuses symbolic link: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Compute the upgrade plan without applying anything.
 *
 * @param projectDir — root of the harness install
 * @param newFiles — fingerprint map for the LATEST template render
 */
export async function planUpgrade(
  projectDir: string,
  newFiles: Record<string, string>,
): Promise<UpgradePlan> {
  const manifestPath = join(projectDir, '.harness', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No .harness/manifest.json at ${projectDir}. Was this directory created by create-agent-harness?`,
    );
  }
  const m: HarnessManifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  const oldFiles = m.files;

  const diff = diffFingerprints(oldFiles, newFiles);

  const plan: UpgradePlan = {
    removed: diff.removed,
    added: [],
    changed: [],
  };

  for (const path of diff.added) {
    checkUpgradePath(projectDir, path);
    const local = join(projectDir, ...path.split('/'));
    if (!existsSync(local)) plan.added.push(path);
    else if (sha256(await readFile(local, 'utf-8')) !== newFiles[path]) {
      // A path new to the template is not necessarily new to the user's repo.
      plan.changed.push({ path, kind: 'conflict' });
    }
  }

  for (const path of diff.changed) {
    checkUpgradePath(projectDir, path);
    const local = join(projectDir, ...path.split('/'));
    let kind: 'clean' | 'conflict' = 'clean';
    if (existsSync(local)) {
      const localHash = sha256(await readFile(local, 'utf-8'));
      if (localHash === newFiles[path]) continue; // already upgraded or resolved by the user
      const oldHash = oldFiles[path];
      if (localHash !== oldHash) {
        // Local has diverged from the originally-generated content.
        kind = 'conflict';
      }
    }
    plan.changed.push({ path, kind });
  }

  return plan;
}

/**
 * Render a plan as a human-readable summary.
 */
export function formatPlan(plan: UpgradePlan): string {
  const lines: string[] = [];
  lines.push(`Upgrade plan:`);
  lines.push(`  ${plan.added.length} added`);
  lines.push(`  ${plan.removed.length} removed`);
  lines.push(`  ${plan.changed.filter(c => c.kind === 'clean').length} clean-overwrite`);
  lines.push(`  ${plan.changed.filter(c => c.kind === 'conflict').length} conflict (will need manual resolution)`);
  if (plan.changed.some(c => c.kind === 'conflict')) {
    lines.push('');
    lines.push('Conflicting files:');
    for (const c of plan.changed.filter(x => x.kind === 'conflict')) {
      lines.push(`  - ${c.path}`);
    }
  }
  return lines.join('\n');
}

/**
 * Write Git-style inline conflict markers into the local file.
 * Used when planUpgrade reports a 'conflict' entry and the user wants
 * inline markers (the default).
 */
export function inlineConflictMarkers(
  local: string,
  upstream: string,
): string {
  return [
    '<<<<<<< current',
    local,
    '=======',
    upstream,
    '>>>>>>> upstream',
    '',
  ].join('\n');
}

/**
 * Apply an upgrade plan. Returns the list of paths actually modified.
 * Best-effort — caller should review the plan first via formatPlan().
 */
export async function applyPlan(
  projectDir: string,
  plan: UpgradePlan,
  newContents: Record<string, string>,
  opts: { conflictStyle?: 'inline' | 'rej' } = {},
): Promise<string[]> {
  const modified: string[] = [];
  const style = opts.conflictStyle ?? 'inline';
  const proposals = new Map<string, string>();

  // Preflight before writing any part of this plan, including .rej destinations.
  for (const path of [...plan.added, ...plan.changed.map(c => c.path)]) {
    checkUpgradePath(projectDir, path);
    if (style === 'rej' || requiresConfigRejection(path)) checkUpgradePath(projectDir, path + '.rej');
  }

  // Reject collisions before modifying any active/generated files. Never truncate
  // earlier proposals: they may contain a user's unfinished merge work.
  for (const c of plan.changed) {
    if (c.kind !== 'conflict' || (style !== 'rej' && !requiresConfigRejection(c.path))) continue;
    const path = c.path + '.rej';
    const target = join(projectDir, ...path.split('/'));
    const upstream = newContents[c.path] ?? '';
    let existing;
    try { existing = lstatSync(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.isFile() || existing.nlink > 1 || await readFile(target, 'utf-8') !== upstream) {
        throw new Error(`Upgrade preserves existing rejection file: ${path}. Review or move it before retrying.`);
      }
      continue; // Identical proposal already exists; leave its bytes and timestamp intact.
    }
    proposals.set(path, upstream);
  }

  // Reserve proposals before other changes. Exclusive creation also protects a
  // file (or link) introduced after preflight by another writer.
  for (const [path, upstream] of proposals) {
    const target = join(projectDir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, upstream, { encoding: 'utf-8', flag: 'wx' });
  }

  for (const path of plan.added) {
    const target = join(projectDir, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    // A file created after planning belongs to its writer, not this upgrade.
    await writeFile(target, newContents[path] ?? '', { encoding: 'utf-8', flag: 'wx' });
    modified.push(path);
  }

  for (const c of plan.changed) {
    const target = join(projectDir, ...c.path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    const upstream = newContents[c.path] ?? '';
    if (c.kind === 'clean') {
      await writeFile(target, upstream, 'utf-8');
      modified.push(c.path);
    } else {
      // Never turn a user's active security policy into invalid JSON.
      if (style === 'inline' && !requiresConfigRejection(c.path)) {
        const local = existsSync(target) ? await readFile(target, 'utf-8') : '';
        await writeFile(target, inlineConflictMarkers(local, upstream), 'utf-8');
      }
      modified.push(c.path);
    }
  }
  return modified;
}
