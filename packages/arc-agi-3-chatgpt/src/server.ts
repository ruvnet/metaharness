// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { parse, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  authenticate,
  authConfigFromEnvironment,
  OAuthVerificationGate,
  oauthChallenge,
  oauthProtectedResourceMetadata,
  oauthScopeForLane,
  validateAuthConfig,
} from './auth.js';
import { FileAuditSink } from './audit.js';
import { ToolPolicyGate } from './policy.js';
import { registerArcWidgetResource, loadWidgetHtml } from './resource.js';
import { ArcEpisodeStore } from './store.js';
import { registerActorTools, registerBossTools } from './tools.js';
import type {
  ArcMcpServerOptions,
  AuthConfig,
  McpLane,
  ServerLimits,
  StartedArcMcpServer,
} from './types.js';

export const DEFAULT_SERVER_LIMITS: ServerLimits = {
  maxRequestBytes: 256 * 1024,
  requestTimeoutMs: 15_000,
  maxAuthenticationAttemptsPerMinute: 120,
  maxTrackedAuthenticationClients: 1_024,
};

export const MAX_SERVER_LIMITS: Readonly<ServerLimits> = Object.freeze({
  maxRequestBytes: 64 * 1024 * 1024,
  requestTimeoutMs: 300_000,
  maxAuthenticationAttemptsPerMinute: 100_000,
  maxTrackedAuthenticationClients: 1_000_000,
});

const ACTOR_INSTRUCTIONS = [
  'ChatGPT is the reasoning host; this server never calls an LLM.',
  'For an existing episode call arc_observe first. For a new episode call arc_start with a fresh idempotency key.',
  'Use the returned exact structured observation, never the canvas alone.',
  'Act once with the current observation hash, an explicit expected effect, and an idempotency key.',
  'Persist evidence with arc_memory_commit and recover it with arc_memory_query.',
  'Guarded plans stop on their first postcondition mismatch.',
  'No hidden game id or title is available.',
].join(' ');

const BOSS_INSTRUCTIONS = [
  'You are a supervisor in a separate ChatGPT conversation.',
  'This MCP lane has evidence read and typed directive commit tools only; it has no environment action capability.',
  'Read arc_supervisor_case, separate facts from hypotheses, and commit exactly three causal, falsifiable hypotheses bound to the current observation and case hashes.',
  'Never infer hidden state or attempt an action.',
].join(' ');

class HttpProblem extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface AuthenticationWindow {
  startedAtMs: number;
  attempts: number;
}

/** Bounded, per-address fixed-window limiter applied before token verification. */
class PreAuthenticationGate {
  private readonly windows = new Map<string, AuthenticationWindow>();

  constructor(
    private readonly maxAttempts: number,
    private readonly maxClients: number,
    private readonly now: () => number,
  ) {}

  allow(address: string): boolean {
    const minute = 60_000;
    const key = this.windows.has(address) || this.windows.size < this.maxClients
      ? address
      : '__overflow__';
    const prior = this.windows.get(key);
    const now = this.now();
    if (!prior || now - prior.startedAtMs >= minute) {
      if (this.windows.size >= this.maxClients && !this.windows.has(key)) {
        for (const [candidate, window] of this.windows) {
          if (now - window.startedAtMs >= minute) this.windows.delete(candidate);
        }
      }
      this.windows.set(key, { startedAtMs: now, attempts: 1 });
      return true;
    }
    prior.attempts += 1;
    return prior.attempts <= this.maxAttempts;
  }
}

function jsonRpcError(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32_000, message },
    id: null,
  }));
}

