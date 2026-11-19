// SPDX-License-Identifier: MIT
//
// --with-wasm must invoke wasm-pack with an argv array (no shell), so a crate
// path containing shell metacharacters is passed verbatim, never interpreted.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const calls: Array<{ file: string; args: readonly string[] }> = [];
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execSync: vi.fn(() => {
      throw new Error('execSync must not be used by --with-wasm');
    }),
    execFileSync: vi.fn((file: string, args: readonly string[]) => {
      calls.push({ file, args });
      if (args[0] === 'build') throw new Error('stop after recording the build argv');
      return Buffer.from('wasm-pack 0.0.0');
    }),
  };
});

const { wireWasm } = await import('../src/with-wasm.js');

describe('--with-wasm argv safety', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('passes a metacharacter-laden crate path as a single argv element', () => {
    const base = mkdtempSync(join(tmpdir(), 'ww-argv-'));
    try {
      const crate = join(base, 'crate$(touch PWNED);`id`');
      mkdirSync(crate, { recursive: true });
      writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "x"\n');
      const target = join(base, 'out');
      mkdirSync(target, { recursive: true });
      const r = wireWasm(crate, target);
      expect(r.ok).toBe(false); // the mocked build throws
      const build = calls.find((c) => c.args[0] === 'build');
      expect(build?.file).toBe('wasm-pack');
      expect(build?.args).toContain(crate);
      expect(build?.args).toEqual(['build', crate, '--target', 'nodejs', '--release', '--out-dir', join(target, 'wasm')]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
