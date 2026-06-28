// SPDX-License-Identifier: MIT
//
// Lazy, failure-tolerant loaders for the OPTIONAL native peers. Nothing here
// throws on import — callers decide how to handle absence. This is the seam
// that makes agentic-jujutsu / agenticow removable augmentations (ADR-150):
// the package loads and type-checks with neither installed.

import { createRequire } from 'node:module';

/** agentic-jujutsu is a CommonJS native addon — require it, don't ESM-import it. */
let _aj: unknown | null | undefined;
/** agenticow is an ESM package — dynamic import. Cached promise. */
let _cow: Promise<unknown | null> | undefined;

const require_ = createRequire(import.meta.url);

/**
 * Load the agentic-jujutsu native addon. Returns the module namespace
 * ({ JjWrapper, QuantumSigner, ... }) or null if it cannot be loaded
 * (not installed, or no prebuilt binary for this platform).
 */
export function loadAgenticJujutsu(): unknown | null {
  if (_aj !== undefined) return _aj;
  try {
    _aj = require_('agentic-jujutsu');
  } catch {
    _aj = null;
  }
  return _aj;
}

/**
 * Load the agenticow ESM module. Returns the module namespace
 * ({ open, AgenticMemory }) or null if it cannot be loaded.
 */
export function loadAgenticow(): Promise<unknown | null> {
  if (_cow !== undefined) return _cow;
  // Indirect the specifier: agenticow is an OPTIONAL peer that may be absent, so
  // we must not let the bundler/tsc statically resolve it. A non-literal import
  // specifier keeps this a true runtime dynamic import.
  const spec = 'agenticow';
  _cow = import(spec).then(
    (m) => (m as { default?: unknown }).default ?? m,
    () => null,
  );
  return _cow;
}

/** Reset cached module handles. Test-only seam. */
export function _resetLoaderCacheForTests(): void {
  _aj = undefined;
  _cow = undefined;
}
