// SPDX-License-Identifier: MIT

import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type {
  AuthConfig,
  BearerPrincipal,
  McpLane,
  OAuthResourceConfig,
  OAuthVerificationContext,
} from './types.js';

export interface AuthenticationResult {
  ok: boolean;
  principalId?: string;
  lanes?: readonly McpLane[];
  status: 401 | 403 | 429;
  reason: string;
}

const DEFAULT_OAUTH_VERIFICATION_TIMEOUT_MS = 5_000;
const DEFAULT_OAUTH_MAX_CONCURRENT_VERIFICATIONS = 16;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} is outside the accepted range`);
  }
  return resolved;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

function validPrincipals(values: readonly BearerPrincipal[] | undefined): BearerPrincipal[] {
  const seen = new Set<string>();
  return (values ?? []).map((entry) => {
    const strongHex = /^[a-f0-9]{64,}$/i.test(entry.token);
    const strongBase64Url = /^[A-Za-z0-9_-]{43,}$/.test(entry.token);
    if ((!strongHex && !strongBase64Url) || entry.token.length > 4096) {
      throw new Error('bearer tokens must contain at least 32 random bytes');
    }
    if (seen.has(entry.token)) throw new Error('duplicate bearer token configuration');
    seen.add(entry.token);
    if (!/^[A-Za-z0-9._:@/-]{1,200}$/.test(entry.principalId)) {
      throw new Error('invalid bearer principal configuration');
    }
    const lanes = entry.lanes === undefined ? undefined : [...new Set(entry.lanes)];
    if (lanes?.some((lane) => lane !== 'actor' && lane !== 'boss') || lanes?.length === 0) {
      throw new Error('bearer lane scopes must contain actor and/or boss');
    }
    return { ...entry, lanes };
  });
}

function httpsUrl(value: string, name: string, originOnly: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (originOnly && parsed.pathname !== '/')
  ) {
    throw new Error(`${name} must be a canonical HTTPS ${originOnly ? 'origin' : 'URL'}`);
  }
  return originOnly ? parsed.origin : parsed.toString().replace(/\/$/, '');
}

function oauthScope(value: string, name: string): string {
  if (!/^[\x21-\x7e]{1,200}$/.test(value) || /["\\,]/.test(value)) {
    throw new Error(`${name} must be a bounded OAuth scope token`);
  }
  return value;
}

function validOAuth(input: OAuthResourceConfig): OAuthResourceConfig {
  if (!input || typeof input !== 'object') throw new Error('invalid OAuth resource configuration');
  if (!Array.isArray(input.authorizationServers) || input.authorizationServers.length === 0) {
    throw new Error('OAuth requires at least one authorization server');
  }
  if (typeof input.verifyAccessToken !== 'function') {
    throw new Error('OAuth verifyAccessToken callback is required');
  }
  const actorScope = oauthScope(input.actorScope, 'actorScope');
  const bossScope = oauthScope(input.bossScope, 'bossScope');
  if (actorScope === bossScope) throw new Error('actorScope and bossScope must be distinct');
  const verificationTimeoutMs = boundedInteger(
    input.verificationTimeoutMs,
    DEFAULT_OAUTH_VERIFICATION_TIMEOUT_MS,
    100,
    30_000,
    'verificationTimeoutMs',
  );
  const maxConcurrentVerifications = boundedInteger(
    input.maxConcurrentVerifications,
    DEFAULT_OAUTH_MAX_CONCURRENT_VERIFICATIONS,
    1,
    256,
    'maxConcurrentVerifications',
  );
  return Object.freeze({
    resource: httpsUrl(input.resource, 'OAuth resource', true),
    authorizationServers: Object.freeze([
      ...new Set(input.authorizationServers.map((value) =>
        httpsUrl(value, 'OAuth authorization server', false))),
    ]),
    actorScope,
    bossScope,
    ...(input.resourceDocumentation === undefined
      ? {}
      : { resourceDocumentation: httpsUrl(input.resourceDocumentation, 'resourceDocumentation', false) }),
    verificationTimeoutMs,
    maxConcurrentVerifications,
    verifyAccessToken: input.verifyAccessToken,
  });
}

type OAuthVerificationResult =
  | { readonly kind: 'verified'; readonly principal: Awaited<ReturnType<OAuthResourceConfig['verifyAccessToken']>> }
  | { readonly kind: 'failed' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'busy' };

/**
 * Bounds expensive OAuth verification. A verifier that ignores AbortSignal
 * continues occupying its slot until the underlying promise actually settles.
 */
export class OAuthVerificationGate {
  private unresolved = 0;

  constructor(private readonly config: OAuthResourceConfig) {}

  async verify(
    token: string,
    context: Omit<OAuthVerificationContext, 'signal'>,
  ): Promise<OAuthVerificationResult> {
    const limit = this.config.maxConcurrentVerifications
      ?? DEFAULT_OAUTH_MAX_CONCURRENT_VERIFICATIONS;
    if (this.unresolved >= limit) return { kind: 'busy' };
    this.unresolved += 1;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const underlying = Promise.resolve()
      .then(() => this.config.verifyAccessToken(token, { ...context, signal: abort.signal }))
      .then(
        (principal) => ({ kind: 'verified' as const, principal }),
        () => ({ kind: 'failed' as const }),
      )
      .finally(() => { this.unresolved -= 1; });
    const timeout = new Promise<{ readonly kind: 'timeout' }>((resolveTimeout) => {
      timer = setTimeout(() => {
        abort.abort(new Error('OAuth verification deadline exceeded'));
        resolveTimeout({ kind: 'timeout' });
      }, this.config.verificationTimeoutMs ?? DEFAULT_OAUTH_VERIFICATION_TIMEOUT_MS);
      timer.unref?.();
    });
    const result = await Promise.race([underlying, timeout]);
    if (result.kind !== 'timeout' && timer) clearTimeout(timer);
    return result;
  }
}

export function validateAuthConfig(config: AuthConfig = {}): AuthConfig {
  if (config.oauth) {
    if (config.bearerPrincipals?.length || config.anonymousPrincipalId !== undefined) {
      throw new Error('OAuth cannot be combined with bearer or anonymous authentication');
    }
    return { oauth: validOAuth(config.oauth) };
  }
  const bearerPrincipals = validPrincipals(config.bearerPrincipals);
  const anonymousPrincipalId = config.anonymousPrincipalId ?? 'local-anonymous';
  if (!/^[A-Za-z0-9._:@/-]{1,200}$/.test(anonymousPrincipalId)) {
    throw new Error('invalid anonymous principal configuration');
  }
  return bearerPrincipals.length > 0
    ? { bearerPrincipals }
    : { anonymousPrincipalId };
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const value = headers.authorization;
  if (value === undefined) return undefined;
  if (!value.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length);
}

function validResolvedPrincipal(principalId: string): boolean {
  return /^[A-Za-z0-9._:@/-]{1,200}$/.test(principalId);
}

export function oauthScopeForLane(config: OAuthResourceConfig, lane: McpLane): string {
  return lane === 'actor' ? config.actorScope : config.bossScope;
}

export function oauthMetadataUrl(config: OAuthResourceConfig): string {
  return `${config.resource}/.well-known/oauth-protected-resource`;
}

export function oauthChallenge(
  config: OAuthResourceConfig,
  lane: McpLane,
  error = 'invalid_token',
): string {
  const scope = oauthScopeForLane(config, lane);
  return `Bearer resource_metadata="${oauthMetadataUrl(config)}", scope="${scope}", error="${error}"`;
}

export function oauthProtectedResourceMetadata(config: OAuthResourceConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [...config.authorizationServers],
    scopes_supported: [config.actorScope, config.bossScope],
    ...(config.resourceDocumentation === undefined
      ? {}
      : { resource_documentation: config.resourceDocumentation }),
  };
}

export async function authenticate(
  headers: IncomingHttpHeaders,
  config: AuthConfig = {},
  lane?: McpLane,
  oauthGate?: OAuthVerificationGate,
): Promise<AuthenticationResult> {
  const validated = validateAuthConfig(config);
  if (validated.oauth) {
    if (!lane) return { ok: false, status: 401, reason: 'OAuth lane is required' };
    const token = bearerToken(headers);
    if (!token) return { ok: false, status: 401, reason: 'OAuth bearer token required' };
    const requiredScope = oauthScopeForLane(validated.oauth, lane);
    const gate = oauthGate ?? new OAuthVerificationGate(validated.oauth);
    const verification = await gate.verify(token, {
      resource: validated.oauth.resource,
      requiredScopes: [requiredScope],
    });
    if (verification.kind === 'busy') {
      return { ok: false, status: 429, reason: 'OAuth verification capacity exceeded' };
    }
    if (verification.kind === 'timeout' || verification.kind === 'failed') {
      return { ok: false, status: 401, reason: 'OAuth token verification failed' };
    }
    const resolved = verification.principal;
    if (!resolved || !validResolvedPrincipal(resolved.principalId)) {
      return { ok: false, status: 401, reason: 'invalid OAuth access token' };
    }
    if (!Array.isArray(resolved.scopes) || !resolved.scopes.includes(requiredScope)) {
      return { ok: false, status: 403, reason: 'OAuth token has insufficient scope' };
    }
    return {
      ok: true,
      principalId: resolved.principalId,
      lanes: [lane],
      status: 401,
      reason: 'authenticated',
    };
  }
  const configured = validated.bearerPrincipals ?? [];
  if (configured.length === 0) {
    return {
      ok: true,
      principalId: validated.anonymousPrincipalId ?? 'local-anonymous',
      lanes: ['actor', 'boss'],
      status: 401,
      reason: 'local development principal',
    };
  }

  const supplied = bearerToken(headers);
  if (!supplied) {
    return { ok: false, status: 401, reason: 'bearer authentication required' };
  }
  let match: BearerPrincipal | undefined;
  for (const candidate of configured) {
    if (constantTimeEqual(supplied, candidate.token)) match = candidate;
  }
  if (!match) return { ok: false, status: 403, reason: 'invalid bearer credential' };
  return {
    ok: true,
    principalId: match.principalId,
    lanes: match.lanes ?? ['actor', 'boss'],
    status: 401,
    reason: 'authenticated',
  };
}

export function authConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const json = env.ARC_MCP_BEARER_PRINCIPALS;
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('ARC_MCP_BEARER_PRINCIPALS must be valid JSON');
    }
    if (!Array.isArray(parsed)) throw new Error('ARC_MCP_BEARER_PRINCIPALS must be an array');
    return validateAuthConfig({ bearerPrincipals: parsed as BearerPrincipal[] });
  }
  if (env.ARC_MCP_BEARER_TOKEN) {
    return validateAuthConfig({
      bearerPrincipals: validPrincipals([{
        token: env.ARC_MCP_BEARER_TOKEN,
        principalId: env.ARC_MCP_BEARER_PRINCIPAL ?? 'configured-bearer',
        lanes: (env.ARC_MCP_BEARER_LANES ?? 'actor')
          .split(',')
          .map((value) => value.trim()) as McpLane[],
      }]),
    });
  }
  return validateAuthConfig({ anonymousPrincipalId: 'local-anonymous' });
}
