// SPDX-License-Identifier: MIT
//
// @metaharness/host-rvm — RVM (Agentic Virtual Machine) host adapter.
//
// Verified integration surface (from https://github.com/ruvnet/rvm):
//   - Bare-metal microhypervisor for AArch64
//   - Rust 95-99% (~500 LoC assembly); forbids unsafe in most subsystems
//   - Coherence domains (dynamic graph-mincut partitions; merge on heavy
//     comms, split on trust drop)
//   - Capability tokens with 7 rights:
//       READ, WRITE, GRANT, REVOKE, EXECUTE, PROVE, GRANT_ONCE
//   - Three-tier proof verification: P1 / P2 / P3
//   - Witness-native syscalls — 64-byte SHA-256 hash-chained record
//     per privileged op
//   - Optional WASM guest runtime with agent lifecycle + cross-partition
//     migration
//   - Memory tiers: Hot / Warm / Dormant / Cold
//   - CPU 2-signal scheduler (deadline urgency + cut pressure)
//   - F1–F4 failure classes with graduated rollback
//   - License: Apache-2.0 OR MIT
//
// This adapter emits the per-harness RVM artefacts:
//   - rvm-partition.toml  partition manifest
//   - capability-table.json  derived from harness claims (kernel claims
//                            subsystem → RVM capability tokens)
//   - wasm-guest.json  references the kernel wasm bundle + lifecycle
//   - install-rvm.sh  idempotent runbook

import type { HostAdapter, HarnessSpec } from '@metaharness/kernel';

export const HOST_NAME = 'rvm' as const;

/** The 7 rights an RVM capability token carries. */
export type RvmRight =
  | 'READ' | 'WRITE' | 'GRANT' | 'REVOKE'
  | 'EXECUTE' | 'PROVE' | 'GRANT_ONCE';

/** Proof tier — P1 (cheapest) through P3 (strongest). */
export type ProofTier = 'P1' | 'P2' | 'P3';

/** Memory tier the partition prefers for its working set. */
export type MemoryTier = 'Hot' | 'Warm' | 'Dormant' | 'Cold';

export interface RvmCapabilityToken {
  /** Rights granted by this token. */
  rights: RvmRight[];
  /** Resource scope (mirrors the kernel claim's resource). */
  resource?: string;
  /** Proof verification tier required to exercise this capability. */
  proof_tier: ProofTier;
  /** Unix-second expiry (mirrors the kernel claim's expires_at). */
  expires_at: number;
  /** Optional GRANT_ONCE marker so RVM enforces single-use. */
  grant_once?: boolean;
}

/**
 * Map a kernel `Claim` to RVM capability rights. Convention:
 *   - capability starts with "*"          -> all 7 rights
 *   - capability ends with ".read"        -> [READ]
 *   - capability ends with ".write"       -> [WRITE]
 *   - capability ends with ".grant"       -> [GRANT]
 *   - capability ends with ".revoke"      -> [REVOKE]
 *   - capability ends with ".execute" or  -> [EXECUTE]
 *     starts with "tool.invoke"
 *   - capability ends with ".prove"       -> [PROVE]
 *   - capability ends with ".grant_once"  -> [GRANT_ONCE] + grant_once: true
 *   - "memory.*", "tool.*" etc.           -> all read/write/execute
 *   - default                              -> [READ]
 *
 * Per-capability sets are unioned when multiple claims target the same
 * resource.
 */
export function rightsFromCapability(capability: string): RvmRight[] {
  if (capability === '*' || capability === '*.*') {
    return ['READ', 'WRITE', 'GRANT', 'REVOKE', 'EXECUTE', 'PROVE', 'GRANT_ONCE'];
  }
  if (capability.endsWith('.read')) return ['READ'];
  if (capability.endsWith('.write')) return ['WRITE'];
  if (capability.endsWith('.grant')) return ['GRANT'];
  if (capability.endsWith('.revoke')) return ['REVOKE'];
  if (capability.endsWith('.execute') || capability.startsWith('tool.invoke')) return ['EXECUTE'];
  if (capability.endsWith('.prove')) return ['PROVE'];
  if (capability.endsWith('.grant_once')) return ['GRANT_ONCE'];
  if (capability.endsWith('.*')) return ['READ', 'WRITE', 'EXECUTE'];
  return ['READ'];
}

/**
 * Default proof tier per right family. P1 for read; P2 for write +
 * execute; P3 for grant / revoke / prove.
 */
