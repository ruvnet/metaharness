// SPDX-License-Identifier: MIT
//
// #462 — `claude plugin install metaharness@metaharness` must not read the
// registry-schema .claude-plugin/plugin.json as a Claude Code plugin manifest.
// The marketplace entry therefore roots the plugin at the skills folder (no
// plugin.json there), marks itself strict:false so the entry is the whole
// manifest, and lists skills with "./"-relative paths.

import { describe, it, expect } from 'vitest';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

describe('#462 Claude Code plugin install shape', () => {
  it('roots the plugin outside the registry plugin.json and declares it fully', async () => {
    const m = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    const entry = m.plugins.find((p: { name: string }) => p.name === 'metaharness');
    expect(entry).toBeDefined();
    expect(entry.source).not.toBe('./');
    expect(entry.source.startsWith('./')).toBe(true);
    expect(entry.strict).toBe(false);
    for (const s of entry.skills) expect(s.startsWith('./')).toBe(true);
    const pluginRoot = join(ROOT, entry.source);
    await expect(access(join(pluginRoot, '.claude-plugin', 'plugin.json'))).rejects.toThrow();
  });

  it('ships every skill folder with a SKILL.md under the plugin root', async () => {
    const m = JSON.parse(await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf-8'));
    const root = join(ROOT, m.plugins[0].source);
    const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
    expect(dirs.length).toBeGreaterThanOrEqual(14);
    for (const d of dirs) await expect(access(join(root, d.name, 'SKILL.md'))).resolves.toBeUndefined();
  });
});
