#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/publish-workspace.mjs — idempotent workspace publish.
//
// Publishes the curated release set in dependency order, SKIPPING any
// package whose current package.json version is already on the registry.
// This is what lets a `v*.*.*` tag re-run publish.yml safely: before this
// script, `npm publish` 403'd on the first already-published package
// (@metaharness/kernel came before create-agent-harness in the step
// sequence, with no continue-on-error), so a tag could never deliver a
// bump of a later package. See PR #152's release notes for the full
// post-mortem.
//
// Run as: node scripts/publish-workspace.mjs [--dry-run]
// Used as: publish.yml's single publish step (NODE_AUTH_TOKEN in env).

import { readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const DRY = process.argv.includes('--dry-run');

// The same set + order publish.yml shipped as individual steps. Packages
// not listed here (evals-*, flywheel, darwin-mode, redblue, weight-eft, …)
// have their own release cadence and are deliberately NOT published from
// the tag workflow — widen this list consciously, not by directory glob.
export const RELEASE_ORDER = [
  'kernel-js',
  'sdk',
  'host-claude-code',
  'host-codex',
  'host-pi-dev',
  'host-hermes',
  'host-openclaw',
  'host-rvm',
  'host-prime-agent',
  'vertical-base',
  'vertical-trading',
  'field-memory',
  'create-agent-harness',
  'avo',
];

function log(tag, msg) { process.stderr.write(`[publish-workspace] ${tag}: ${msg}\n`); }

/**
 * Pure helper (exported for unit tests): decide whether name@version needs
 * publishing given the outcome of `npm view name@version version`.
 *
 * npm's behavior differs by registry state:
 *   - version published            → exit 0, stdout is the version
 *   - package exists, version not  → exit 0 with EMPTY stdout (npm ≤9)
 *                                    or exit 1 E404 (npm ≥10)
 *   - package never published      → exit 1 E404
 * Anything else (network, auth) is "unknown" — we attempt the publish and
 * let `npm publish` produce the real error rather than guessing.
 */
export function needsPublish({ exitCode, stdout }) {
  const out = (stdout ?? '').trim();
  if (exitCode === 0 && out.length > 0) return false; // already on registry
  return true;
}

async function viewVersion(name, version) {
  const args = ['view', `${name}@${version}`, 'version'];
  const [bin, finalArgs] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args];
  try {
    const { stdout } = await execFile(bin, finalArgs);
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.code ?? 1, stdout: err.stdout ?? '' };
  }
}

async function publishOne(dir, releaseTarball) {
  const args = ['publish'];
  if (releaseTarball) args.push(releaseTarball);
  args.push('--provenance', '--access', 'public');
  if (DRY) args.push('--dry-run');
  const [bin, finalArgs] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args];
  await execFile(bin, finalArgs, { cwd: dir });
}

async function exactAvoReleaseTarball() {
  const requested = process.env.AVO_RELEASE_TARBALL;
  if (!requested) return undefined;
  const resolved = await realpath(resolve(ROOT, requested));
  const repositoryRelative = relative(ROOT, resolved);
  const details = await stat(resolved);
  if (repositoryRelative === '..'
    || repositoryRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || !details.isFile()
    || !resolved.endsWith('.tgz')) {
    throw new Error('AVO_RELEASE_TARBALL must be a repository-confined .tgz file');
  }
  return resolved;
}

async function main() {
  const published = [];
  const skipped = [];
  const failed = [];
  const avoReleaseTarball = await exactAvoReleaseTarball();

  for (const dirName of RELEASE_ORDER) {
    const dir = join(ROOT, 'packages', dirName);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) {
      log('FAIL', `packages/${dirName} missing package.json — release set is stale`);
      failed.push(dirName);
      continue;
    }
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    if (pkg.private === true) {
      log('SKIP', `${pkg.name} is private`);
      skipped.push(pkg.name);
      continue;
    }
    const spec = `${pkg.name}@${pkg.version}`;
    const view = await viewVersion(pkg.name, pkg.version);
    if (!needsPublish(view)) {
      log('SKIP', `${spec} already on registry`);
      skipped.push(spec);
      continue;
    }
    log('PUBLISH', `${spec}${DRY ? ' (dry-run)' : ''}`);
    try {
      await publishOne(dir, dirName === 'avo' ? avoReleaseTarball : undefined);
      published.push(spec);
    } catch (err) {
      // A concurrent publish of the same version loses the race with E403;
      // that means the version IS on the registry, which is the goal state.
      const msg = String(err.stderr ?? err.message ?? err);
      if (msg.includes('E403') && msg.includes('previously published')) {
        log('SKIP', `${spec} raced to already-published (E403) — treating as done`);
        skipped.push(spec);
      } else {
        log('FAIL', `${spec}: ${msg.split('\n').slice(0, 5).join(' | ')}`);
        failed.push(spec);
      }
    }
  }

  log('SUMMARY', `published=${published.length} skipped=${skipped.length} failed=${failed.length}`);
  for (const p of published) log('SUMMARY', `  published ${p}`);
  for (const f of failed) log('SUMMARY', `  FAILED ${f}`);
  if (failed.length > 0) process.exit(1);
  if (published.length === 0) log('SUMMARY', 'nothing to publish — every version already live (idempotent no-op)');
}

// Only run when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { log('FAIL', String(err)); process.exit(1); });
}
