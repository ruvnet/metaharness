// SPDX-License-Identifier: MIT

import type { ArcAvoLoopApi } from '@metaharness/arc-agi-3';
import type {
  ArcControllerFactory,
  ArcControllerFactoryContext,
} from './types.js';

/**
 * Package-internal handshake between the MCP store and the official factory.
 *
 * This symbol is deliberately not exported from the package entry point. An
 * official AVO claim must be backed by the ArcAvoLoop instance that the store
 * actually placed in front of the raw controller, not merely by an operator
 * supplied `avo` label on the factory.
 */
export const OFFICIAL_AVO_RUNTIME_HOOKS: unique symbol = Symbol(
  'metaharness.arc-agi-3-chatgpt.official-avo-runtime-hooks',
);

export interface OfficialAvoRuntimeHooks {
  bind(context: ArcControllerFactoryContext, loop: ArcAvoLoopApi): void;
  captureAll(): Promise<void>;
}

type FactoryWithOfficialAvoRuntimeHooks = ArcControllerFactory & {
  readonly [OFFICIAL_AVO_RUNTIME_HOOKS]?: OfficialAvoRuntimeHooks;
};

/** Bind the exact store-owned AVO loop, if this is an official AVO factory. */
export function bindOfficialAvoRuntime(
  factory: ArcControllerFactory,
  context: ArcControllerFactoryContext,
  loop: ArcAvoLoopApi,
): void {
  (factory as FactoryWithOfficialAvoRuntimeHooks)[OFFICIAL_AVO_RUNTIME_HOOKS]
    ?.bind(context, loop);
}

/** Capture final AVO coverage before the store closes its loops/controllers. */
export async function captureOfficialAvoRuntime(
  factory: ArcControllerFactory,
): Promise<void> {
  await (factory as FactoryWithOfficialAvoRuntimeHooks)[OFFICIAL_AVO_RUNTIME_HOOKS]
    ?.captureAll();
}
