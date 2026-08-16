// SPDX-License-Identifier: MIT
//
// Opt-in @metaharness/field-memory integration for generated harnesses.
// This file intentionally emits only configuration and a bootstrap wrapper.
// The field-memory implementation remains owned by the upstream package.

import type { RenderedFile } from './walker.js';
import type { HarnessFieldMemory } from './manifest.js';

export const FIELD_MEMORY_PACKAGE = '@metaharness/field-memory';
export const FIELD_MEMORY_VERSION = '^0.1.0';
export const FIELD_MEMORY_MODULE_PATH = 'src/field-memory.ts';

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Single source of truth for scaffold and upgrade manifest semantics. */
export const FIELD_MEMORY_MANIFEST_CONTRACT: Readonly<HarnessFieldMemory> = Object.freeze({
  contract_schema: 1,
  enabled: true,
  package: FIELD_MEMORY_PACKAGE,
  version: FIELD_MEMORY_VERSION,
  module: FIELD_MEMORY_MODULE_PATH,
  layout: 'packed',
  minimum_support: 3,
  hysteresis_enabled: false,
  storage_path_required: true,
  drift_window_enabled: true,
  principal_identity_required: true,
  identity_hash_key_required: true,
});

export function fieldMemoryManifest(): HarnessFieldMemory {
  return { ...FIELD_MEMORY_MANIFEST_CONTRACT };
}

/** Return null only when every key and value matches the governed contract. */
export function validateFieldMemoryManifest(value: unknown): string | null {
  if (!isRecord(value)) return 'field_memory must be an object';

  const expectedEntries = Object.entries(FIELD_MEMORY_MANIFEST_CONTRACT);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedEntries.length) {
    return 'field_memory keys do not match the current contract';
  }
  for (const [key, expected] of expectedEntries) {
    if (!Object.hasOwn(value, key) || value[key] !== expected) {
      return `field_memory.${key} does not match the current contract`;
    }
  }
  return null;
}

/**
 * Add the package dependency, bootstrap module, and README note to an in-memory
 * scaffold. Every ambiguous pre-existing state is rejected before disk writes.
 *
 * This draft deliberately recognizes only the exact generator-owned range
 * `^0.1.0`. It does not implement a partial semver parser. A future change may
 * adopt `semver` and accept other mathematically compatible ranges explicitly.
 */
export function integrateFieldMemory(rendered: RenderedFile[]): void {
  if (rendered.some((file) => file.path === FIELD_MEMORY_MODULE_PATH)) {
    throw new Error(
      `--field-memory refuses to overwrite existing ${FIELD_MEMORY_MODULE_PATH}`,
    );
  }

  const packageEntries = rendered.filter((file) => file.path === 'package.json');
  if (packageEntries.length === 0) {
    throw new Error('--field-memory requires the template to emit package.json');
  }
  if (packageEntries.length > 1) {
    throw new Error('--field-memory requires exactly one generated package.json');
  }

  const packageFile = packageEntries[0]!;
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(packageFile.content);
    if (!isRecord(parsed)) throw new TypeError('package root must be an object');
    pkg = parsed;
  } catch {
    throw new Error('--field-memory requires a valid generated package.json object');
  }

  const sections = new Map<string, Record<string, unknown>>();
  for (const section of DEPENDENCY_SECTIONS) {
    const value = pkg[section];
    if (value === undefined) continue;
    if (!isRecord(value)) {
      throw new Error(`--field-memory requires package.json ${section} to be an object`);
    }
    sections.set(section, value);
  }

  const declarations = DEPENDENCY_SECTIONS.flatMap((section) => {
    const dependencies = sections.get(section);
    return dependencies && Object.hasOwn(dependencies, FIELD_MEMORY_PACKAGE)
      ? [{ section, spec: dependencies[FIELD_MEMORY_PACKAGE] }]
      : [];
  });

  if (declarations.length > 0) {
    const declaration = declarations[0]!;
    if (declarations.length !== 1 || declaration.section !== 'dependencies') {
      throw new Error(
        `--field-memory requires ${FIELD_MEMORY_PACKAGE} only in runtime dependencies`,
      );
    }
    if (declaration.spec !== FIELD_MEMORY_VERSION) {
      throw new Error(
        `--field-memory accepts only ${FIELD_MEMORY_PACKAGE} ${FIELD_MEMORY_VERSION}; ` +
        'other ranges or specifications are rejected',
      );
    }
    // Preserve the exact compatible version value when the package is
    // serialized below.
  } else {
    let dependencies = sections.get('dependencies');
    if (!dependencies) {
      dependencies = {};
      pkg.dependencies = dependencies;
    }
    dependencies[FIELD_MEMORY_PACKAGE] = FIELD_MEMORY_VERSION;
  }

  packageFile.content = JSON.stringify(pkg, null, 2) + '\n';
  rendered.push({
    path: FIELD_MEMORY_MODULE_PATH,
    content: fieldMemoryModuleTemplate(),
    rendered: false,
    unresolved: [],
  });

  const readme = rendered.find((file) => file.path === 'README.md');
  if (readme) {
    while (readme.content.endsWith('\n')) readme.content = readme.content.slice(0, -1);
    readme.content += '\n' + fieldMemoryReadmeSection();
  }
}

