#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/release.mjs — single-command release orchestrator.
//
// Composes the existing release primitives:
//
//   1. iter 29: version-bump.mjs   (atomic cross-pack semver bump)
//   2. iter 14: preflight.mjs      (run every gate publish.yml would run)
//   3. iter 27: marketplace-entry  (regen the IPFS-pinnable plugin entry)
//   4. iter 25: pack-contents      (verify tarballs contain expected files)
//   5. git: commit + tag (no push by default — `--push` to push)
//
// Usage:
//   node scripts/release.mjs patch                # 0.1.0 -> 0.1.1, no push
//   node scripts/release.mjs minor --push         # bump + push (CI fires)
//   node scripts/release.mjs 0.2.0-rc.1 --dry-run # show plan only
//   node scripts/release.mjs --skip-preflight     # for fast iteration
//   node scripts/release.mjs --skip-marketplace   # for non-marketplace bump
//
// All sub-scripts already exist; this is the orchestration glue.

import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const PUSH = args.includes('--push');
const SKIP_PREFLIGHT = args.includes('--skip-preflight');
const SKIP_MARKETPLACE = args.includes('--skip-marketplace');
const SKIP_PACK = args.includes('--skip-pack');
const target = args.find(a => !a.startsWith('--')) ?? 'patch';

function log(tag, msg) { process.stderr.write(`[release] ${tag}: ${msg}\n`); }

async function run(cmd, scriptArgs = [], opts = {}) {
  const npmCmd = process.platform === 'win32' ? 'cmd.exe' : cmd;
  const finalArgs = process.platform === 'win32' && cmd === 'node'
    ? ['/d', '/s', '/c', 'node', ...scriptArgs]
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', cmd, ...scriptArgs]
      : scriptArgs;
  const actualBin = process.platform === 'win32' ? 'cmd.exe' : cmd;
  const actualArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', cmd, ...scriptArgs]
    : scriptArgs;
  try {
    const r = await execFile(actualBin, actualArgs, {
      cwd: ROOT,
      maxBuffer: 1024 * 1024 * 32,
      windowsHide: true,
      ...opts,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '' };
  }
}

async function gitClean() {
  const r = await run('git', ['status', '--porcelain']);
  return r.stdout.trim() === '';
}

async function gitCurrentBranch() {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.stdout.trim();
}

async function readVersion() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
  return pkg.version;
}

