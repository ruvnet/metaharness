// SPDX-License-Identifier: MIT
//
// Tests for scripts/sbom.mjs — SPDX-2.3 SBOM generator.

import { describe, it, expect } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// @ts-ignore — JS module
import { createHash } from 'node:crypto';
import { validateSpdx, buildSbomFromRepo, sriToSpdxChecksum } from '../scripts/sbom.mjs';

const execFile = promisify(execFileCb);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts', 'sbom.mjs');

async function runSbom(args: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFile('node', [SCRIPT, ...args], {
      cwd: ROOT, windowsHide: true, maxBuffer: 1024 * 1024 * 16,
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('scripts/sbom.mjs — script', () => {
  it('exists', () => expect(existsSync(SCRIPT)).toBe(true));

  it('--validate-only exits 0 and writes no stdout output', async () => {
    const r = await runSbom(['--validate-only']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('');
    expect(r.stderr).toMatch(/validate-only mode/);
  }, 30_000);

  it('default invocation prints valid JSON to stdout', async () => {
    const r = await runSbom();
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.spdxVersion).toBe('SPDX-2.3');
    expect(parsed.SPDXID).toBe('SPDXRef-DOCUMENT');
    expect(Array.isArray(parsed.packages)).toBe(true);
    expect(parsed.packages.length).toBeGreaterThan(0);
  }, 60_000);

  it('reports the package count to stderr', async () => {
    const r = await runSbom(['--validate-only']);
    expect(r.stderr).toMatch(/SPDX has \d+ packages \(validation OK\)/);
  }, 30_000);
});

describe('SPDX validator', () => {
  it('rejects missing spdxVersion', () => {
    const v = validateSpdx({ SPDXID: 'SPDXRef-DOCUMENT', packages: [] });
    expect(v.ok).toBe(false);
  });

  it('rejects packages without SPDXID', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [{ name: 'x', versionInfo: '1.0.0', externalRefs: [{ referenceLocator: 'pkg:npm/x@1.0.0' }] }],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/SPDXID/);
  });

  it('accepts a well-formed minimal document', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [
        {
          SPDXID: 'SPDXRef-npm-x-1-0-0',
          name: 'x', versionInfo: '1.0.0',
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/x@1.0.0' }],
        },
      ],
    });
    expect(v.ok, v.problems.join(' ')).toBe(true);
  });

  it('rejects external refs that aren\'t pkg: URLs', () => {
    const v = validateSpdx({
      spdxVersion: 'SPDX-2.3',
      SPDXID: 'SPDXRef-DOCUMENT',
      creationInfo: { created: '2026-01-01T00:00:00Z' },
      packages: [
        {
          SPDXID: 'SPDXRef-x-1',
          name: 'x', versionInfo: '1.0.0',
          externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'not-a-purl' }],
        },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/purl/);
  });
});