/**
 * Emit the host-agnostic field-memory bootstrap module.
 *
 * Safety invariants are visible in generated code rather than hidden in the
 * generator:
 *   - packed storage layout
 *   - three distinct verifier-derived principals before an attractor is eligible
 *   - hysteresis disabled until a deployment calibrates it
 *   - a bounded, non-zero drift window
 *   - no implicit/default database path
 *   - no caller-asserted principal id; shared updates require a verifier
 *   - no identity-hash secret default; deployments must supply at least 32 bytes
 *
 * Package influence caps are centroid-local. Fleet-wide admission and rate
 * limits belong in the deployment-owned verifier.
 */
export function fieldMemoryModuleTemplate(): string {
  return `// SPDX-License-Identifier: MIT
// Generated by metaharness --field-memory.
//
// This module configures @metaharness/field-memory; it does not copy its
// implementation. Storage and principal verification remain deployment-owned
// trust boundaries and must be supplied explicitly.

import { isAbsolute } from 'node:path';
import {
  createFieldMemory,
  type FieldMemoryConfig,
  type FieldStorageAdapter,
  type PrincipalVerifier,
} from '@metaharness/field-memory';

const DAY_MS = 86_400_000;

/** One centroid carries every configuration reward head. */
export const FIELD_MEMORY_LAYOUT = 'packed' as const;

/**
 * Conservative defaults derived from the field-memory discovery benchmark.
 * Override only behind a held-out evaluation and a reversible rollout.
 */
export const FIELD_MEMORY_CONFIG = Object.freeze({
  dimension: 384,
  retrievalK: 8,
  minimumSupport: 3,
  decayHalfLifeMs: 7 * DAY_MS,
  driftWindowMs: 30 * DAY_MS,
  bucketSizeMs: DAY_MS,
  maxContributionWeight: 1,
  principalInfluenceCap: 3,
  trustDomainInfluenceCap: 12,
  costPenaltyWeight: 0.1,
  costScale: 1,
  hysteresisMargin: 0,
  semanticContinuityThreshold: 0.85,
}) satisfies FieldMemoryConfig;

export interface OpenFieldMemoryOptions<PrincipalProof> {
  /**
   * Absolute, deployment-controlled location. There is deliberately no
   * working-directory default: an implicit path can reopen the wrong index.
   */
  storagePath: string;
  /** Open a RuVector-compatible adapter at exactly storagePath. */
  openStorage: (
    storagePath: string,
  ) => FieldStorageAdapter | Promise<FieldStorageAdapter>;
  /**
   * Authenticate deployment-provided update evidence and return its principal
   * identity.
   * Returning null rejects the update. Never derive identity from caller text.
   */
  verifier: PrincipalVerifier<PrincipalProof>;
  /**
   * Deployment secret used by the package to HMAC identity and idempotency
   * ledger keys. Supply at least 32 bytes and reuse it after state restore.
   * Never derive it from a caller identity or commit it to generated config.
   */
  identityHashKey: string | Uint8Array;
}

/**
 * Open a configured field. The wrapper fails closed until persistence,
 * principal verification, and the identity hash key are explicitly wired by
 * the deployment.
 */
export async function openFieldMemory<PrincipalProof>(
  options: OpenFieldMemoryOptions<PrincipalProof>,
) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('field memory options are required');
  }

  const storagePath = options.storagePath?.trim();
  if (!storagePath) {
    throw new Error('field memory storagePath is required');
  }
  if (!isAbsolute(storagePath)) {
    throw new Error('field memory storagePath must be absolute');
  }
  if (typeof options.openStorage !== 'function') {
    throw new TypeError('field memory openStorage adapter factory is required');
  }
  if (typeof options.verifier !== 'function') {
    throw new TypeError('field memory principal verifier is required');
  }
  const identityHashKeyLength = typeof options.identityHashKey === 'string'
    ? Buffer.byteLength(options.identityHashKey, 'utf8')
    : options.identityHashKey instanceof Uint8Array
      ? options.identityHashKey.byteLength
      : 0;
  if (identityHashKeyLength < 32) {
    throw new TypeError('field memory identityHashKey must contain at least 32 bytes');
  }

  const storage = await options.openStorage(storagePath);
  if (!storage || typeof storage !== 'object') {
    throw new TypeError('field memory openStorage must return a storage adapter');
  }
  if (storage.writerScope !== 'process' && storage.writerScope !== 'distributed') {
    throw new TypeError('field memory storage adapter must declare writerScope');
  }

  return createFieldMemory({
    storage,
    verifier: options.verifier,
    identityHashKey: options.identityHashKey,
    config: { ...FIELD_MEMORY_CONFIG },
  });
}
`;
}

