#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { evaluateReleaseClaimGate } from '../packages/avo/dist/index.js';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_FILES = 16;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function repositoryFile(root, requested, maximumBytes) {
  if (typeof requested !== 'string' || requested.length === 0 || isAbsolute(requested)) {
    throw new Error('claim-gate paths must be non-empty repository-relative paths');
  }
  const candidate = resolve(root, requested);
  const lexical = relative(root, candidate);
  if (lexical === '..' || lexical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`claim-gate path escapes repository: ${requested}`);
  }
  const resolved = await realpath(candidate);
  const physical = relative(root, resolved);
  if (physical === '..' || physical.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`claim-gate symlink escapes repository: ${requested}`);
  }
  const details = await stat(resolved);
  if (!details.isFile() || details.size > maximumBytes) {
    throw new Error(`claim-gate file is not a bounded regular file: ${requested}`);
  }
  return resolved;
}

async function readJson(root, requested, maximumBytes) {
  const path = await repositoryFile(root, requested, maximumBytes);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function artifactHash(root, requested) {
  const path = await repositoryFile(root, requested, MAX_ARTIFACT_BYTES);
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  return `sha256:${digest}`;
}

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function main() {
  const root = await realpath(process.cwd());
  const manifestPath = option('--manifest') ?? 'packages/avo/release-claims.json';
  const manifest = await readJson(root, manifestPath, MAX_MANIFEST_BYTES);
  const packageManifest = await readJson(root, 'packages/avo/package.json', MAX_MANIFEST_BYTES);
  const evidenceFiles = manifest.evidenceFiles ?? [];
  if (!Array.isArray(evidenceFiles) || evidenceFiles.length > MAX_EVIDENCE_FILES) {
    throw new Error(`evidenceFiles must be an array with at most ${MAX_EVIDENCE_FILES} entries`);
  }
  const evidenceBundles = await Promise.all(
    evidenceFiles.map((path) => readJson(root, path, MAX_EVIDENCE_BYTES)),
  );
  if (!Array.isArray(manifest.claimSurfaces) || manifest.claimSurfaces.length > 32) {
    throw new Error('claimSurfaces must be a bounded array');
  }
  const claimSurfaces = await Promise.all(manifest.claimSurfaces.map(async (path) => ({
    path,
    text: await readFile(await repositoryFile(root, path, 2 * 1024 * 1024), 'utf8'),
  })));
  const trustPolicy = typeof manifest.trustPolicyFile === 'string'
    ? await readJson(root, manifest.trustPolicyFile, MAX_MANIFEST_BYTES)
    : undefined;
  const currentSourceSha = option('--sha')
    ?? process.env.AVO_RELEASE_SHA
    ?? process.env.GITHUB_SHA
    ?? currentCommit();
  const currentPackageVersion = typeof packageManifest.version === 'string'
    ? packageManifest.version
    : undefined;
  const artifactPath = option('--artifact') ?? process.env.AVO_RELEASE_TARBALL;
  const currentPackageArtifactHash = artifactPath
    ? await artifactHash(root, artifactPath)
    : undefined;
  const trustedPolicyHash = option('--trusted-policy-hash')
    ?? process.env.AVO_CLAIM_TRUST_POLICY_HASH;
  const verdict = evaluateReleaseClaimGate({
    currentSourceSha,
    currentPackageVersion,
    currentPackageArtifactHash,
    manifest,
    evidenceBundles,
    trustPolicy,
    trustedPolicyHash,
    claimSurfaces,
  });
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!verdict.allowed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`avo claim gate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
