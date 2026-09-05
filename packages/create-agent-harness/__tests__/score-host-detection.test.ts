// Dream Cycle 2026-09-05 (generator-genome): `scorePublishReadiness` and
// `scoreRepoUnderstanding` read `manifest.host` (singular) and treated any
// truthy `manifest.hosts` (including an empty array) as "hosts declared".
// `HarnessManifest` (manifest.ts) only ever has `hosts: string[]` — no
// harness this generator ever scaffolds sets a singular `host` field — so
// the npx-runnable 20-point bonus in `scorePublishReadiness` was
// unreachable: every harness with a `bin` entry silently fell through to
// the 10-point `pkg?.bin`-only branch regardless of how many hosts it
// declared. Separately, `scoreRepoUnderstanding`'s host-detection credited
// an empty `hosts: []` array (`[] ` is truthy in JS) as "host(s) declared".
// Both now require `Array.isArray(manifest.hosts) && manifest.hosts.length > 0`.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildScorecard } from '../src/score.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function fixture(opts: { hosts?: string[]; withManifest?: boolean; bin?: boolean }): string {
  const d = mkdtempSync(join(tmpdir(), 'score-host-'));
  dirs.push(d);
  const pkg: Record<string, unknown> = { name: 'demo', version: '1.0.0' };
  if (opts.bin) pkg.bin = { demo: './bin.js' };
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  if (opts.withManifest) {
    mkdirSync(join(d, '.harness'), { recursive: true });
    writeFileSync(
      join(d, '.harness', 'manifest.json'),
      JSON.stringify({ schema: 1, generator: 'metaharness@0.4.16', hosts: opts.hosts ?? [] }),
    );
  }
  return d;
}

function dim(sc: ReturnType<typeof buildScorecard>, name: string) {
  const d = sc.dimensions.find((x) => x.name === name);
  if (!d) throw new Error(`dimension not found: ${name}`);
  return d;
}

describe('scorePublishReadiness — npx-runnable bonus keys off manifest.hosts, not the nonexistent manifest.host', () => {
  // Every fixture here sets pkg.name/pkg.version, which unconditionally earns
  // its own +20 ("pkg=name@version") in scorePublishReadiness — that credit
  // is orthogonal to the bin/host logic under test and is included in each
  // expected total below.

  it('BUG REPRO (pre-fix would score 30, not 40): bin + one declared host earns the full 20-point npx-runnable bonus', () => {
    const d = fixture({ withManifest: true, hosts: ['claude-code'], bin: true });
    const sc = buildScorecard(d);
    const publish = dim(sc, 'Publish readiness');
    expect(publish.signals).toContain('bin entry present (npx-runnable)');
    expect(publish.score).toBe(40); // 20 (pkg name@version) + 20 (npx-runnable)
  });

  it('bin + multiple declared hosts still earns exactly the 20-point bonus (not double-counted)', () => {
    const d = fixture({ withManifest: true, hosts: ['claude-code', 'codex', 'hermes'], bin: true });
    const sc = buildScorecard(d);
    expect(dim(sc, 'Publish readiness').score).toBe(40);
  });

  it('bin present but hosts: [] (empty array) falls back to the 10-point bin-only credit', () => {
    const d = fixture({ withManifest: true, hosts: [], bin: true });
    const sc = buildScorecard(d);
    const publish = dim(sc, 'Publish readiness');
    expect(publish.signals).toContain('bin entry present');
    expect(publish.signals).not.toContain('bin entry present (npx-runnable)');
    expect(publish.score).toBe(30); // 20 (pkg name@version) + 10 (bin-only)
  });

  it('bin present but no manifest at all falls back to the 10-point bin-only credit', () => {
    const d = fixture({ withManifest: false, bin: true });
    const sc = buildScorecard(d);
    expect(dim(sc, 'Publish readiness').score).toBe(30); // 20 (pkg name@version) + 10 (bin-only)
  });

  it('no bin, hosts declared: no bin-related publish-readiness credit', () => {
    const d = fixture({ withManifest: true, hosts: ['claude-code'], bin: false });
    const sc = buildScorecard(d);
    const publish = dim(sc, 'Publish readiness');
    expect(publish.signals.some((s) => s.includes('bin entry'))).toBe(false);
    expect(publish.score).toBe(20); // pkg name@version only — no bin present
  });
});

describe('scoreRepoUnderstanding — host(s) credit requires a non-empty hosts array', () => {
  it('BUG REPRO (pre-fix would credit an empty array): hosts: [] earns no host-detection credit', () => {
    const d = fixture({ withManifest: true, hosts: [] });
    const sc = buildScorecard(d);
    const repo = dim(sc, 'Repo understanding');
    // manifest present (35) only — no meta.surface/kernel_version/hosts in this fixture.
    expect(repo.score).toBe(35);
    expect(repo.signals.some((s) => s.startsWith('host(s)='))).toBe(false);
  });

  it('a non-empty hosts array earns the 20-point host-detection credit, signal lists every host', () => {
    const d = fixture({ withManifest: true, hosts: ['claude-code', 'codex'] });
    const sc = buildScorecard(d);
    const repo = dim(sc, 'Repo understanding');
    expect(repo.score).toBe(55);
    expect(repo.signals).toContain('host(s)=claude-code, codex');
  });
});
