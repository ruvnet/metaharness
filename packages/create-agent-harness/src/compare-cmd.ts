// SPDX-License-Identifier: MIT
//
// `harness compare <a> <b>` — diff two harness manifests + per-file
// fingerprints + meta blocks.
//
// Use case: "is my fork drifting from upstream?" or "does my prod copy
// match my staging copy?". The manifest already records per-file
// sha256 (iter 56 + earlier), so a comparison reduces to:
//
//   1. meta block diff      (surface? kernel_version? generator?)
//   2. host list diff        (does the fork target the same hosts?)
//   3. per-file fingerprint diff   (added/removed/changed)
//
// Bundle-shaped output (--bundle) per ADR-031.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type SubcommandResult = { code: number; lines: string[] };

interface Manifest {
  schema?: number;
  generator?: string;
  template?: string;
  template_version?: string;
  hosts?: string[];
  files?: Record<string, string>;
  meta?: {
    surface?: string;
    kernel_version?: string;
  };
}

interface CompareReport {
  schema: 1;
  generatedAt: string;
  a: { dir: string; manifest: Manifest | undefined };
  b: { dir: string; manifest: Manifest | undefined };
  meta: {
    sameSurface: boolean;
    sameKernel: boolean;
    sameGenerator: boolean;
    surfaceA: string | undefined;
    surfaceB: string | undefined;
    kernelA: string | undefined;
    kernelB: string | undefined;
    generatorA: string | undefined;
    generatorB: string | undefined;
  };
  hosts: {
    sameHosts: boolean;
    addedInB: string[];
    removedInB: string[];
  };
  files: {
    sameFiles: boolean;
    addedInB: string[];
    removedInB: string[];
    changed: string[];   // present in both but fingerprint differs
  };
  identical: boolean;
  exitCode: number;
}

async function readManifest(dir: string): Promise<Manifest | undefined> {
  const path = join(dir, '.harness', 'manifest.json');
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function diffSets<T>(a: T[], b: T[]): { addedInB: T[]; removedInB: T[] } {
  const aSet = new Set(a);
  const bSet = new Set(b);
  return {
    addedInB: b.filter(x => !aSet.has(x)).sort(),
    removedInB: a.filter(x => !bSet.has(x)).sort(),
  };
}

export async function buildCompareReport(dirA: string, dirB: string): Promise<CompareReport> {
  const mA = await readManifest(dirA);
  const mB = await readManifest(dirB);

  const surfaceA = mA?.meta?.surface;
  const surfaceB = mB?.meta?.surface;
  const kernelA = mA?.meta?.kernel_version;
  const kernelB = mB?.meta?.kernel_version;
  const generatorA = mA?.generator;
  const generatorB = mB?.generator;

  const hostsDiff = diffSets(mA?.hosts ?? [], mB?.hosts ?? []);

  const filesA = mA?.files ?? {};
  const filesB = mB?.files ?? {};
  const filesDiff = diffSets(Object.keys(filesA), Object.keys(filesB));
  const changed = Object.keys(filesA)
    .filter(p => p in filesB && filesA[p] !== filesB[p])
    .sort();

  const identical =
    surfaceA === surfaceB &&
    kernelA === kernelB &&
    generatorA === generatorB &&
    hostsDiff.addedInB.length === 0 &&
    hostsDiff.removedInB.length === 0 &&
    filesDiff.addedInB.length === 0 &&
    filesDiff.removedInB.length === 0 &&
    changed.length === 0;

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    a: { dir: dirA, manifest: mA },
    b: { dir: dirB, manifest: mB },
    meta: {
      sameSurface: surfaceA === surfaceB,
      sameKernel: kernelA === kernelB,
      sameGenerator: generatorA === generatorB,
      surfaceA, surfaceB, kernelA, kernelB, generatorA, generatorB,
    },
    hosts: {
      sameHosts: hostsDiff.addedInB.length === 0 && hostsDiff.removedInB.length === 0,
      addedInB: hostsDiff.addedInB,
      removedInB: hostsDiff.removedInB,
    },
    files: {
      sameFiles: filesDiff.addedInB.length === 0 && filesDiff.removedInB.length === 0 && changed.length === 0,
      addedInB: filesDiff.addedInB,
      removedInB: filesDiff.removedInB,
      changed,
    },
    identical,
    exitCode: identical ? 0 : 1,
  };
}

