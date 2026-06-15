#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Native-router interop guard (ADR-043). Regression test for the CJS-default
// interop bug that shipped in @metaharness/router 0.3.0: @ruvector/tiny-dancer is
// CommonJS, so under plain Node ESM its named exports land on the dynamic-import
// `.default`, not the namespace — and isNativeRouterAvailable() wrongly returned
// false. Vitest's module interop MASKS this (its namespace is populated), so the
// vitest suite passes while real installs get the dependency-free fallback. This
// guard runs under plain `node` (the real condition) and fails CI if a future
// change re-breaks the interop.
//
// Contract:
//   - tiny-dancer NOT resolvable  -> skip (exit 0): nothing to guard.
//   - tiny-dancer resolvable but isNativeRouterAvailable()===false -> FAIL: the
//     exact interop regression.
//   - resolvable + available -> run the genuine train->persist->load->route arc.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Is the optional native engine actually installed?
let installed = true;
try {
  require.resolve('@ruvector/tiny-dancer');
} catch {
  installed = false;
}
if (!installed) {
  console.log('[native-guard] @ruvector/tiny-dancer not installed — skip (nothing to guard).');
  process.exit(0);
}

// Import the BUILT router (the artifact consumers get), not the TS source.
const nativeUrl = new URL('../packages/router/dist/native.js', import.meta.url);
let mod;
try {
  mod = await import(nativeUrl.href);
} catch (e) {
  console.error('[native-guard] FAIL: could not import packages/router/dist/native.js — run `npm run build` first.');
  console.error(e?.message ?? e);
  process.exit(1);
}

const { isNativeRouterAvailable, resolveRouterBackend, trainNativeRouter, NativeRouter } = mod;

const available = await isNativeRouterAvailable();
if (!available) {
  console.error(
    '[native-guard] FAIL: @ruvector/tiny-dancer is installed but isNativeRouterAvailable()===false.\n' +
      '  This is the CJS-default interop regression (loadTinyDancer must unwrap `.default`).',
  );
  process.exit(1);
}

const backend = await resolveRouterBackend('auto');
if (backend !== 'native') {
  console.error(`[native-guard] FAIL: resolveRouterBackend('auto') returned '${backend}', expected 'native'.`);
  process.exit(1);
}

// Genuine end-to-end arc at the engine's supported route dim (5).
const dir = mkdtempSync(join(tmpdir(), 'native-guard-'));
try {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const cheap = i % 2 === 0;
    rows.push({
      embedding: [cheap ? 1 : 0, cheap ? 0 : 1, (i % 5) / 50, (i % 3) / 40, (i % 7) / 60],
      scores: cheap ? { haiku: 0.9, opus: 0.92 } : { haiku: 0.45, opus: 0.95 },
    });
  }
  const out = join(dir, 'guard.safetensors');
  const res = await trainNativeRouter(rows, { haiku: 1, opus: 15 }, { outputPath: out, epochs: 15 });
  if (!existsSync(out) || !(res.modelBytes > 0)) {
    console.error('[native-guard] FAIL: native training did not persist a non-empty model.');
    process.exit(1);
  }
  const router = await NativeRouter.load({ modelPath: out });
  const d = await router.route([1, 0, 0, 0, 0], [
    { id: 'haiku', embedding: [1, 0, 0, 0, 0], costPerMTok: 1 },
    { id: 'opus', embedding: [0, 1, 0, 0, 0], costPerMTok: 15 },
  ]);
  if (!['haiku', 'opus'].includes(d.id)) {
    console.error(`[native-guard] FAIL: native route returned unexpected id '${d.id}'.`);
    process.exit(1);
  }
  console.log(
    `[native-guard] OK — native backend live: train acc=${res.trainAccuracy.toFixed(2)}, ` +
      `routed -> ${d.id} (conf ${d.confidence.toFixed(3)}).`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
