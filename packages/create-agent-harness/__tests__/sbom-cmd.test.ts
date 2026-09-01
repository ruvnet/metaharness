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
import { sbomCmd } from '../src/sbom-cmd.js';

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
