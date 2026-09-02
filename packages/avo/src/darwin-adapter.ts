// SPDX-License-Identifier: MIT

import type { VariationOperator } from './operator.js';
import type { VariationResult } from './types.js';

/** Structural mirror of Darwin's adapter context; no hard Darwin dependency. */
export interface DarwinVariationRequest {
  parent: unknown;
  profile: unknown;
  workRoot: string;
  generation: number;
  index: number;
  seed: number;
  parentScore: number;
  failedTraces: string[];
  allowedSurfaces: readonly string[];
}

export type VariationOperatorFactory = (context: DarwinVariationRequest) => Promise<VariationOperator> | VariationOperator;
export type DarwinCandidateMaterializer<T> = (
  result: VariationResult,
  context: DarwinVariationRequest,
) => Promise<T>;

/**
 * Versioned host adapter for EvolutionConfig.variationOperator. The factory
 * binds one governed AVO runtime to the selected Darwin parent; the materializer
 * converts its verified committed workspace into Darwin's HarnessVariant shape.
 */
export class DarwinVariationAdapter<T = unknown> {
  constructor(
    readonly version: string,
    private readonly factory: VariationOperatorFactory,
    private readonly materialize: DarwinCandidateMaterializer<T>,
  ) {}

  async run(context: DarwinVariationRequest): Promise<T> {
    const operator = await this.factory(context);
    const result = await operator.run();
    if (!result.winner || result.failureReport) {
      throw new Error(result.failureReport ?? 'avo: no verified candidate available for Darwin');
    }
    return this.materialize(result, context);
  }
}
