// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sbomCmd } from '../packages/create-agent-harness/src/sbom-cmd.js';
import { auditCmd } from '../packages/create-agent-harness/src/audit-cmd.js';

async function makePkgDir(opts: { withLock?: boolean; deps?: Record<string, string> } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ahg-pkg-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '0.1.0',
    dependencies: opts.deps ?? { 'lodash': '^4.17.21' },
  }, null, 2));
  if (opts.withLock) {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({
      name: 'fixture', version: '0.1.0', lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '0.1.0' },
        'node_modules/lodash': { name: 'lodash', version: '4.17.21', resolved: 'https://example.invalid/lodash' },
      },
    }));
  }
  return dir;
}

describe('harness sbom', () => {
  it('fails when no package.json present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-sbom-empty-'));
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/no package\.json/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads from package-lock.json when present', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/source: package-lock\.json/);
      expect(r.lines.join('\n')).toMatch(/packages: 1/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('falls back to manifest deps when no lockfile', async () => {
    const dir = await makePkgDir({ withLock: false });
    try {
      const r = await sbomCmd([dir, '--validate-only']);
      expect(r.code).toBe(0);
      expect(r.lines.join('\n')).toMatch(/package\.json dependencies/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('--out= writes to a file', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await sbomCmd([dir, '--out=sbom.json']);
      expect(r.code).toBe(0);
      const text = await (await import('node:fs/promises')).readFile(join(dir, 'sbom.json'), 'utf-8');
      const doc = JSON.parse(text);
      expect(doc.spdxVersion).toBe('SPDX-2.3');
      expect(doc.SPDXID).toBe('SPDXRef-DOCUMENT');
      expect(doc.packages.length).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('harness audit', () => {
  it('fails when no package.json present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ahg-aud-empty-'));
    try {
      const r = await auditCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/no package\.json/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('asks for package-lock.json when missing', async () => {
    const dir = await makePkgDir({ withLock: false });
    try {
      const r = await auditCmd([dir]);
      expect(r.code).toBe(1);
      expect(r.lines.join('\n')).toMatch(/npm install --package-lock-only/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects unknown --level= with exit 2', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await auditCmd([dir, '--level=invalid']);
      expect(r.code).toBe(2);
      expect(r.lines.join('\n')).toMatch(/unknown --level/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('passes audit with no advisories on a tiny lockfile (PASS or no-output paths)', async () => {
    const dir = await makePkgDir({ withLock: true });
    try {
      const r = await auditCmd([dir]);
      // npm audit on an offline lockfile may exit 0 with no advisories,
      // OR fail because npm couldn't reach the registry. Both are valid
      // for this test — we only assert the script handles them cleanly.
      expect([0, 1]).toContain(r.code);
      const txt = r.lines.join('\n');
      expect(txt).toMatch(/level=high|PASS|FAIL|non-JSON/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
