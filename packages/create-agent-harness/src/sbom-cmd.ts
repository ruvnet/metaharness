// SPDX-License-Identifier: MIT
//
// `harness sbom [path] [--out=<file>] [--include-dev]` CLI subcommand.
//
// Generates a SPDX-2.3 Software Bill of Materials for the scaffolded
// harness at <path>. Mirrors scripts/sbom.mjs at the meta-repo level,
// but scoped to ONE harness so the user gets a per-package artifact.
//
// Reads the harness's package-lock.json if present; falls back to
// reading `dependencies` from package.json with caveat.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export type SubcommandResult = { code: number; lines: string[] };

interface SpdxChecksum {
  algorithm: 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512';
  checksumValue: string;
}

interface SpdxPkg {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: string;
  filesAnalyzed: false;
  licenseDeclared: string;
  copyrightText: 'NOASSERTION';
  checksums?: SpdxChecksum[];
  externalRefs: Array<{
    referenceCategory: 'PACKAGE-MANAGER';
    referenceType: 'purl';
    referenceLocator: string;
  }>;
}

function spdxId(prefix: string, name: string, version: string): string {
  return `SPDXRef-${prefix}-${(name + '-' + version).replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

// 2026-07-29 CISA/NSA/FBI "Minimum Elements for a SBOM" (superseding the
// 2021 NTIA baseline) adds Component Hash to the field set every producer
// is expected to populate when data for it exists. npm's own
// package-lock.json already carries that data per-package as an SRI
// string (`<algo>-<base64>`, RFC-ish per the W3C Subresource Integrity
// spec) — this decodes it into the hex-encoded SPDX `checksums` shape
// instead of fabricating or omitting it. A package can carry more than
// one SRI entry (space-separated); the strongest algorithm wins, and a
// digest is only trusted when its decoded length matches that algorithm
// (W3C SRI §3.3.4 lets multiple same-strength entries each independently
// "match" — reviewed 2026-10-28: a truncated/malformed entry at the
// strongest algorithm must not silently win over a shorter-but-valid one,
// and two *disagreeing* same-strength entries are genuinely ambiguous —
// in both cases this returns undefined rather than guessing).
const SRI_ALGO_TO_SPDX: Record<string, SpdxChecksum['algorithm']> = {
  sha512: 'SHA512', sha384: 'SHA384', sha256: 'SHA256', sha1: 'SHA1',
};
const SRI_STRENGTH_ORDER = ['sha512', 'sha384', 'sha256', 'sha1'];
const SRI_DIGEST_LENGTH: Record<string, number> = {
  sha512: 64, sha384: 48, sha256: 32, sha1: 20,
};

export function sriToSpdxChecksum(integrity: unknown): SpdxChecksum | undefined {
  if (typeof integrity !== 'string' || integrity.trim() === '') return undefined;
  const byAlgo = new Map<string, Set<string>>();
  for (const entry of integrity.trim().split(/\s+/)) {
    const m = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+=*)$/.exec(entry);
    if (!m) continue;
    let buf: Buffer;
    try { buf = Buffer.from(m[2], 'base64'); } catch { continue; }
    if (buf.length !== SRI_DIGEST_LENGTH[m[1]]) continue; // wrong length for the claimed algorithm — never a real digest
    if (!byAlgo.has(m[1])) byAlgo.set(m[1], new Set());
    byAlgo.get(m[1])!.add(buf.toString('hex'));
  }
  for (const algo of SRI_STRENGTH_ORDER) {
    const hexes = byAlgo.get(algo);
    if (!hexes || hexes.size === 0) continue;
    if (hexes.size > 1) return undefined; // 2+ disagreeing digests at the strongest available algorithm — ambiguous, don't guess
    return { algorithm: SRI_ALGO_TO_SPDX[algo], checksumValue: [...hexes][0] };
  }
  return undefined;
}

function packagesFromLock(
  lock: any,
  includeDev: boolean,
): { packages: SpdxPkg[]; excludedDevCount: number; missingChecksumCount: number } {
  if (!lock?.packages) return { packages: [], excludedDevCount: 0, missingChecksumCount: 0 };
  const out: SpdxPkg[] = [];
  let excludedDevCount = 0;
  let missingChecksumCount = 0;
  for (const [path, pkg] of Object.entries<any>(lock.packages)) {
    if (!path || path === '') continue;
    if (pkg.dev === true) {
      if (!includeDev) { excludedDevCount++; continue; }
    }
    if (pkg.peer === true || pkg.optional === true) continue;
    const name = pkg.name ?? path.split('node_modules/').pop();
    if (!name || !pkg.version) continue;
    const checksum = sriToSpdxChecksum(pkg.integrity);
    if (!checksum) missingChecksumCount++;
    out.push({
      SPDXID: spdxId('npm', name, pkg.version),
      name,
      versionInfo: pkg.version,
      downloadLocation: pkg.resolved ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseDeclared: typeof pkg.license === 'string' ? pkg.license : 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      ...(checksum ? { checksums: [checksum] } : {}),
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${name}@${pkg.version}`,
      }],
    });
  }
  return { packages: out, excludedDevCount, missingChecksumCount };
}

