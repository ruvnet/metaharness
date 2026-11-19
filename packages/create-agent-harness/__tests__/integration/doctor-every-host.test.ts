// SPDX-License-Identifier: MIT
//
// `harness doctor` must accept a fresh scaffold for every host the CLI
// offers. Before this test, the host-artifact check only knew six hosts, so
// a harness scaffolded with --host github-actions, copilot, opencode or
// prime-agent failed doctor straight out of `metaharness new`.

import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold, HOSTS, type Host } from '../../src/index.js';
import { dispatch } from '../../src/subcommands.js';

describe('harness doctor: a fresh scaffold is healthy for every host', () => {
  for (const host of HOSTS) {
    it(`host=${host}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'doctor-host-'));
      const target = join(root, `bot-${host}`);
      await scaffold({
        name: `bot-${host}`,
        template: 'minimal',
        host: host as Host,
        targetDir: target,
        generatorVersion: '0.1.0',
      });
      const r = await dispatch('doctor', [target]);
      const fails = r.lines.filter((l) => l.includes('FAIL'));
      expect(fails).toEqual([]);
      expect(r.code).toBe(0);
    });
  }
});
