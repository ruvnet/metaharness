// SPDX-License-Identifier: MIT
//
// `harness publish` — pin a generated harness to IPFS via Pinata, then
// (optionally) chain into `npm publish --provenance`.
//
// Per ADR-005 (Marketplace plugin design), the generated harness uploads
// its tarball to IPFS so the ruflo plugin marketplace can discover it
// by CID. Pinata is the default pin provider (matches ruflo's existing
// plugin registry); other providers can drop in via the same interface.
//
// Security:
//   - PINATA_API_JWT MUST come from env (never from a file in the repo)
//   - The CI publish workflow fetches it from GCP Secret Manager via WIF
//   - Local-dev publishes are gated behind --confirm so a typo doesn't
//     accidentally pin

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findWitness, readAndVerify } from './witness-client.js';

export interface PinataConfig {
  /** Bearer JWT for Pinata's API. Must come from env or GCP Secret Manager. */
  jwt: string;
  /** Pinata API host. Defaults to https://api.pinata.cloud. */
  baseUrl?: string;
}

export interface PinResult {
  /** IPFS CID returned by the pin service. */
  cid: string;
  /** Bytes uploaded. */
  size: number;
  /** ISO-8601 timestamp from Pinata. */
  timestamp: string;
}

/**
 * Pin a JSON blob to IPFS via Pinata. Returns the CID.
 *
 * This is the lower-level primitive — `publishHarness` below packages the
 * harness manifest into a JSON blob first.
 */
export async function pinJson(
  config: PinataConfig,
  payload: unknown,
  metadata: { name: string; keyvalues?: Record<string, string> },
): Promise<PinResult> {
  if (!config.jwt) {
    throw new Error('PINATA_API_JWT is required (set env or fetch from GCP Secret Manager)');
  }
  const baseUrl = config.baseUrl ?? 'https://api.pinata.cloud';
  const url = `${baseUrl}/pinning/pinJSONToIPFS`;

  const body = JSON.stringify({
    pinataContent: payload,
    pinataMetadata: metadata,
    pinataOptions: { cidVersion: 1 },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.jwt}`,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pinata pin failed: HTTP ${res.status} ${res.statusText} — ${txt}`);
  }

  const data = await res.json() as { IpfsHash: string; PinSize: number; Timestamp: string };
  return {
    cid: data.IpfsHash,
    size: data.PinSize,
    timestamp: data.Timestamp,
  };
}

export interface HarnessPublishOptions {
  /** Path to the harness directory (must have .harness/manifest.json). */
  harnessDir: string;
  /** Pinata config. */
  pinata: PinataConfig;
  /** When true, signs and pins; when false, runs the dry-run path only. */
  confirm: boolean;
  /** Optional override of the harness's name (defaults to manifest.vars.name). */
  name?: string;
  /**
   * GH #4 (HIGH-1): explicitly publish even when a present witness could NOT be cryptographically
   * verified (no verifier available). Off by default — publishing is fail-closed on an unverified
   * witness so a garbage signature can't masquerade as signed. The signature is NOT checked when set.
   */
  allowUnverified?: boolean;
}

export interface PublishResult {
  /** IPFS CID of the pinned manifest. */
  manifestCid: string;
  /** Bytes pinned. */
  manifestSize: number;
  /** Whether this was a confirmed pin or a dry-run. */
  confirmed: boolean;
}

/**
 * Publish a generated harness:
 *   1. Read .harness/manifest.json
 *   2. Verify the witness signature (TODO: wire into kernel.witnessVerify)
 *   3. Pin the manifest to IPFS via Pinata
 *   4. Return the CID
 *
 * Dry-run mode (`confirm: false`) does steps 1-2 and returns a CID of
 * `dry-run-no-pin` so smoke tests can assert the call shape without
 * spending Pinata quota.
 */
export async function publishHarness(opts: HarnessPublishOptions): Promise<PublishResult> {
  const manifestPath = join(opts.harnessDir, '.harness', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`no manifest at ${manifestPath} — is ${opts.harnessDir} a generated harness?`);
  }
  const raw = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(raw) as Record<string, unknown>;

  // Iter-6 security gate: verify the witness signature before pinning.
  // We accept missing witness.json (witness signing is iter-7+ end-to-end
  // wired) but tampered manifests fail loudly.
  const witnessPath = findWitness(opts.harnessDir);
  if (witnessPath) {
    const { result } = await readAndVerify(witnessPath);
    if (!result.valid) {
      throw new Error(`witness verification failed: ${result.reason ?? 'unknown'}`);
    }
    // GH #4 (HIGH-1): a witness whose signature was NOT cryptographically verified (shape-only
    // degraded mode — no kernel verifier) must NOT be published as "signed". Before this, that path
    // returned valid:true, so a shape-valid witness carrying a garbage signature published silently as
    // verified. Fail closed unless the caller explicitly opts in (and is then told the sig was unchecked).
    if (result.unverified && !opts.allowUnverified) {
      throw new Error(
        `witness present at ${witnessPath} but its signature was NOT cryptographically verified ` +
        `(${result.reason ?? 'no verifier available'}). Refusing to publish this harness as signed. ` +
        `Re-run with --allow-unverified-witness to publish anyway — the signature will NOT have been checked.`,
      );
    }
  }

  if (!opts.confirm) {
    return {
      manifestCid: 'dry-run-no-pin',
      manifestSize: Buffer.byteLength(raw, 'utf-8'),
      confirmed: false,
    };
  }

  const result = await pinJson(opts.pinata, manifest, {
    name: opts.name ?? (manifest['vars'] as { name?: string } | undefined)?.name ?? 'harness',
    keyvalues: {
      template: String(manifest['template'] ?? ''),
      generator: String(manifest['generator'] ?? ''),
    },
  });

  return {
    manifestCid: result.cid,
    manifestSize: result.size,
    confirmed: true,
  };
}