function packagesFromManifest(pkg: any): SpdxPkg[] {
  const deps = pkg.dependencies ?? {};
  return Object.entries<string>(deps).map(([name, range]) => {
    // Use the declared range as versionInfo when no lockfile is available
    const version = range.replace(/^[\^~><=]+/, '');
    return {
      SPDXID: spdxId('npm', name, version),
      name,
      versionInfo: version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseDeclared: 'NOASSERTION',
      copyrightText: 'NOASSERTION' as const,
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER' as const,
        referenceType: 'purl' as const,
        referenceLocator: `pkg:npm/${name}@${version}`,
      }],
    };
  });
}

export async function sbomCmd(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  const includeDev = args.includes('--include-dev');
  const out = args.find(a => a.startsWith('--out='))?.slice('--out='.length);
  const validateOnly = args.includes('--validate-only');

  const lines: string[] = [`harness sbom — ${dir}`];

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    lines.push(`  no package.json at ${dir} — not a harness or npm package`);
    return { code: 1, lines };
  }
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

  const lockPath = join(dir, 'package-lock.json');
  let packages: SpdxPkg[];
  let source: string;
  let excludedDevCount = 0;
  let missingChecksumCount = 0;
  if (existsSync(lockPath)) {
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    const fromLock = packagesFromLock(lock, includeDev);
    packages = fromLock.packages;
    excludedDevCount = fromLock.excludedDevCount;
    missingChecksumCount = fromLock.missingChecksumCount;
    source = 'package-lock.json';
  } else {
    packages = packagesFromManifest(pkg);
    // No lockfile to introspect per-package `dev` flags — approximate the
    // excluded count from the manifest's own devDependencies block so the
    // disclosure below still fires instead of silently under-reporting.
    if (!includeDev) excludedDevCount = Object.keys(pkg.devDependencies ?? {}).length;
    // No lockfile means no `integrity` (SRI) data exists anywhere to read —
    // every package is missing a real Component Hash, and we disclose that
    // rather than fabricate one (ADR-250 honesty ladder).
    missingChecksumCount = packages.length;
    source = 'package.json dependencies (no lockfile — versions are range strings)';
  }
  lines.push(`  source: ${source}`);
  lines.push(`  packages: ${packages.length}`);
  // CISA/NSA/FBI's 2026-07-29 "Minimum Elements for a SBOM" (superseding
  // NTIA's 2021 baseline) adds Component Hash to the field set. Surface how
  // many packages actually got one from real lockfile integrity data,
  // rather than silently shipping a document that is partially unhashed.
  if (missingChecksumCount > 0) {
    lines.push(`  component hashes: ${packages.length - missingChecksumCount}/${packages.length} (missing: no lockfile integrity data for the rest)`);
  }
  // iter: a reader of the default (no --include-dev) SBOM had no way to tell
  // whether the harness simply has no dev dependencies, or whether some were
  // silently dropped — unlike CycloneDX, which tags dev-scope components
  // `scope: excluded` instead of omitting them outright. devDependencies run
  // during npm ci/test/build (CI/build-time attack surface — e.g. the 2026
  // node-ipc and Shai-Hulud npm supply-chain incidents exfiltrated CI
  // credentials via compromised build-time packages) even though they never
  // ship to production, so their exclusion is worth surfacing, not hiding.
  if (!includeDev && excludedDevCount > 0) {
    lines.push(`  dev-scope excluded: ${excludedDevCount} package(s) — re-run with --include-dev for a build/CI-time-complete SBOM`);
  }

  if (validateOnly) {
    lines.push('  --validate-only — shape OK, not writing output');
    return { code: 0, lines };
  }

  const doc = {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${pkg.name ?? 'unknown'}-sbom`,
    documentNamespace: `https://example.invalid/harness/${pkg.name}/sbom-${createHash('sha1').update(`p=${packages.length}`).digest('hex').slice(0, 12)}`,
    creationInfo: {
      created: new Date(0).toISOString(),
      creators: [`Tool: harness sbom (iter 51)`],
      licenseListVersion: '3.20',
      ...(!includeDev && excludedDevCount > 0 ? {
        comment: `${excludedDevCount} devDependency package(s) excluded from this SBOM (scope: dev). Re-run with --include-dev for a build/CI-time-complete SBOM.`,
      } : {}),
    },
    packages,
  };

  if (out) {
    const outPath = resolve(dir, out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf-8');
    lines.push(`  wrote ${outPath}`);
    return { code: 0, lines };
  }
  // Print JSON to stdout for piping
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  return { code: 0, lines };
}
