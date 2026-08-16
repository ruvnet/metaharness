// SPDX-License-Identifier: MIT
//
// .harness/manifest.json — the load-bearing artefact for drift detection
// (ADR-008) and eject/upgrade (ADR-012). Mirrors copier's `.copier-answers.yml`
// model: a single source of truth for what the user chose at generation
// time, used to re-apply template updates on `harness upgrade`.

import { createHash } from 'node:crypto';
import type { TemplateVars } from './renderer.js';

/** Diagnostic metadata per ADR-022 (CLI ↔ Web-UI integration). */
export interface HarnessMeta {
  /** Which surface produced this harness — 'cli' or 'web-ui'. Lets the
   *  validate umbrella decide which parity test bucket the harness should
   *  pass, and tells operators which surface to debug when drift surfaces. */
  surface?: 'cli' | 'web-ui';
  /** `@metaharness/kernel` version the harness was scaffolded against. ADR-022
   *  identifies kernel version skew as the most common root cause of
   *  manifest-shape disagreement between CLI + Pages deployments. Recording
   *  it here turns "drift" into "v0.1.5 vs v0.1.6 mismatch". */
  kernel_version?: string;
}

/**
 * Machine-readable record of the opt-in field-memory scaffold. Optional so
 * schema-1 manifests generated before this feature remain valid.
 */
export interface HarnessFieldMemory {
  /** Version of the generator-owned field-memory overlay contract. */
  contract_schema: 1;
  enabled: true;
  package: '@metaharness/field-memory';
  version: '^0.1.0';
  module: 'src/field-memory.ts';
  layout: 'packed';
  minimum_support: 3;
  hysteresis_enabled: false;
  storage_path_required: true;
  drift_window_enabled: true;
  principal_identity_required: true;
  identity_hash_key_required: true;
}

export interface HarnessManifest {
  /** Manifest schema version. Bump only on breaking shape changes. */
  schema: 1;
  /** Generator package version that produced this harness. */
  generator: string;
  /** Template id (e.g. "minimal", "vertical:trading"). */
  template: string;
  /** Template package version (resolved at generation time). */
  template_version: string;
  /** Variables the user supplied. */
  vars: TemplateVars;
  /** Host adapters bundled. */
  hosts: string[];
  /** Governed attractor-field integration, present only when opted in. */
  field_memory?: HarnessFieldMemory;
  /** Per-rendered-file sha256, so `harness upgrade` can detect divergence. */
  files: Record<string, string>;
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** ADR-022 diagnostic block. Optional for backwards-compat with pre-iter-56
   *  manifests; `harness validate doctor` warns (does NOT fail) when absent. */
  meta?: HarnessMeta;
}

export function emptyManifest(
  template: string,
  generator: string,
  opts: { meta?: HarnessMeta } = {},
): HarnessManifest {
  return {
    schema: 1,
    generator,
    template,
    template_version: '0.0.0',
    vars: {},
    hosts: [],
    files: {},
    generated_at: new Date().toISOString(),
    // ADR-022: surface is always 'cli' from this code path. The web-UI
    // (PR #1) will populate 'web-ui' from its own emit path. opts.meta
    // wins so callers can override (tests, future channels).
    meta: {
      surface: 'cli',
      ...(opts.meta ?? {}),
    },
  };
}

/** sha256-hex of a string. Used to fingerprint each rendered file. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute the per-file hash table for a rendered file map.
 * Keys are file paths relative to the harness root.
 */
export function fingerprintFiles(rendered: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(rendered)) {
    out[path] = sha256(content);
  }
  return out;
}

/**
 * Compare two manifests' file fingerprints, returning the set of paths
 * that differ. Drives the `harness upgrade` regenerate-diff-merge flow
 * per copier's update model (cited in ADR-008).
 */
export function diffFingerprints(
  a: Record<string, string>,
  b: Record<string, string>,
): { added: string[]; removed: string[]; changed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const allPaths = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const p of Array.from(allPaths).sort()) {
    if (!(p in a)) added.push(p);
    else if (!(p in b)) removed.push(p);
    else if (a[p] !== b[p]) changed.push(p);
  }
  return { added, removed, changed };
}