function formatReport(r: CompareReport): string[] {
  const lines: string[] = [];
  lines.push(`harness compare`);
  lines.push(`  A: ${r.a.dir}`);
  lines.push(`  B: ${r.b.dir}`);
  lines.push('');
  if (!r.a.manifest || !r.b.manifest) {
    if (!r.a.manifest) lines.push(`  FAIL no .harness/manifest.json at A (${r.a.dir})`);
    if (!r.b.manifest) lines.push(`  FAIL no .harness/manifest.json at B (${r.b.dir})`);
    return lines;
  }
  lines.push('  meta:');
  lines.push(`    surface:           A=${r.meta.surfaceA ?? '(unset)'} B=${r.meta.surfaceB ?? '(unset)'} ${r.meta.sameSurface ? 'PASS' : 'FAIL'}`);
  lines.push(`    kernel_version:    A=${r.meta.kernelA ?? '(unset)'} B=${r.meta.kernelB ?? '(unset)'} ${r.meta.sameKernel ? 'PASS' : 'FAIL'}`);
  lines.push(`    generator:         A=${r.meta.generatorA ?? '(unset)'} B=${r.meta.generatorB ?? '(unset)'} ${r.meta.sameGenerator ? 'PASS' : 'FAIL'}`);
  lines.push('  hosts:');
  if (r.hosts.sameHosts) {
    lines.push('    PASS host lists match');
  } else {
    if (r.hosts.addedInB.length) lines.push(`    + added in B:   ${r.hosts.addedInB.join(', ')}`);
    if (r.hosts.removedInB.length) lines.push(`    - removed in B: ${r.hosts.removedInB.join(', ')}`);
  }
  lines.push('  files:');
  if (r.files.sameFiles) {
    lines.push(`    PASS ${Object.keys(r.a.manifest.files ?? {}).length} files match`);
  } else {
    if (r.files.addedInB.length) lines.push(`    + added in B:   ${r.files.addedInB.length} file(s)`);
    if (r.files.removedInB.length) lines.push(`    - removed in B: ${r.files.removedInB.length} file(s)`);
    if (r.files.changed.length) lines.push(`    ~ changed:      ${r.files.changed.length} file(s)`);
    // Show the first 5 of each so the user can spot the obvious differences
    const sample = (arr: string[]) => arr.slice(0, 5).map(p => `        ${p}`);
    if (r.files.addedInB.length) sample(r.files.addedInB).forEach(l => lines.push(l));
    if (r.files.removedInB.length) sample(r.files.removedInB).forEach(l => lines.push(l));
    if (r.files.changed.length) sample(r.files.changed).forEach(l => lines.push(l));
  }
  lines.push('');
  lines.push(`  Result: ${r.identical ? 'IDENTICAL' : 'DRIFT'}`);
  return lines;
}

export async function compareCmd(args: string[]): Promise<SubcommandResult> {
  const bundle = args.includes('--bundle');
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length < 2) {
    const lines = [
      'Usage: harness compare <a> <b> [--bundle]',
      '',
      'Compare two scaffolded harnesses by manifest + per-file fingerprint.',
      'Exits 0 if identical, 1 if drift, 2 if either path lacks a manifest.',
    ];
    return { code: 2, lines };
  }

  const dirA = resolve(positional[0]);
  const dirB = resolve(positional[1]);
  const report = await buildCompareReport(dirA, dirB);

  // ADR-031: missing manifest is an error path that's still bundle-formed.
  if (!report.a.manifest || !report.b.manifest) {
    if (bundle) {
      return {
        code: 2,
        lines: [JSON.stringify({
          schema: 1, generatedAt: report.generatedAt,
          error: !report.a.manifest && !report.b.manifest ? 'no-manifest-in-either'
               : !report.a.manifest ? 'no-manifest-in-a' : 'no-manifest-in-b',
          dirA, dirB, exitCode: 2,
        }, null, 2)],
      };
    }
    return { code: 2, lines: formatReport(report) };
  }

  if (bundle) {
    return { code: report.exitCode, lines: [JSON.stringify(report, null, 2)] };
  }
  return { code: report.exitCode, lines: formatReport(report) };
}