export function defaultProofTier(rights: RvmRight[]): ProofTier {
  if (rights.some(r => r === 'GRANT' || r === 'REVOKE' || r === 'PROVE')) return 'P3';
  if (rights.some(r => r === 'WRITE' || r === 'EXECUTE')) return 'P2';
  return 'P1';
}

export interface KernelClaim {
  capability: string;
  resource?: string;
  expires_at: number;
}

/** Build the RVM capability table from the harness's kernel-side claims. */
export function buildCapabilityTable(claims: KernelClaim[]): RvmCapabilityToken[] {
  return claims.map(c => {
    const rights = rightsFromCapability(c.capability);
    return {
      rights,
      resource: c.resource,
      proof_tier: defaultProofTier(rights),
      expires_at: c.expires_at,
      grant_once: rights.includes('GRANT_ONCE') ? true : undefined,
    };
  });
}

/**
 * ADR-044 fix: derive RVM capability *rights* from a harness permission
 * allow-pattern (Claude-Code-style: `Read(...)`, `Bash(...)`, `mcp__srv__*`,
 * `Write`/`Edit`, `*`). The dotted-capability convention in
 * `rightsFromCapability` doesn't fit these patterns (they'd all fall through
 * to `[READ]`), so permission patterns get their own mapping: an `allow`
 * entry is a grant to *do* something, which is EXECUTE unless it is clearly a
 * pure read/write file op.
 */
