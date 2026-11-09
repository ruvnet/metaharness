// SPDX-License-Identifier: MIT
//
// npm installs a package bin as a SYMLINK (node_modules/.bin/weight-eft ->
// ../@metaharness/weight-eft/dist/cli.js). The CLI's main-module guard
// compared import.meta.url against the unresolved argv[1], so every
// `npx @metaharness/weight-eft …` call exited 0 and printed nothing.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entry = resolve(__dirname, '..', 'dist', 'cli.js');

describe('weight-eft bin', () => {
  it('prints usage when run through an npm-style symlink', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'weight-eft-bin-')), 'weight-eft');
    symlinkSync(entry, link);
    const out = execFileSync(process.execPath, [link, 'status'], { encoding: 'utf8' });
    expect(out.length).toBeGreaterThan(0);
  });
});
