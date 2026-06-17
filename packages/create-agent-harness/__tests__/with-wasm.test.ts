// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/index.js';
import { wireWasm } from '../src/with-wasm.js';

describe('--with-wasm (GH #25)', () => {
  it('parseArgs captures --with-wasm <path>', () => {
    const a = parseArgs(['mybot', '--with-wasm', './crates/foo']);
    expect(a.withWasm).toBe('./crates/foo');
    expect(a.name).toBe('mybot');
  });

  it('wireWasm fails gracefully when the crate path has no Cargo.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ww-'));
    const r = wireWasm(dir, dir); // dir has no Cargo.toml
    expect(r.ok).toBe(false);
    expect(r.lines.join('\n')).toMatch(/no Cargo.toml/);
  });
});
