// SPDX-License-Identifier: MIT
//
// @metaharness/kernel's package.json `exports` map is the contract every
// REAL (npm-installed) consumer resolves through — unlike an in-repo import
// of `../src/*.js`, which bypasses `exports` entirely and can't catch a
// missing subpath. Two real consumers rely on subpaths this map used to
// omit:
//   - docs/USAGE.md and examples/multi-host/README.md both document
//     `import { SelfEvolvingRouter } from '@metaharness/kernel/self-evolution'`
//   - create-agent-harness's `harness diag` (src/diag.ts,
//     resolveLocalKernelVersion) calls
//     `require.resolve('@metaharness/kernel/package.json')` to read the
//     locally-installed kernel's version for its ADR-028 version-skew
//     check — the exact diagnostic the command exists for.
// Both subpaths resolve via Node's self-referencing-package resolution
// (this test file imports '@metaharness/kernel/*' from inside the kernel
// package itself, which Node resolves through the SAME exports map a real
// external consumer would use — not a relative `../src` import).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

describe('@metaharness/kernel package.json exports map', () => {
  it('exports ./self-evolution (documented in docs/USAGE.md + examples/multi-host/README.md)', async () => {
    const mod = await import('@metaharness/kernel/self-evolution');
    expect(typeof mod.SelfEvolvingRouter).toBe('function');
  });

  it('exports ./package.json (consumed by create-agent-harness/src/diag.ts for the ADR-028 kernel version-skew check)', () => {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@metaharness/kernel/package.json');
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8'));
    expect(pkg.name).toBe('@metaharness/kernel');
    expect(typeof pkg.version).toBe('string');
  });
});
