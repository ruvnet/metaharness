// SPDX-License-Identifier: MIT
//
// `harness audit` — default (--omit=dev) gating must be unchanged, but a
// PASS at prod-scope must disclose how many advisories were suppressed by
// dev-scope filtering, rather than reading as an unqualified clean bill of
// health. `npm audit`'s own CLI doesn't distinguish scope in its JSON
// output, so this is verified by asserting the two child_process calls
// audit-cmd makes (one --omit=dev, one without) and how it reconciles them.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileMock = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => {
    const cb = args[args.length - 1];
    Promise.resolve(execFileMock(...args.slice(0, -1))).then(
      (r) => cb(null, r),
      (e) => cb(e),
    );
  },
}));

import { auditCmd } from '../src/audit-cmd.js';

function auditJson(counts: Record<string, number>) {
  // Real `npm audit --json` includes a `total` key alongside the
  // per-severity keys in metadata.vulnerabilities — include it here too so
  // a naive Object.values() sum (double-counting `total`) would be caught.
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  return JSON.stringify({ metadata: { vulnerabilities: { ...counts, total } } });
}

const dirs: string[] = [];
async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'audit-cmd-'));
  dirs.push(dir);
  await writeFile(join(dir, 'package.json'), '{"name":"bot"}', 'utf-8');
  await writeFile(join(dir, 'package-lock.json'), '{"name":"bot"}', 'utf-8');
  return dir;
}

afterEach(async () => {
  execFileMock.mockReset();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('auditCmd — dev-dependency suppression disclosure', () => {
  it('discloses suppressed high+ advisories without changing the PASS/FAIL gate', async () => {
    const dir = await makeDir();
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const prodOnly = args.includes('--omit=dev');
      return { stdout: prodOnly
        ? auditJson({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 })
        : auditJson({ info: 0, low: 0, moderate: 3, high: 4, critical: 1 }), stderr: '' };
    });
    const r = await auditCmd([dir]);
    expect(r.code).toBe(0); // gate unchanged: prod-only view is still clean
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(r.lines.some((l) => /PASS: 0 advisories at high\+/.test(l))).toBe(true);
    expect(r.lines.some((l) => /devDependencies not counted: 8 advisories \(5 at high\+\)/.test(l))).toBe(true);
  });

  it('does not run the second audit or disclose anything under --include-dev', async () => {
    const dir = await makeDir();
    execFileMock.mockImplementation(() => ({
      stdout: auditJson({ info: 0, low: 0, moderate: 3, high: 4, critical: 1 }), stderr: '',
    }));
    const r = await auditCmd([dir, '--include-dev']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(r.lines.some((l) => l.includes('devDependencies not counted'))).toBe(false);
  });

  it('stays silent when the second call finds nothing extra', async () => {
    const dir = await makeDir();
    execFileMock.mockImplementation(() => ({
      stdout: auditJson({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 }), stderr: '',
    }));
    const r = await auditCmd([dir]);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes('devDependencies not counted'))).toBe(false);
  });

  it('recovers the report from a non-zero exit on the second call (npm audit fails > audit-level)', async () => {
    // This is the realistic case, not an edge case: `npm audit` exits
    // non-zero once advisories at-or-above --audit-level exist, while still
    // writing the real report JSON to stdout — exactly like the primary
    // call already has to handle below.
    const dir = await makeDir();
    let call = 0;
    execFileMock.mockImplementation(() => {
      call++;
      if (call === 1) return { stdout: auditJson({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 }), stderr: '' };
      throw Object.assign(new Error('npm audit found vulnerabilities'), {
        stdout: auditJson({ info: 0, low: 0, moderate: 3, high: 4, critical: 1 }), stderr: '', code: 1,
      });
    });
    const r = await auditCmd([dir]);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => /devDependencies not counted: 8 advisories \(5 at high\+\)/.test(l))).toBe(true);
  });

  it('degrades gracefully (best-effort) when the second audit call is unrecoverable', async () => {
    const dir = await makeDir();
    let call = 0;
    execFileMock.mockImplementation(() => {
      call++;
      if (call === 1) return { stdout: auditJson({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 }), stderr: '' };
      throw Object.assign(new Error('boom'), { stdout: 'not json', stderr: 'boom' });
    });
    const r = await auditCmd([dir]);
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.includes('devDependencies not counted'))).toBe(false);
  });

  it('includes devDependenciesSuppressed in --bundle output', async () => {
    const dir = await makeDir();
    execFileMock.mockImplementation((_cmd: string, args: string[]) => {
      const prodOnly = args.includes('--omit=dev');
      return { stdout: prodOnly
        ? auditJson({ info: 0, low: 0, moderate: 0, high: 0, critical: 0 })
        : auditJson({ info: 0, low: 0, moderate: 3, high: 4, critical: 1 }), stderr: '' };
    });
    const r = await auditCmd([dir, '--bundle']);
    const parsed = JSON.parse(r.lines[0]);
    expect(parsed.devDependenciesSuppressed).toEqual({ total: 8, atLevelOrAbove: 5 });
  });
});