describe('SBOM builder against the live repo', () => {
  it('includes npm packages', async () => {
    const doc = await buildSbomFromRepo();
    const npmPkgs = doc.packages.filter((p: any) =>
      p.externalRefs?.[0]?.referenceLocator?.startsWith('pkg:npm/'),
    );
    expect(npmPkgs.length).toBeGreaterThan(0);
  });

  it('every package has a purl externalRef', async () => {
    const doc = await buildSbomFromRepo();
    for (const p of doc.packages) {
      expect(p.externalRefs?.[0]?.referenceLocator, p.name).toMatch(/^pkg:(npm|cargo)\//);
    }
  });

  it('package count is consistent: doc.packages.length matches validation count', async () => {
    const doc = await buildSbomFromRepo();
    const v = validateSpdx(doc);
    expect(v.ok, v.problems.join(' ')).toBe(true);
    // every package has unique SPDXID
    const ids = new Set(doc.packages.map((p: any) => p.SPDXID));
    expect(ids.size).toBe(doc.packages.length);
  });

  // iter 64 — apps/web-ui ships to GitHub Pages; its deps belong in the
  // bill of materials for regulated-industry auditors. Before iter 64
  // the SBOM only walked the root workspace and missed jszip, react, etc.
  it('includes apps/web-ui deps (jszip — production-shipped JSZip bundle)', async () => {
    const doc = await buildSbomFromRepo();
    const jszip = doc.packages.find((p: any) => p.name === 'jszip');
    expect(jszip, 'jszip not found in SBOM — apps/web-ui not being scanned').toBeDefined();
    expect(jszip!.versionInfo).toMatch(/^\d+\.\d+\.\d+/);
    expect(jszip!.externalRefs[0].referenceLocator).toMatch(/^pkg:npm\/jszip@/);
  });

  it('includes apps/web-ui deps (react — production-shipped Studio UI)', async () => {
    const doc = await buildSbomFromRepo();
    const react = doc.packages.find((p: any) => p.name === 'react');
    expect(react, 'react not found in SBOM — apps/web-ui not being scanned').toBeDefined();
    expect(react!.versionInfo).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('dedupes packages that appear in multiple lockfiles (no name@version duplicate)', async () => {
    const doc = await buildSbomFromRepo();
    const keys = doc.packages.map((p: any) => `${p.name}@${p.versionInfo}`);
    const dupes = keys.filter((k: string, i: number) => keys.indexOf(k) !== i);
    expect(dupes, `duplicate name@version found: ${dupes.slice(0, 3).join(', ')}`).toEqual([]);
  });

  // 2026-07-29 CISA/NSA/FBI "Minimum Elements for a SBOM" adds Component
  // Hash to the baseline field set. Before this patch, every npm package's
  // `checksums[0].checksumValue` was a SHA1 hash of the `integrity` STRING
  // itself (or of a `name@version` placeholder when integrity was absent)
  // — syntactically valid SPDX shape, but not derivable from, or
  // verifiable against, the real package content at all.
  it('npm package checksums are real digests of integrity data, never a hash-of-the-SRI-string fabrication', async () => {
    const lock = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'package-lock.json'), 'utf-8'));
    const found = Object.entries<any>(lock.packages).find(
      ([p, pkg]: [string, any]) => p && pkg.version && typeof pkg.integrity === 'string' && !pkg.dev,
    );
    expect(found, 'no package-lock.json entry with an integrity field found — fixture assumption broken').toBeDefined();
    const [lockPath, lockPkg] = found!;
    const name = lockPkg.name ?? lockPath.split('node_modules/').pop();

    const doc = await buildSbomFromRepo();
    const match = doc.packages.find((p: any) => p.name === name && p.versionInfo === lockPkg.version);
    expect(match, `${name}@${lockPkg.version} not found in generated SBOM`).toBeDefined();
    expect(Array.isArray(match!.checksums) && match!.checksums.length > 0, 'expected a checksums entry').toBe(true);

    // Independently re-derive the expected digest straight from the SRI
    // integrity string (base64 payload -> hex), bypassing sbom.mjs
    // entirely, and require an exact match — this is the real assertion a
    // fabricated hash-of-the-SRI-string (or hash-of-a-placeholder) cannot
    // pass, unlike a shape-only check.
    const sriMatch = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+=*)/.exec(lockPkg.integrity.trim());
    expect(sriMatch, `unexpected integrity format: ${lockPkg.integrity}`).toBeTruthy();
    const expectedHex = Buffer.from(sriMatch![2], 'base64').toString('hex');
    expect(match!.checksums[0].checksumValue).toBe(expectedHex);
    expect(match!.checksums[0].algorithm).toBe(sriMatch![1].toUpperCase());

    // And explicitly rule out the exact fabrication this candidate replaces:
    // SHA1 of the integrity string itself is a completely different value.
    const fabricated = createHash('sha1').update(lockPkg.integrity).digest('hex');
    expect(match!.checksums[0].checksumValue).not.toBe(fabricated);
  });

  it('cargo packages carry no fabricated checksum (none claimed today — honest omission)', async () => {
    const doc = await buildSbomFromRepo();
    const cargoPkgs = doc.packages.filter((p: any) =>
      p.externalRefs?.[0]?.referenceLocator?.startsWith('pkg:cargo/'),
    );
    for (const p of cargoPkgs) {
      expect(p.checksums).toBeUndefined();
    }
  });

  // 2026-10-28 review (proffesor-for-testing, P2 REMAND), reproduced here
  // against scripts/sbom.mjs's own exported helper (the sibling of the
  // one fixed in sbom-cmd.ts, same bug class in both files).
  it('sriToSpdxChecksum rejects a digest whose decoded length does not match its claimed algorithm', () => {
    expect(sriToSpdxChecksum('sha512-YQ==')).toBeUndefined();
    const sha256 = `sha256-${createHash('sha256').update('x').digest('base64')}`;
    expect(sriToSpdxChecksum(`sha512-YQ== ${sha256}`)?.algorithm).toBe('SHA256');
  });

  it('sriToSpdxChecksum treats disagreeing same-strength SRI entries as ambiguous, order-independently', () => {
    const alt = `sha512-${createHash('sha512').update('alternative-artifact').digest('base64')}`;
    const actual = `sha512-${createHash('sha512').update('actual-artifact').digest('base64')}`;
    expect(sriToSpdxChecksum(`${alt} ${actual}`)).toBeUndefined();
    expect(sriToSpdxChecksum(`${actual} ${alt}`)).toBeUndefined();
  });
});
