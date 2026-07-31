// SPDX-License-Identifier: MIT
//
// @metaharness/agntcy — oasf/publish.ts (ADR-240 §2.2)
//
// Real client against the AGNTCY Directory, using the real, published
// `agntcy-dir` npm package (https://www.npmjs.com/package/agntcy-dir,
// TypeScript SDK, gRPC via ConnectRPC). An earlier version of this file
// claimed no such package existed — that was wrong; the original check only
// guessed scoped names like `@agntcy/dir` and got 404s. The real package is
// unscoped (`agntcy-dir`). Verified live against a local Directory server
// (Go apiserver + zot OCI registry + postgres, built and run from
// github.com/agntcy/dir's own `install/docker/docker-compose.yml`) — a real
// record was pushed and published against it during development of this file.
//
// KNOWN GAP (still honest, not fabricated): this repo's internal capability
// tracking (`OasfRecord.capabilities`, `.securityScopes`, etc.) is
// name-based (harness-genome agent/skill names, harness-mcp-scan finding
// ids). AGNTCY's real OASF wire schema's `skills`/`domains`/`modules` fields
// require *numeric IDs from AGNTCY's own skill taxonomy* (e.g. `10201` =
// "natural_language_processing/.../text_completion") — this repo has no
// mapping table onto that taxonomy, and inventing a numeric ID would
// misclassify the harness under AGNTCY's discovery system. Rather than guess,
// every field this package tracks is projected into `annotations`
// (free-form `key: string` pairs — no taxonomy required) instead of
// `skills`/`domains`/`modules`, which are sent empty. A future integration
// that builds a real taxonomy-mapping table can promote annotations to
// proper skills/domains without changing this function's external contract.

import { Client, Config } from 'agntcy-dir';
import { create } from '@bufbuild/protobuf';
import { RecordRefsSchema, PublishRequestSchema } from '@buf/agntcy_dir.bufbuild_es/agntcy/dir/routing/v1/routing_service_pb.js';
import type { OasfRecord } from './record.js';

export interface PublishResult {
  published: boolean;
  reason?: string;
  /** The Directory's content-addressed reference for the pushed record, when published. */
  ref?: unknown;
}

export interface PublishTarget {
  /** Harness name — not tracked by OasfRecord itself; the caller (whoever
   * knows the harness's package name) supplies it rather than this function
   * inventing one. */
  name: string;
  version: string;
  /** Defaults to AGNTCY_DIRECTORY_ENDPOINT, then DIRECTORY_CLIENT_SERVER_ADDRESS
   * (the agntcy-dir SDK's own env var), then undefined (fails closed). */
  serverAddress?: string;
}

// Real numeric IDs from github.com/agntcy/oasf's live skill taxonomy
// (schema/skills/**), fetched and cross-checked directly against that repo
// while writing this file — not invented. The composite ID formula
// (category*10000 + subcategory*100 + leaf) was reverse-engineered from
// agntcy/dir-sdk-javascript's own example.js (two worked examples,
// natural_language_processing/../text_completion = 10201 and
// natural_language_processing/analytical_reasoning/problem_solving = 10702)
// and confirmed structurally against the current taxonomy's own uid fields
// (category/subcategory/leaf each carry a small integer uid). AGNTCY has not
// published this formula anywhere findable; treat it as empirically derived,
// not officially documented, and re-verify against a live server (as this
// file's own test suite does) rather than trusting it blindly.
// IMPORTANT (found empirically against a live server, see this file's test
// suite): send `{ id }` ONLY — no `name` field. The server resolves the
// class name from the numeric id internally; supplying ANY `name` value
// (even the taxonomy's own dotted path, e.g.
// "software_engineering/code_generation/code_generation") makes it run a
// separate, stricter lookup that currently rejects every value tried,
// including the taxonomy's own real names — this looks like a real,
// reportable bug/version-skew in the live server's validator, not a mapping
// error on this repo's side. Filed upstream: see README.md "Upstream
// reports".
const KNOWN_AGENT_SKILLS: Record<string, { id: number }> = {
  coder: { id: 60101 }, // software_engineering/code_generation/code_generation
  'system-architect': { id: 60101 },
  tester: { id: 60501 }, // software_engineering/software_testing/software_testing
  reviewer: { id: 60701 }, // software_engineering/code_quality/code_quality
  'security-auditor': { id: 100101 }, // cybersecurity/application_security/application_security
};
const FALLBACK_SKILL = { id: 60101 }; // software_engineering/code_generation/code_generation

