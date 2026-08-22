#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArcControllerFactory, AuthConfig, OAuthResourceConfig } from './types.js';
import { authConfigFromEnvironment } from './auth.js';
import { startArcMcpServer } from './server.js';

async function loadFactory(specifier: string | undefined): Promise<ArcControllerFactory> {
  if (!specifier) {
    throw new Error('ARC_CONTROLLER_FACTORY_MODULE is required; it must export controllerFactory or a default ArcControllerFactory');
  }
  const resolved = specifier.startsWith('.') || specifier.startsWith('/')
    ? pathToFileURL(resolve(specifier)).href
    : specifier;
  const module = await import(resolved) as {
    controllerFactory?: ArcControllerFactory;
    default?: ArcControllerFactory;
  };
  const factory = module.controllerFactory ?? module.default;
  if (typeof factory !== 'function') {
    throw new Error('controller factory module has no controllerFactory/default function');
  }
  return factory;
}

async function loadAuth(specifier: string | undefined): Promise<AuthConfig> {
  if (!specifier) return authConfigFromEnvironment();
  const resolved = specifier.startsWith('.') || specifier.startsWith('/')
    ? pathToFileURL(resolve(specifier)).href
    : specifier;
  const module = await import(resolved) as {
    oauth?: OAuthResourceConfig;
    default?: OAuthResourceConfig;
  };
  const oauth = module.oauth ?? module.default;
  if (!oauth || typeof oauth.verifyAccessToken !== 'function') {
    throw new Error('OAuth module must export oauth/default with verifyAccessToken');
  }
  return { oauth };
}

async function main(): Promise<void> {
  const controllerFactory = await loadFactory(process.env.ARC_CONTROLLER_FACTORY_MODULE);
  const auth = await loadAuth(process.env.ARC_MCP_OAUTH_MODULE);
  const host = process.env.ARC_MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.ARC_MCP_PORT ?? '8787');
  const stateRoot = process.env.ARC_MCP_STATE_ROOT;
  if (!stateRoot) throw new Error('ARC_MCP_STATE_ROOT is required for durable checkpoints and directives');
  const allowedHosts = process.env.ARC_MCP_ALLOWED_HOSTS
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const started = await startArcMcpServer({
    controllerFactory,
    host,
    port,
    stateRoot,
    auth,
    allowedHosts,
  });
  process.stderr.write(`ARC ChatGPT MCP actor: ${started.actorUrl.toString()}\n`);
  process.stderr.write(`ARC ChatGPT MCP boss:  ${started.bossUrl.toString()}\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await started.close();
  };
  const onSignal = (): void => {
    void stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup failure';
  process.stderr.write(`ARC ChatGPT MCP failed to start: ${message}\n`);
  process.exitCode = 1;
});