async function main() {
  // Sanity: working tree must be clean OR --dry-run
  if (!DRY) {
    if (!(await gitClean())) {
      log('FAIL', 'working tree dirty — commit or stash first (or use --dry-run)');
      process.exit(1);
    }
  }
  const branch = await gitCurrentBranch();
  log('INFO', `branch=${branch} ${DRY ? '(DRY-RUN)' : ''}`);

  // 1. Version bump
  log('STEP', `1/5  version-bump ${target}`);
  const bumpArgs = ['scripts/version-bump.mjs', target];
  if (DRY) bumpArgs.push('--dry-run');
  const bump = await run('node', bumpArgs);
  if (bump.code !== 0) {
    log('FAIL', `version-bump failed: ${bump.stderr.trim()}`);
    process.exit(1);
  }
  const newVersion = await readVersion();
  log('PASS', `version is now ${newVersion}${DRY ? ' (would be — dry-run)' : ''}`);

  // 2. Preflight
  if (SKIP_PREFLIGHT) {
    log('SKIP', '2/5  preflight (--skip-preflight)');
  } else if (DRY) {
    log('SKIP', '2/5  preflight (--dry-run)');
  } else {
    log('STEP', '2/5  preflight (run every gate publish.yml would run)');
    if (!existsSync(join(ROOT, 'scripts', 'preflight.mjs'))) {
      log('WARN', 'preflight.mjs not found — skipping');
    } else {
      const pre = await run('node', ['scripts/preflight.mjs']);
      if (pre.code !== 0) {
        log('FAIL', `preflight failed — fix before retagging`);
        process.stderr.write(pre.stdout + pre.stderr);
        process.exit(1);
      }
      log('PASS', 'preflight clean');
    }
  }

  // 3. Marketplace entry regeneration
  if (SKIP_MARKETPLACE) {
    log('SKIP', '3/5  marketplace-entry (--skip-marketplace)');
  } else if (DRY) {
    log('SKIP', '3/5  marketplace-entry (--dry-run)');
  } else {
    log('STEP', '3/5  regenerating marketplace-entry.json');
    const me = await run('node', ['scripts/marketplace-entry.mjs']);
    if (me.code !== 0) {
      log('FAIL', `marketplace-entry failed: ${me.stderr.trim()}`);
      process.exit(1);
    }
    log('PASS', 'marketplace entry regenerated');
  }

  // 4. Pack-contents sanity (quick — just confirms tarballs build)
  if (SKIP_PACK) {
    log('SKIP', '4/5  publish-dryrun (--skip-pack)');
  } else if (DRY) {
    log('SKIP', '4/5  publish-dryrun (--dry-run)');
  } else {
    log('STEP', '4/5  publish-dryrun (every package npm pack --dry-run)');
    const pd = await run('node', ['scripts/publish-dryrun.mjs']);
    if (pd.code !== 0) {
      log('FAIL', 'publish-dryrun failed — broken pack(s)');
      process.stderr.write(pd.stderr || pd.stdout);
      process.exit(1);
    }
    log('PASS', 'all packages build-publishable');
  }

  // 5. git commit + tag
  log('STEP', `5/5  git commit + tag v${newVersion}`);
  if (DRY) {
    log('INFO', `would: git add -A && git commit -m 'chore(release): v${newVersion}'`);
    log('INFO', `would: git tag v${newVersion}`);
    if (PUSH) log('INFO', `would: git push origin ${branch} && git push origin v${newVersion}`);
    log('INFO', 'DRY-RUN complete — no git changes made');
    return;
  }

  const add = await run('git', ['add', '-A']);
  if (add.code !== 0) { log('FAIL', 'git add failed'); process.exit(1); }
  const commitMsg = `chore(release): v${newVersion}`;
  const commit = await run('git', ['commit', '-m', commitMsg]);
  if (commit.code !== 0) {
    log('FAIL', `git commit failed: ${commit.stderr.trim()}`);
    process.exit(1);
  }
  log('PASS', `committed: ${commitMsg}`);

  const tag = await run('git', ['tag', `v${newVersion}`]);
  if (tag.code !== 0) {
    log('FAIL', `git tag failed: ${tag.stderr.trim()}`);
    process.exit(1);
  }
  log('PASS', `tagged: v${newVersion}`);

  if (PUSH) {
    log('STEP', `pushing branch + tag to origin`);
    const pushB = await run('git', ['push', 'origin', branch]);
    if (pushB.code !== 0) { log('FAIL', `git push branch failed`); process.exit(1); }
    const pushT = await run('git', ['push', 'origin', `v${newVersion}`]);
    if (pushT.code !== 0) { log('FAIL', `git push tag failed`); process.exit(1); }
    log('PASS', `pushed — publish.yml will fire on the tag`);

    // Optional: stage GitHub release notes from CHANGELOG so the
    // operator can `gh release create v<version> --notes-file -` next.
    // Writes to dist/release-notes-v<version>.md, never invokes gh.
    log('STEP', `staging GitHub release notes`);
    const notes = await run('node', ['scripts/release-notes.mjs', `--version=${newVersion}`]);
    if (notes.code === 0 && notes.stdout) {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(ROOT, 'dist'), { recursive: true });
      const out = join(ROOT, 'dist', `release-notes-v${newVersion}.md`);
      await writeFile(out, notes.stdout, 'utf-8');
      log('PASS', `notes at ${out}`);
      log('INFO', `  Next: gh release create v${newVersion} --notes-file ${out}`);
    } else {
      log('WARN', 'release-notes generation failed (non-fatal)');
    }
  } else {
    log('INFO', `did not push (omit --push intentionally?). Run:`);
    log('INFO', `  git push origin ${branch} && git push origin v${newVersion}`);
  }

  log('INFO', `RELEASE COMPLETE — v${newVersion}`);
}

main().catch(err => {
  log('FAIL', `unexpected: ${err?.stack ?? err}`);
  process.exit(1);
});