function normalizedHost(value: string | undefined): string | undefined {
  if (!value || value.length > 512 || /[\r\n]/.test(value)) return undefined;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function requestHostAllowed(request: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const host = normalizedHost(request.headers.host);
  if (!host) return false;
  return allowedHosts.some((entry) => normalizedHost(entry) === host || entry.toLowerCase() === host);
}

function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    return Promise.reject(new HttpProblem(413, 'request body too large'));
  }
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    request.resume();
    return Promise.reject(new HttpProblem(415, 'application/json is required'));
  }
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      callback();
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) {
        finish(() => rejectBody(new HttpProblem(413, 'request body too large')));
        request.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => finish(() => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectBody(new HttpProblem(400, 'invalid JSON request'));
      }
    });
    const onError = (): void => finish(() => rejectBody(new HttpProblem(400, 'request body failed')));
    const timer = setTimeout(() => {
      finish(() => rejectBody(new HttpProblem(408, 'request body deadline exceeded')));
      request.destroy();
    }, timeoutMs);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

export interface ArcMcpRuntime {
  readonly server: Server;
  readonly store: ArcEpisodeStore;
  readonly auth: AuthConfig;
  readonly allowedHosts: readonly string[];
  close(): Promise<void>;
}

async function validateStateRoot(path: string | undefined): Promise<string> {
  if (!path?.trim()) throw new Error('stateRoot is required');
  const root = resolve(path);
  if (parse(root).root === root) throw new Error('stateRoot must not be a filesystem root');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const nonce = randomBytes(8).toString('hex');
  const probe = resolve(root, `.write-probe-${nonce}`);
  const replacement = resolve(root, `.replace-probe-${nonce}`);
  await writeFile(probe, 'old', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await writeFile(replacement, 'new', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(replacement, probe);
  } finally {
    await Promise.allSettled([unlink(probe), unlink(replacement)]);
  }
  return root;
}

type ToolSecurityScheme =
  | { readonly type: 'noauth' }
  | { readonly type: 'oauth2'; readonly scopes: readonly string[] };

function installToolSecurityMetadata(
  server: McpServer,
  schemes: readonly ToolSecurityScheme[],
): void {
  const original = server.registerTool.bind(server) as (
    name: string,
    config: Record<string, unknown>,
    callback: (...args: never[]) => unknown,
  ) => unknown;
  Object.defineProperty(server, 'registerTool', {
    configurable: true,
    value: (
      name: string,
      config: Record<string, unknown>,
      callback: (...args: never[]) => unknown,
    ) => original(name, {
      ...config,
      _meta: {
        ...((config._meta as Record<string, unknown> | undefined) ?? {}),
        securitySchemes: schemes.map((scheme) => ({
          ...scheme,
          ...('scopes' in scheme ? { scopes: [...scheme.scopes] } : {}),
        })),
      },
    }, callback),
  });
}

/**
 * MCP SDK 1.x serializes extension fields only inside `_meta`. ChatGPT also
 * requires the same securitySchemes at the Tool root. Wrap the already
 * installed tools/list handler and promote only that reviewed field. The SDK
 * dependency is patch-pinned and an integration test covers the wire result.
 */
function promoteToolSecuritySchemes(server: McpServer): void {
  const protocol = server.server as unknown as {
    _requestHandlers: Map<string, (
      request: unknown,
      extra: unknown,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>>;
  };
  const original = protocol._requestHandlers.get('tools/list');
  if (!original) throw new Error('MCP tools/list handler is unavailable');
  protocol._requestHandlers.set('tools/list', async (request, extra) => {
    const result = await original(request, extra);
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return {
      ...result,
      tools: tools.map((candidate) => {
        if (!candidate || typeof candidate !== 'object') return candidate;
        const tool = candidate as Record<string, unknown>;
        const meta = tool._meta && typeof tool._meta === 'object'
          ? tool._meta as Record<string, unknown>
          : undefined;
        return Array.isArray(meta?.securitySchemes)
          ? { ...tool, securitySchemes: meta.securitySchemes }
          : tool;
      }),
    };
  });
}

function createProtocolServer(
  lane: McpLane,
  principalId: string,
  store: ArcEpisodeStore,
  policy: ToolPolicyGate,
  widgetHtml: string,
  auth: AuthConfig,
): McpServer {
  const server = new McpServer(
    { name: `metaharness-arc-agi-3-${lane}`, version: '0.1.0' },
    { instructions: lane === 'actor' ? ACTOR_INSTRUCTIONS : BOSS_INSTRUCTIONS },
  );
  const securitySchemes: readonly ToolSecurityScheme[] = auth.oauth
    ? [{ type: 'oauth2', scopes: [oauthScopeForLane(auth.oauth, lane)] }]
    : auth.bearerPrincipals?.length
      ? []
      : [{ type: 'noauth' }];
  if (securitySchemes.length > 0) installToolSecurityMetadata(server, securitySchemes);
  const context = { lane, principalId, store, policy };
  if (lane === 'actor') {
    registerActorTools(server, context);
    registerArcWidgetResource(server, widgetHtml);
  } else {
    registerBossTools(server, context);
  }
  if (securitySchemes.length > 0) promoteToolSecuritySchemes(server);
  return server;
}

export async function createArcMcpRuntime(options: ArcMcpServerOptions): Promise<ArcMcpRuntime> {
  const auth = validateAuthConfig(options.auth ?? authConfigFromEnvironment());
  const audit = options.audit ?? new FileAuditSink();
  const now = options.now ?? (() => new Date());
  const policy = new ToolPolicyGate(audit, options.policy, now);
  const limits = { ...DEFAULT_SERVER_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits) as [keyof ServerLimits, number][]) {
    const maximum = MAX_SERVER_LIMITS[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be a positive safe integer no greater than ${maximum}`);
    }
  }
  const oauthGate = auth.oauth ? new OAuthVerificationGate(auth.oauth) : undefined;
  const preAuthenticationGate = new PreAuthenticationGate(
    limits.maxAuthenticationAttemptsPerMinute,
    limits.maxTrackedAuthenticationClients,
    () => now().getTime(),
  );
  const widgetHtml = options.widgetHtml ?? await loadWidgetHtml();
  const stateRoot = await validateStateRoot(options.stateRoot);
  const store = new ArcEpisodeStore(
    options.controllerFactory,
    stateRoot,
    now,
    options.maxEpisodesPerPrincipal ?? 32,
    options.maxIdempotencyEntriesPerPrincipal ?? 50_000,
  );
  const allowedHosts = options.allowedHosts?.length
    ? [...options.allowedHosts]
    : ['127.0.0.1', 'localhost', '[::1]'];
  const hasPublicProxyHost = allowedHosts.some((entry) => {
    const host = normalizedHost(entry);
    if (!host) throw new Error('allowedHosts contains an invalid host');
    return !isLoopbackHost(host);
  });
  if (hasPublicProxyHost && !auth.oauth && (auth.bearerPrincipals?.length ?? 0) === 0) {
    throw new Error('public tunnel or proxy hosts require OAuth or configured bearer principals');
  }
  if (hasPublicProxyHost && auth.bearerPrincipals?.some((entry) => !entry.lanes?.length)) {
    throw new Error('public tunnel or proxy hosts require explicit bearer lane scopes');
  }

  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('access-control-expose-headers', 'Mcp-Session-Id');

    if (!requestHostAllowed(request, allowedHosts)) {
      jsonRpcError(response, 421, 'host is not allowed');
      return;
    }

    const path = new URL(request.url ?? '/', 'http://mcp.invalid').pathname;
    if (
      auth.oauth
      && path === '/.well-known/oauth-protected-resource'
      && request.method === 'GET'
    ) {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(oauthProtectedResourceMetadata(auth.oauth)));
      return;
    }
    const lane: McpLane | undefined = path === '/mcp'
      ? 'actor'
      : path === '/mcp/boss'
        ? 'boss'
        : undefined;
    if (!lane) {
      jsonRpcError(response, 404, 'route not found');
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        allow: 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-headers': 'Authorization, Content-Type, Mcp-Session-Id',
      });
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      jsonRpcError(response, 405, 'stateless endpoint accepts POST only');
      return;
    }

    const remoteAddress = request.socket.remoteAddress ?? 'unknown';
    if (!preAuthenticationGate.allow(remoteAddress)) {
      response.setHeader('retry-after', '60');
      jsonRpcError(response, 429, 'authentication rate limit exceeded');
      return;
    }
    const authenticated = await authenticate(request.headers, auth, lane, oauthGate);
    if (!authenticated.ok || !authenticated.principalId) {
      if (authenticated.status === 401 || authenticated.status === 403) {
        response.setHeader(
          'www-authenticate',
          auth.oauth
            ? oauthChallenge(
                auth.oauth,
                lane,
                authenticated.status === 403 ? 'insufficient_scope' : 'invalid_token',
              )
            : 'Bearer',
        );
      } else {
        response.setHeader('retry-after', '1');
      }
      jsonRpcError(response, authenticated.status, authenticated.reason);
      return;
    }
    if (!authenticated.lanes?.includes(lane)) {
      jsonRpcError(response, 403, 'bearer credential is not authorized for this MCP lane');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, limits.maxRequestBytes, limits.requestTimeoutMs);
    } catch (error) {
      const problem = error instanceof HttpProblem ? error : new HttpProblem(400, 'invalid request');
      jsonRpcError(response, problem.status, problem.message);
      return;
    }

    const protocol = createProtocolServer(
      lane,
      authenticated.principalId,
      store,
      policy,
      widgetHtml,
      auth,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const cleanup = (): void => {
      void transport.close();
      void protocol.close();
    };
    response.once('close', cleanup);
    try {
      await protocol.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      jsonRpcError(response, 500, 'MCP request failed at the protected boundary');
      cleanup();
    }
  });

  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = Math.max(5_000, Math.min(60_000, limits.requestTimeoutMs));
  server.keepAliveTimeout = 5_000;
  let closePromise: Promise<void> | undefined;
  const closeHttp = (): Promise<void> => new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(failTimer);
      if (error) rejectClose(error);
      else resolveClose();
    };
    const forceTimer = setTimeout(() => server.closeAllConnections?.(), 2_000);
    const failTimer = setTimeout(
      () => finish(new Error('HTTP shutdown deadline exceeded')),
      2_500,
    );
    server.close((error) => finish(error ?? undefined));
    server.closeIdleConnections?.();
  });
  return {
    server,
    store,
    auth,
    allowedHosts,
    async close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const httpResult = await Promise.allSettled([closeHttp()]);
        const storeResult = await Promise.allSettled([store.closeAll()]);
        const failures = [...httpResult, ...storeResult]
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, 'ARC MCP shutdown failed');
        }
      })();
      return closePromise;
    },
  };
}

export interface StartArcMcpOptions extends ArcMcpServerOptions {
  host?: string;
  port?: number;
}

export async function startArcMcpServer(options: StartArcMcpOptions): Promise<StartedArcMcpServer> {
  const host = options.host ?? '127.0.0.1';
  const auth = validateAuthConfig(options.auth ?? authConfigFromEnvironment());
  if (!isLoopbackHost(host)) {
    throw new Error('ARC MCP must bind loopback; expose it only through an HTTPS tunnel or reverse proxy');
  }
  const runtime = await createArcMcpRuntime({ ...options, auth });
  const port = options.port ?? 8787;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      runtime.server.once('error', rejectListen);
      runtime.server.listen(port, host, () => {
        runtime.server.off('error', rejectListen);
        resolveListen();
      });
    });
  } catch (listenError) {
    runtime.server.removeAllListeners('error');
    const cleanup = await Promise.allSettled([runtime.close()]);
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (cleanupFailure) {
      throw new AggregateError(
        [listenError, cleanupFailure.reason],
        'ARC MCP listen and startup cleanup failed',
      );
    }
    throw listenError;
  }
  const address = runtime.server.address();
  if (!address || typeof address === 'string') {
    await runtime.close();
    throw new Error('MCP server did not expose a TCP address');
  }
  const urlHost = host.includes(':') ? `[${host}]` : host;
  const base = `http://${urlHost}:${address.port}`;
  return {
    server: runtime.server,
    host,
    port: address.port,
    actorUrl: new URL('/mcp', base),
    bossUrl: new URL('/mcp/boss', base),
    close: runtime.close,
  };
}