/** Documentation appended only to opted-in generated harnesses. */
export function fieldMemoryReadmeSection(): string {
  return `
## Field memory

This harness opted into \`@metaharness/field-memory\`. The generated
\`src/field-memory.ts\` configures a packed attractor field with conservative
defaults: minimum support is 3, hysteresis is disabled, and recent evidence is
bounded by a drift window. Here, support means three distinct principals
returned by the deployment verifier. Their real independence depends on that
verifier's identity and trust-domain controls.

The module is intentionally fail-closed. Call \`openFieldMemory\` with an
absolute, deployment-controlled storage path, a RuVector-compatible storage
adapter factory, a verifier backed by deployment authentication, and a
deployment-secret \`identityHashKey\` of at least 32 bytes. Reuse the same key
after state restore. The module contains no default database path, identity,
secret, principal proof, or trust-on-first-use fallback. Shared updates are
rejected by the upstream package when the verifier cannot authenticate their
principal.

For RuVector-backed storage, use the upstream package adapter. Its mutable
field contract requires a configuration-verified FlatIndex with in-place
updates and cosine distance; it rejects HNSW and unverified legacy stores.

The package's principal and trust-domain influence caps are centroid-local.
Enforce fleet-wide admission, revocation, and rate limits in the deployment-owned
verifier before it returns an authenticated principal.

\`minimumSupport\` is a routing quarantine, not confidentiality. Authorized
state exports and the adapter registry can contain singleton aggregate
embeddings and rewards. Protect snapshots and registry storage as sensitive
deployment data.

Inspect the adapter's \`storage.writerScope\`. A \`process\` scope requires one
writer service for the field. Multi-process or fleet-wide writers require an
adapter with \`distributed\` scope; a process-scoped adapter is not a distributed
locking mechanism.

The manifest records field-memory overlay contract schema 1. Upgrades validate
that contract exactly and fail closed when it is unsupported; changing the
package or bootstrap contract requires an explicit migration.
`;
}
