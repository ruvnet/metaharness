// SPDX-License-Identifier: MIT
//
// ADR-147: Darwin Mode integration. Asserts the scaffolder deeply integrates
// @metaharness/darwin by default (devDependency + evolve scripts + real evolve
// skill), and that --no-darwin cleanly opts out.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, parseArgs } from '../src/index.js';

const tmpRoot = (p: string) => mkdtemp(join(tmpdir(), p));

describe('darwin integration (ADR-147)', () => {
  it('integrates Darwin Mode by default', async () => {
    const target = join(await tmpRoot('darwin-on-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, generatorVersion: 'test' });
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies['@metaharness/darwin']).toBeTruthy();
    expect(pkg.scripts.evolve).toContain('metaharness-darwin evolve');
    expect(pkg.scripts['evolve:dry']).toContain('--sandbox mock');
    const skill = await readFile(join(target, '.claude/skills/evolve/SKILL.md'), 'utf-8');
    expect(skill).toContain('Darwin Mode');
    expect(skill).toContain('npm run evolve');
    // secure-by-default: the skill documents the deterministic/no-network default
    expect(skill.toLowerCase()).toContain('no api key');
  });

  it('omits Darwin Mode with darwin:false (--no-darwin)', async () => {
    const target = join(await tmpRoot('darwin-off-'), 'bot');
    await scaffold({ name: 'bot', template: 'minimal', host: 'claude-code', targetDir: target, darwin: false, generatorVersion: 'test' });
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf-8'));
    expect(pkg.devDependencies?.['@metaharness/darwin']).toBeUndefined();
    expect(pkg.scripts?.evolve).toBeUndefined();
  });

  it('parses --darwin / --no-darwin', () => {
    expect(parseArgs(['b', '--no-darwin']).darwin).toBe(false);
    expect(parseArgs(['b', '--darwin']).darwin).toBe(true);
    expect(parseArgs(['b']).darwin).toBeUndefined(); // default-on handled at scaffold()
  });
});
