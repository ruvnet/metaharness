// SPDX-License-Identifier: MIT
//
// ADR-246 §2.3: recoverable-session scaffold toggle. Sessions are an
// OPTIONAL primitive — default OFF, enabled only with --sessions. The emitted
// src/sessions/log.ts is a dependency-free copy-in (no @metaharness/kernel
// import) pointing at the ADR.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scaffold, parseArgs } from '../src/index.js';

const tmpRoot = (p: string) => mkdtemp(join(tmpdir(), p));

describe('sessions scaffold (ADR-246 §2.3)', () => {
  it('omits the session log by default', async () => {
    const target = join(await tmpRoot('sessions-off-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, generatorVersion: 'test' });
    expect(existsSync(join(target, 'src/sessions/log.ts'))).toBe(false);
  });

  it('emits a dependency-free session log with --sessions', async () => {
    const target = join(await tmpRoot('sessions-on-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, sessions: true, generatorVersion: 'test' });
    const log = await readFile(join(target, 'src/sessions/log.ts'), 'utf-8');
    expect(log).toContain('ADR-246');
    expect(log).toContain('class SessionLog');
    expect(log).not.toMatch(/from '@metaharness/); // comments may mention it; imports must not
    // only node builtins imported
    for (const m of log.matchAll(/from '([^']+)'/g)) {
      expect(m[1]!.startsWith('node:')).toBe(true);
    }
    // no literal NUL bytes in the emitted source (\u0000 escapes only)
    expect(log.includes('\u0000')).toBe(false);
    // README carries the sessions note (where + how to prune, per the ADR)
    const readme = await readFile(join(target, 'README.md'), 'utf-8');
    expect(readme).toContain('Recoverable sessions (ADR-246');
  });

  it('emitted SessionLog matches canonical semantics (hash-stable reopen, fork event, surrogate rejection)', async () => {
    const root = await tmpRoot('sessions-exec-');
    const target = join(root, 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, sessions: true, generatorVersion: 'test' });
    // Import the scaffolded copy itself (vitest transforms the .ts on import).
    // pathToFileURL encodes the tilde in Windows' 8.3 temp path (RUNNER~1)
    // even though it is safe in a URL. Vite 5 does not decode that segment
    // before resolving the module, so keep the path URL-compatible here.
    const moduleUrl = pathToFileURL(join(target, 'src/sessions/log.ts')).href
      .replaceAll('%7E', '~')
      .replaceAll('%7e', '~');
    const mod = await import(moduleUrl);
    const SessionLog = mod.SessionLog;

    // append → reopen is hash-stable
    const file = join(root, 'log.jsonl');
    const log = await SessionLog.open(file);
    await log.append('turn', { z: 1, a: [2, null], 'é': 'ü' });
    await log.append('note', 'hello');
    const h1 = log.stateHash();
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const reopened = await SessionLog.open(file);
    expect(reopened.stateHash()).toBe(h1);
    expect(reopened.replay()).toEqual({ eventCount: 2, stateHash: h1 });

    // fork emits the synthetic first event {index:0, parent, kind:'fork', payload:null}
    const forked = await reopened.fork(0, 'alt');
    const lastLine = (await readFile(file, 'utf-8')).trim().split('\n').at(-1)!;
    expect(JSON.parse(lastLine)).toEqual({
      index: 0, branch: 'alt', parent: { branch: 'main', index: 0 }, kind: 'fork', payload: null,
    });
    expect(forked.replay().eventCount).toBe(2); // main[0] + the fork event
    // fork lineage hash survives a reopen too
    const reopened2 = await SessionLog.open(file, 'alt');
    expect(reopened2.stateHash()).toBe(forked.stateHash());

    // unpaired surrogate throws on append…
    await expect(log.append('bad', 'lone \uD800 surrogate')).rejects.toThrow(/unpaired surrogate/);
    // …and on read (escaped lone surrogate in an otherwise valid line)
    const badFile = join(root, 'bad.jsonl');
    await writeFile(badFile, '{"index":0,"branch":"main","kind":"t","payload":"\\ud800"}\n', 'utf-8');
    await expect(SessionLog.open(badFile)).rejects.toThrow(/unpaired surrogate/);
  });

  it('parses --sessions / --no-sessions', () => {
    expect(parseArgs(['b', '--sessions']).sessions).toBe(true);
    expect(parseArgs(['b', '--no-sessions']).sessions).toBe(false);
    expect(parseArgs(['b']).sessions).toBeUndefined(); // default-off handled at scaffold()
  });
});
