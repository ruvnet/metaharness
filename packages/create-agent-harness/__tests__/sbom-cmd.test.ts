// SPDX-License-Identifier: MIT
//
// `harness sbom` — dev-dependency exclusion must be disclosed, not silent.
// Before this patch, a default-mode (no --include-dev) SBOM had no way to
// tell a reader whether a harness simply had no dev dependencies, or
// whether some were dropped — unlike CycloneDX, which tags dev-scope
// components `scope: excluded` instead of omitting them outright.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sbomCmd, sriToSpdxChecksum } from '../src/sbom-cmd.js';

function sriFor(algo: 'sha1' | 'sha256' | 'sha384' | 'sha512', content: string): string {
  return `${algo}-${createHash(algo).update(content).digest('base64')}`;
}

const dirs: string[] = [];

async function makeHarness(opts: {
  lockPackages?: Record<string, any>;
  devDependencies?: Record<string, string>;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sbom-cmd-'));
  dirs.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'bot',
    dependencies: {},
    devDependencies: opts.devDependencies ?? {},
  }), 'utf-8');
  if (opts.lockPackages) {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'bot', lockfileVersion: 3, packages: opts.lockPackages,
    }), 'utf-8');
  }
  return dir;
}

async function runSbom(dir: string, args: string[] = []): Promise<{ result: any; doc: any }> {
  // Capture stdout JSON since sbomCmd writes the document there when no
  // --out is given.
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout.write as any) = (chunk: any) => { chunks.push(String(chunk)); return true; };
  let result: any;
  try {
    result = await sbomCmd([dir, ...args]);
  } finally {
    process.stdout.write = orig;
  }
  const doc = JSON.parse(chunks.join(''));
  return { result, doc };
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('sbomCmd — dev-dependency disclosure', () => {
  it('discloses the excluded dev-package count by default (lockfile path)', async () => {
    const dir = await makeHarness({
      lockPackages: {
        '': { name: 'bot' },
        'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' },
        'node_modules/vitest': { name: 'vitest', version: '3.2.5', dev: true },
        'node_modules/eslint': { name: 'eslint', version: '9.0.0', dev: true },
      },
    });
    const { result, doc } = await runSbom(dir);
    expect(result.code).toBe(0);
    expect(doc.packages).toHaveLength(1);
    expect(doc.packages[0].name).toBe('left-pad');
    expect(doc.creationInfo.comment).toMatch(/2 devDependency package\(s\) excluded/);
    expect(result.lines.some((l: string) => l.includes('dev-scope excluded: 2 package(s)'))).toBe(true);
  });

  it('omits the disclosure entirely when there is nothing excluded', async () => {
    const dir = await makeHarness({
      lockPackages: {
        '': { name: 'bot' },
        'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' },
      },
    });
    const { doc, result } = await runSbom(dir);
    expect(doc.creationInfo.comment).toBeUndefined();
    expect(result.lines.some((l: string) => l.includes('dev-scope excluded'))).toBe(false);
  });

  it('includes dev packages and drops the disclosure under --include-dev', async () => {
    const dir = await makeHarness({
      lockPackages: {
        '': { name: 'bot' },
        'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' },
        'node_modules/vitest': { name: 'vitest', version: '3.2.5', dev: true },
      },
    });
    const { doc, result } = await runSbom(dir, ['--include-dev']);
    expect(doc.packages.map((p: any) => p.name).sort()).toEqual(['left-pad', 'vitest']);
    expect(doc.creationInfo.comment).toBeUndefined();
    expect(result.lines.some((l: string) => l.includes('dev-scope excluded'))).toBe(false);
  });

  it('approximates the excluded count from package.json when there is no lockfile', async () => {
    const dir = await makeHarness({ devDependencies: { vitest: '^3.0.0', eslint: '^9.0.0' } });
    const { result } = await runSbom(dir);
    expect(result.lines.some((l: string) => l.includes('dev-scope excluded: 2 package(s)'))).toBe(true);
  });
});