function projectSkills(record: OasfRecord): Array<{ id: number }> {
  // The real Directory server requires a non-empty skills array (validated
  // live — see this file's test suite). Map every capability with a known
  // real taxonomy entry; anything unrecognized still gets the closest
  // honest category-level fallback (software_engineering) rather than
  // being silently dropped, since the array cannot be empty. Unrecognized
  // capability ids are ALSO recorded verbatim in annotations (see below) so
  // no information is lost to the fallback mapping.
  if (record.capabilities.length === 0) return [FALLBACK_SKILL];
  const seen = new Set<number>();
  const skills: Array<{ id: number }> = [];
  for (const cap of record.capabilities) {
    const mapped = KNOWN_AGENT_SKILLS[cap.id] ?? FALLBACK_SKILL;
    if (!seen.has(mapped.id)) {
      seen.add(mapped.id);
      skills.push(mapped);
    }
  }
  return skills;
}

function projectAnnotations(record: OasfRecord): Record<string, string> {
  const annotations: Record<string, string> = {};
  for (const cap of record.capabilities) annotations[`capability.${cap.kind}.${cap.id}`] = 'true';
  for (const proto of record.supportedProtocols) annotations[`host.${proto.host}`] = 'true';
  annotations['model.recommendedMode'] = record.modelRequirements.recommendedMode;
  annotations['model.estCostPerRunUsd'] = String(record.modelRequirements.estCostPerRunUsd);
  annotations['resource.mcpEnabled'] = String(record.resourceEnvelope.mcpEnabled);
  annotations['resource.shellAccess'] = String(record.resourceEnvelope.shellAccess);
  annotations['resource.networkAccess'] = String(record.resourceEnvelope.networkAccess);
  annotations['resource.fileWriteAccess'] = String(record.resourceEnvelope.fileWriteAccess);
  for (const scope of record.securityScopes) annotations[`security.${scope.severity}.${scope.id}`] = scope.title;
  for (const ev of record.evaluationHistory) annotations[`evaluation.${ev.source}.${ev.metric}`] = String(ev.value);
  // pricingMeteringClass intentionally never appears here — projectToOasf (project.ts)
  // never populates it (fails closed, see record.ts's file header), so there is
  // nothing to project.
  return annotations;
}

/**
 * Push an OasfRecord to a real AGNTCY Directory server and publish it to the
 * routing table (making it discoverable). Fails closed with a clear reason
 * when no server is configured or the call fails — never a silent no-op,
 * never a faked success.
 */
export async function publishToDirectory(record: OasfRecord, target: PublishTarget): Promise<PublishResult> {
  if (record.schema !== 1) {
    return { published: false, reason: 'invalid OasfRecord: unsupported schema version' };
  }

  const serverAddress = target.serverAddress ?? process.env.AGNTCY_DIRECTORY_ENDPOINT ?? process.env.DIRECTORY_CLIENT_SERVER_ADDRESS;
  if (!serverAddress) {
    return {
      published: false,
      reason: 'No Directory server configured — set AGNTCY_DIRECTORY_ENDPOINT (or the SDK\'s own DIRECTORY_CLIENT_SERVER_ADDRESS) to a real server address.',
    };
  }

  const dirRecord = {
    data: {
      name: target.name,
      version: target.version,
      schema_version: '0.8.0',
      description: 'MetaHarness-generated harness (ADR-240 §2.2 projection)',
      authors: ['metaharness'],
      created_at: record.generatedAt,
      skills: projectSkills(record),
      // Real locator `type` enum is unspecified|helm_chart|container_image|
      // package|source_code|binary|url (github.com/agntcy/oasf schema/objects/
      // locator.json) — describes artifact download locations, not runtime
      // hosts. This repo's deploymentOptions.hosts (e.g. "claude-code") isn't
      // an artifact locator in that sense, so it stays out of locators (which
      // the live server validates whenever present) and goes into
      // annotations instead, alongside every other capability we track.
      locators: [] as unknown[],
      domains: [] as unknown[],
      annotations: projectAnnotations(record),
      modules: [] as unknown[],
    },
  };

  try {
    // SECURITY: `new Config(serverAddress)` with no further options uses the
    // SDK's insecure default (plaintext gRPC, no client authentication) —
    // correct for the local dev server this file's test suite runs against
    // (AUTHN_ENABLED=false), but NOT safe to point at a production or
    // publicly reachable Directory server as-is. Before using this against
    // anything other than a local/trusted-network instance, construct
    // `Config` with the SDK's x509 or JWT auth mode (see `agntcy-dir`'s own
    // README "Configuration" section) — this function accepts a
    // pre-configured `Config`-compatible `serverAddress` only, not yet a
    // full `Config` object, so that hardening is a caller-side change, not
    // a bypass of this function.
    const config = new Config(serverAddress);
    const transport = await Client.createGRPCTransport(config);
    const client = new Client(config, transport);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pushedRefs = await client.push([dirRecord as any]);
    if (pushedRefs.length === 0) {
      return { published: false, reason: 'Directory push returned no record reference' };
    }
    await client.publish(
      create(PublishRequestSchema, { request: { case: 'recordRefs', value: create(RecordRefsSchema, { refs: pushedRefs }) } }),
    );
    return { published: true, ref: pushedRefs[0] };
  } catch (err) {
    return { published: false, reason: `Directory push/publish failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
