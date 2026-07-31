// SPDX-License-Identifier: MIT
//
// Package-local vitest config. The repo-root vitest.config.ts only globs
// `packages/*/__tests__/**/*.test.ts` (top-level per-package test dirs, per
// the `@metaharness/redblue` / `@metaharness/flywheel` convention). This
// package also co-locates the CASA compiler's tests next to its source
// (`src/casa/__tests__/`, matching the companion `ruflo` repo's
// `plugins/ruflo-agntcy/src/casa/__tests__/` layout) so envelope-compiler
// tests stay next to the module they cover. This config makes both
// locations discoverable when running tests from within this package
// (`npm test` / `npx vitest run`), without touching the repo-root config.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
});