describe('sriToSpdxChecksum — SRI integrity -> SPDX checksum', () => {
  it('decodes a real sha512 SRI string into a hex SPDX checksum', () => {
    const sri = sriFor('sha512', 'left-pad@1.3.0');
    const expectedHex = createHash('sha512').update('left-pad@1.3.0').digest('hex');
    expect(sriToSpdxChecksum(sri)).toEqual({ algorithm: 'SHA512', checksumValue: expectedHex });
  });

  it('decodes sha1/sha256/sha384 algorithms too', () => {
    expect(sriToSpdxChecksum(sriFor('sha1', 'x'))?.algorithm).toBe('SHA1');
    expect(sriToSpdxChecksum(sriFor('sha256', 'x'))?.algorithm).toBe('SHA256');
    expect(sriToSpdxChecksum(sriFor('sha384', 'x'))?.algorithm).toBe('SHA384');
  });

  it('prefers the strongest algorithm when multiple SRI entries are present', () => {
    const multi = `${sriFor('sha1', 'x')} ${sriFor('sha512', 'x')}`;
    expect(sriToSpdxChecksum(multi)?.algorithm).toBe('SHA512');
  });

  // 2026-10-28 review (proffesor-for-testing, P2 REMAND): a truncated/
  // malformed SRI payload decodes to a valid base64 buffer of the WRONG
  // length for its claimed algorithm — e.g. 'sha512-YQ==' decodes to 1
  // byte, not SHA-512's real 64 — and the pre-fix code accepted it as a
  // genuine Component Hash just because the buffer was non-empty.
  it('rejects a digest whose decoded length does not match its claimed algorithm (never fabricates a wrong-length hash)', () => {
    expect(sriToSpdxChecksum('sha512-YQ==')).toBeUndefined();
    // a validly-shaped weaker algorithm elsewhere in the same string must
    // still be found — the bad-length sha512 entry must not block it.
    const withValidFallback = `sha512-YQ== ${sriFor('sha256', 'x')}`;
    expect(sriToSpdxChecksum(withValidFallback)?.algorithm).toBe('SHA256');
  });

  // 2026-10-28 review: two SRI entries at the SAME (strongest) algorithm
  // that decode to DIFFERENT digests are genuinely ambiguous per W3C SRI
  // §3.3.4/3.3.5 (either may "match" depending on which artifact is
  // actually fetched) — picking whichever happens to appear first is an
  // arbitrary, order-dependent choice, not a real Component Hash claim.
  it('treats disagreeing same-strength SRI entries as ambiguous and omits the checksum, order-independently', () => {
    const alt = sriFor('sha512', 'alternative-artifact');
    const actual = sriFor('sha512', 'actual-artifact');
    expect(sriToSpdxChecksum(`${alt} ${actual}`)).toBeUndefined();
    expect(sriToSpdxChecksum(`${actual} ${alt}`)).toBeUndefined();
  });

  it('still picks a single value when the same strongest digest is repeated (no real ambiguity)', () => {
    const sri = sriFor('sha512', 'left-pad@1.3.0');
    const expectedHex = createHash('sha512').update('left-pad@1.3.0').digest('hex');
    expect(sriToSpdxChecksum(`${sri} ${sri}`)).toEqual({ algorithm: 'SHA512', checksumValue: expectedHex });
  });

  it('returns undefined (never a fabricated hash) for missing/malformed/empty integrity', () => {
    expect(sriToSpdxChecksum(undefined)).toBeUndefined();
    expect(sriToSpdxChecksum('')).toBeUndefined();
    expect(sriToSpdxChecksum('not-an-sri-string')).toBeUndefined();
    expect(sriToSpdxChecksum('sha512-')).toBeUndefined();
  });
});

describe('sbomCmd — component hash (Component Hash, 2026 CISA/NSA/FBI SBOM minimum elements)', () => {
  it('attaches a real checksum decoded from lockfile integrity, not a fabricated one', async () => {
    const integrity = sriFor('sha512', 'left-pad@1.3.0');
    const dir = await makeHarness({
      lockPackages: {
        '': { name: 'bot' },
        'node_modules/left-pad': { name: 'left-pad', version: '1.3.0', integrity },
      },
    });
    const { doc, result } = await runSbom(dir);
    const expectedHex = createHash('sha512').update('left-pad@1.3.0').digest('hex');
    expect(doc.packages[0].checksums).toEqual([{ algorithm: 'SHA512', checksumValue: expectedHex }]);
    // Must not equal a hash of the integrity string itself (the fabrication
    // this candidate replaces) — only a real digest of the artifact bytes.
    expect(doc.packages[0].checksums[0].checksumValue).not.toBe(
      createHash('sha1').update(integrity).digest('hex'),
    );
    expect(result.lines.some((l: string) => l.includes('component hashes'))).toBe(false);
  });

  it('omits checksums (never fabricates one) when a lockfile entry has no integrity', async () => {
    const dir = await makeHarness({
      lockPackages: {
        '': { name: 'bot' },
        'node_modules/left-pad': { name: 'left-pad', version: '1.3.0' },
      },
    });
    const { doc, result } = await runSbom(dir);
    expect(doc.packages[0].checksums).toBeUndefined();
    expect(result.lines.some((l: string) => l.includes('component hashes: 0/1'))).toBe(true);
  });

  it('discloses 0/N component hashes when there is no lockfile at all', async () => {
    const dir = await makeHarness({});
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'bot', dependencies: { 'left-pad': '^1.3.0' },
    }), 'utf-8');
    const { doc, result } = await runSbom(dir);
    expect(doc.packages[0].checksums).toBeUndefined();
    expect(result.lines.some((l: string) => l.includes('component hashes: 0/1'))).toBe(true);
  });
});
