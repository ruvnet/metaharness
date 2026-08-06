// SPDX-License-Identifier: MIT
//
// ADR-241 §2.3: recoverable-session scaffold toggle. Sessions are an
// OPTIONAL primitive — default OFF, enabled only with --sessions. The emitted
// src/sessions/log.ts is a dependency-free copy-in (no @metaharness/kernel
// import) pointing at the ADR.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, parseArgs } from '../src/index.js';

const tmpRoot = (p: string) => mkdtemp(join(tmpdir(), p));

describe('sessions scaffold (ADR-241 §2.3)', () => {
  it('omits the session log by default', async () => {
    const target = join(await tmpRoot('sessions-off-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, generatorVersion: 'test' });
    expect(existsSync(join(target, 'src/sessions/log.ts'))).toBe(false);
  });

  it('emits a dependency-free session log with --sessions', async () => {
    const target = join(await tmpRoot('sessions-on-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, sessions: true, generatorVersion: 'test' });
    const log = await readFile(join(target, 'src/sessions/log.ts'), 'utf-8');
    expect(log).toContain('ADR-241');
    expect(log).toContain('class SessionLog');
    expect(log).not.toMatch(/from '@metaharness/); // comments may mention it; imports must not
    // only node builtins imported
    for (const m of log.matchAll(/from '([^']+)'/g)) {
      expect(m[1]!.startsWith('node:')).toBe(true);
    }
    // README carries the sessions note (where + how to prune, per the ADR)
    const readme = await readFile(join(target, 'README.md'), 'utf-8');
    expect(readme).toContain('Recoverable sessions (ADR-241');
  });

  it('parses --sessions / --no-sessions', () => {
    expect(parseArgs(['b', '--sessions']).sessions).toBe(true);
    expect(parseArgs(['b', '--no-sessions']).sessions).toBe(false);
    expect(parseArgs(['b']).sessions).toBeUndefined(); // default-off handled at scaffold()
  });
});
