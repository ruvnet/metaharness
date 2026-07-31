// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — oasf/publish-stub.ts (ADR-237 §2.2)
//
// A repo-wide check found ZERO AGNTCY Directory client libraries or public
// endpoints on npm/crates.io under any plausible name (verified 404 on every
// guessed name — see packages/agntcy/README.md "Status" section). There is
// nothing real for this package to call, so `publishToDirectory` is a real,
// honest, clearly-erroring stub — never a silent no-op and never a faked
// success — per this ADR's and the package README's explicit instruction.
//
// This function ALWAYS returns `published: false`, even when a `directoryUrl`
// is supplied: knowing an endpoint address does not give this package a
// client library that speaks whatever wire protocol the (not-yet-published)
// AGNTCY Directory API uses. The config-gate this stub anticipates is
// `AGNTCY_DIRECTORY_ENDPOINT` (see README.md); it is read here (env var, or
// the `directoryUrl` argument) purely so the returned `reason` can say whether
// a target was configured — it is never dialed.

import type { OasfRecord } from './record.js';

export interface PublishResult {
  published: boolean;
  reason?: string;
}

const NOT_CONFIGURED_REASON =
  'AGNTCY Directory not yet configured — no public endpoint/SDK available, see ADR-237 §2.2 / ADR-324. ' +
  'Set AGNTCY_DIRECTORY_ENDPOINT once a real client library exists to enable this call; no record was published.';

/**
 * Attempt to publish an OasfRecord to the AGNTCY Directory. Always fails
 * closed today — see file header. `record` is accepted (and shape-checked at
 * the type level via `OasfRecord`) so the call site is exactly what a real
 * implementation would need, but it is never sent anywhere.
 */
export async function publishToDirectory(record: OasfRecord, directoryUrl?: string): Promise<PublishResult> {
  const configuredUrl = directoryUrl ?? process.env.AGNTCY_DIRECTORY_ENDPOINT;
  if (record.schema !== 1) {
    return { published: false, reason: 'invalid OasfRecord: unsupported schema version' };
  }
  return {
    published: false,
    reason: configuredUrl ? `${NOT_CONFIGURED_REASON} (target ${configuredUrl} was supplied but cannot be dialed)` : NOT_CONFIGURED_REASON,
  };
}