export function rightsFromPermission(pattern: string): RvmRight[] {
  if (pattern === '*' || pattern === '*:*' || pattern === '*.*') {
    return ['READ', 'WRITE', 'GRANT', 'REVOKE', 'EXECUTE', 'PROVE', 'GRANT_ONCE'];
  }
  if (/^Read\b|^Read\(/i.test(pattern)) return ['READ'];
  if (/^(Write|Edit|MultiEdit)\b|^(Write|Edit|MultiEdit)\(/i.test(pattern)) return ['READ', 'WRITE'];
  // Tool invocation (MCP tools, Bash, Task, WebFetch, …) — the common case.
  return ['EXECUTE'];
}

/**
 * ADR-044 fix: build the capability table from a HarnessSpec instead of the
 * previously hard-coded empty array. Order of precedence:
 *   1. an explicit `(spec as any).claims: KernelClaim[]` extension (the
 *      "Caller wires actual claims via spec extensions" path) — uses the
 *      dotted-capability semantics via buildCapabilityTable;
 *   2. otherwise derive tokens from `spec.permissions.allow` (the harness's
 *      real default-deny posture, ADR-022).
 *
 * Deterministic (ADR-011 witness-stable): derived claims use a fixed expiry
 * sentinel of 0 ("non-expiring") rather than a wall-clock value.
 */
const DERIVED_CLAIM_EXPIRY = 0;
export function buildCapabilityTableForSpec(spec: HarnessSpec): RvmCapabilityToken[] {
  const explicit = (spec as { claims?: KernelClaim[] }).claims;
  if (explicit && explicit.length > 0) return buildCapabilityTable(explicit);
  const allow = spec.permissions?.allow ?? [];
  return allow.map(pattern => {
    const rights = rightsFromPermission(pattern);
    return {
      rights,
      resource: pattern,
      proof_tier: defaultProofTier(rights),
      expires_at: DERIVED_CLAIM_EXPIRY,
      grant_once: rights.includes('GRANT_ONCE') ? true : undefined,
    };
  });
}

export interface RvmPartitionSpec {
  /** Harness name; doubles as the partition's coherence domain seed. */
  name: string;
  /** Memory tier the partition's working set prefers. */
  memory_tier: MemoryTier;
  /** Deadline urgency 0..1 for the 2-signal scheduler. */
  deadline_urgency: number;
  /** Cut pressure 0..1 for the 2-signal scheduler. */
  cut_pressure: number;
  /** Witness key fingerprint (links partition to its signed manifest). */
  witness_key_fingerprint?: string;
}

export function defaultPartitionSpec(name: string): RvmPartitionSpec {
  return {
    name,
    memory_tier: 'Warm',
    deadline_urgency: 0.5,
    cut_pressure: 0.3,
  };
}

/** Escape a string for TOML basic-string literal. */
function tomlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

/**
 * Render the rvm-partition.toml content.
 */
export function partitionToml(spec: HarnessSpec, partition: RvmPartitionSpec = defaultPartitionSpec(spec.name)): string {
  const lines: string[] = [];
  lines.push('# Generated by @metaharness/host-rvm');
  lines.push('# RVM partition manifest for harness: ' + spec.name);
  lines.push('');
  lines.push('[partition]');
  lines.push(`name = "${tomlEscape(partition.name)}"`);
  lines.push(`memory_tier = "${partition.memory_tier}"`);
  lines.push(`deadline_urgency = ${partition.deadline_urgency.toFixed(2)}`);
  lines.push(`cut_pressure = ${partition.cut_pressure.toFixed(2)}`);
  if (partition.witness_key_fingerprint) {
    lines.push(`witness_key_fingerprint = "${tomlEscape(partition.witness_key_fingerprint)}"`);
  }
  lines.push('');
  lines.push('[wasm_guest]');
  lines.push(`package = "@metaharness/kernel"`);
  lines.push(`version = "0.1.0"`);
  lines.push(`lifecycle = "managed"`);
  lines.push('');
  if (spec.description || spec.systemPrompt) {
    lines.push('[metadata]');
    if (spec.description) lines.push(`description = "${tomlEscape(spec.description)}"`);
    // ADR-044: carry the harness system prompt so the wasm guest can load it.
    if (spec.systemPrompt) lines.push(`system_prompt = "${tomlEscape(spec.systemPrompt)}"`);
  }
  return lines.join('\n') + '\n';
}

/** Render the install runbook (idempotent). */
export function installScript(spec: HarnessSpec): string {
  return [
    '#!/usr/bin/env bash',
    '# RVM install runbook for harness: ' + spec.name,
    'set -euo pipefail',
    '',
    '# 1. Install RVM toolchain if missing',
    '# RVM is a kernel — we install the cargo-managed build chain, then',
    '# load the partition + wasm guest into a running RVM instance.',
    'if ! command -v rvm-loader >/dev/null 2>&1; then',
    '  echo "Building RVM from source (cargo + AArch64 target required)..."',
    '  cargo install rvm-loader || {',
    '    echo "rvm-loader is not on crates.io yet — build from source:"',
    '    echo "  git clone --recurse-submodules https://github.com/ruvnet/rvm.git"',
    '    echo "  cd rvm && make build && cargo install --path crates/rvm-loader"',
    '    exit 1',
    '  }',
    'fi',
    '',
    '# 2. Register the partition manifest',
    `rvm-loader partition register --manifest ./rvm-partition.toml`,
    '',
    '# 3. Install capability tokens',
    `rvm-loader caps install --table ./capability-table.json`,
    '',
    '# 4. Boot the WASM guest (the kernel wasm bundle)',
    `rvm-loader guest boot --partition "${spec.name}" --wasm-ref ./wasm-guest.json`,
    '',
    `echo "RVM partition '${spec.name}' is up. Hash-chained witness logs at ~/.rvm/witness/."`,
  ].join('\n') + '\n';
}

/** Render the wasm-guest.json — references the kernel wasm bundle. */
export function wasmGuestJson(spec: HarnessSpec): string {
  return JSON.stringify({
    schema: 1,
    partition: spec.name,
    guest: {
      package: '@metaharness/kernel',
      version: '0.1.0',
      entrypoint: 'pkg/ruflo_kernel_wasm.js',
    },
    // RVF (RuVector Format) — recommended companion for RVM-deployed
    // harnesses. Hardware-isolated vector storage inside the partition,
    // HNSW + SIMD via @ruvector/rvf-wasm. Optional; the partition still
    // boots if the user doesn't bundle it.
    companion: {
      vector_format: {
        package: '@ruvector/rvf',
        version: '^0.2.0',
        wasm_addon: '@ruvector/rvf-wasm',
        recommended: true,
        reason: 'RVM partitions benefit from in-partition HNSW vector storage; RVF is the matching binary format',
      },
    },
    lifecycle: 'managed',
    proof_tier_default: 'P2',
    failure_class_recovery: {
      F1: 'restart-guest',
      F2: 'rollback-to-checkpoint',
      F3: 'partition-fence',
      F4: 'partition-evict',
    },
  }, null, 2) + '\n';
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => ({
    'rvm-partition.toml': partitionToml(spec),
    // ADR-044 fix: was buildCapabilityTable([]) — always empty, so the entire
    // RVM capability-token security model emitted nothing. Now derived from the
    // harness's permission posture (or an explicit spec.claims extension).
    'capability-table.json': JSON.stringify(
      buildCapabilityTableForSpec(spec),
      null, 2,
    ) + '\n',
    'wasm-guest.json': wasmGuestJson(spec),
    'install-rvm.sh': installScript(spec),
  }),
};

export default adapter;
