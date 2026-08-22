// SPDX-License-Identifier: MIT

import type { ArcController } from '@metaharness/arc-agi-3';

export type McpLane = 'actor' | 'boss';

export interface ArcControllerFactoryContext {
  /** Stable within the authenticated MCP principal; never expose it to tools. */
  principalId: string;
  /** Public, unpredictable episode handle and the controller run id. */
  episodeId: string;
  runId: string;
}

/**
 * The operator closes over hidden game selection and bridge configuration.
 * No game id, title, version, or assignment selector crosses this boundary.
 */
export type ArcControllerFactory = ((
  context: ArcControllerFactoryContext,
) => ArcController | Promise<ArcController>) & {
  /** Explicit false prevents a replacement environment from being created. */
  supportsResume?: boolean;
  /** Roll back a controller allocation when its episode was never returned by arc_start. */
  releaseUnpublishedEpisode?: (
    context: ArcControllerFactoryContext,
  ) => void | Promise<void>;
  /** Close a shared bridge or scorecard after every created controller closes. */
  close?: () => void | Promise<void>;
};

export interface BearerPrincipal {
  token: string;
  principalId: string;
  /** Explicit route capabilities. Required when a public proxy host is allowed. */
  lanes?: readonly McpLane[];
}

export interface OAuthVerifiedPrincipal {
  readonly principalId: string;
  readonly scopes: readonly string[];
}

export interface OAuthVerificationContext {
  readonly resource: string;
  readonly requiredScopes: readonly string[];
  /** Aborted when the resource server verification deadline expires. */
  readonly signal: AbortSignal;
}

export interface OAuthResourceConfig {
  /** Canonical public HTTPS origin used as the token audience/resource. */
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly actorScope: string;
  readonly bossScope: string;
  readonly resourceDocumentation?: string;
  /** Hard response deadline. The underlying verifier retains its concurrency slot until it settles. */
  readonly verificationTimeoutMs?: number;
  /** Global cap for unresolved verifier calls, including calls that ignored cancellation. */
  readonly maxConcurrentVerifications?: number;
  /** Verify signature/introspection, issuer, audience, time claims, and scopes. */
  readonly verifyAccessToken: (
    token: string,
    context: OAuthVerificationContext,
  ) => OAuthVerifiedPrincipal | null | Promise<OAuthVerifiedPrincipal | null>;
}

export interface AuthConfig {
  /** If empty, the server is explicitly in single-principal local development mode. */
  bearerPrincipals?: readonly BearerPrincipal[];
  anonymousPrincipalId?: string;
  /** OAuth 2.1 resource-server integration for remote ChatGPT connections. */
  oauth?: OAuthResourceConfig;
}

export interface ToolPolicyConfig {
  toolTimeoutMs: number;
  maxToolCallsPerMinute: number;
}

export interface ServerLimits {
  maxRequestBytes: number;
  requestTimeoutMs: number;
  maxAuthenticationAttemptsPerMinute: number;
  maxTrackedAuthenticationClients: number;
}

export interface ArcMcpServerOptions {
  controllerFactory: ArcControllerFactory;
  auth?: AuthConfig;
  audit?: AuditSink;
  policy?: Partial<ToolPolicyConfig>;
  limits?: Partial<ServerLimits>;
  allowedHosts?: readonly string[];
  widgetHtml?: string;
  /** Explicit durable root for opaque, atomically-written checkpoint records. */
  stateRoot: string;
  maxEpisodesPerPrincipal?: number;
  maxIdempotencyEntriesPerPrincipal?: number;
  now?: () => Date;
}

export interface AuditEvent {
  timestamp: string;
  lane: McpLane;
  tool: string;
  principalHash: string;
  episodeHash?: string;
  decision: 'allowed' | 'denied' | 'error';
  reason: string;
  durationMs: number;
}

export interface AuditSink {
  write(event: AuditEvent): void | Promise<void>;
}

export interface StartedArcMcpServer {
  server: import('node:http').Server;
  host: string;
  port: number;
  actorUrl: URL;
  bossUrl: URL;
  close(): Promise<void>;
}

export type JsonObject = Record<string, unknown>;

const HIDDEN_IDENTITY_KEYS = new Set([
  'gameid',
  'gametitle',
  'gameversion',
  'title',
]);

/** Fail closed instead of silently editing authoritative controller output. */
export function assertNoHiddenGameIdentity(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    for (const [key, item] of Object.entries(candidate as Record<string, unknown>)) {
      const normalized = key.replaceAll('_', '').replaceAll('-', '').toLowerCase();
      if (HIDDEN_IDENTITY_KEYS.has(normalized)) {
        throw new Error('hidden game identity reached the public MCP boundary');
      }
      visit(item);
    }
  };
  visit(value);
}

/** JSON-round-trip public data and enforce the no-game-identity boundary. */
export function exactPublicJson(value: unknown): unknown {
  assertNoHiddenGameIdentity(value);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('controller returned non-JSON data');
  const parsed: unknown = JSON.parse(encoded);
  assertNoHiddenGameIdentity(parsed);
  return parsed;
}
