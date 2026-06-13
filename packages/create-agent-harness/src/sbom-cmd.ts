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

interface SpdxPkg {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: string;
  filesAnalyzed: false;
  licenseDeclared: string;
  copyrightText: 'NOASSERTION';
  externalRefs: Array<{
    referenceCategory: 'PACKAGE-MANAGER';
    referenceType: 'purl';
    referenceLocator: string;
  }>;
}

function spdxId(prefix: string, name: string, version: string): string {
  return `SPDXRef-${prefix}-${(name + '-' + version).replace(/[^a-zA-Z0-9-]/g, '-')}`;
}

function packagesFromLock(lock: any, includeDev: boolean): SpdxPkg[] {
  if (!lock?.packages) return [];
  const out: SpdxPkg[] = [];
  for (const [path, pkg] of Object.entries<any>(lock.packages)) {
    if (!path || path === '') continue;
    if (!includeDev && pkg.dev === true) continue;
    if (pkg.peer === true || pkg.optional === true) continue;
    const name = pkg.name ?? path.split('node_modules/').pop();
    if (!name || !pkg.version) continue;
    out.push({
      SPDXID: spdxId('npm', name, pkg.version),
      name,
      versionInfo: pkg.version,
      downloadLocation: pkg.resolved ?? 'NOASSERTION',
      filesAnalyzed: false,
      licenseDeclared: typeof pkg.license === 'string' ? pkg.license : 'NOASSERTION',
      copyrightText: 'NOASSERTION',
      externalRefs: [{
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: `pkg:npm/${name}@${pkg.version}`,
      }],
    });
  }
  return out;
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
  if (existsSync(lockPath)) {
    const lock = JSON.parse(await readFile(lockPath, 'utf-8'));
    packages = packagesFromLock(lock, includeDev);
    source = 'package-lock.json';
  } else {
    packages = packagesFromManifest(pkg);
    source = 'package.json dependencies (no lockfile — versions are range strings)';
  }
  lines.push(`  source: ${source}`);
  lines.push(`  packages: ${packages.length}`);

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
