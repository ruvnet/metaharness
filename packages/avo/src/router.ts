// SPDX-License-Identifier: MIT

export interface AutonomyRouteInput {
  task: string;
  complexity: number;
  failedAttempts: number;
  estimatedValue: number;
  evaluatorReliability: number;
}

export interface AutonomyRoute {
  mode: 'darwin-fast' | 'avo';
  reason: string;
  score: number;
}

export interface AutonomyRoutePolicy {
  route(input: AutonomyRouteInput): AutonomyRoute;
}

export interface GovernedAutonomyRouterOptions {
  threshold?: number;
  minimumEvaluatorReliability?: number;
}

/**
 * Pure task-mode gate. Model selection remains owned by @metaharness/router;
 * this gate decides whether the selected model gets a one-shot Darwin path or
 * the more expensive autonomous variation runtime.
 */
export class GovernedAutonomyRouter implements AutonomyRoutePolicy {
  private readonly threshold: number;
  private readonly minimumEvaluatorReliability: number;
  constructor(options: GovernedAutonomyRouterOptions = {}) {
    this.threshold = options.threshold ?? 0.65;
    this.minimumEvaluatorReliability = options.minimumEvaluatorReliability ?? 0.8;
  }
  route(input: AutonomyRouteInput): AutonomyRoute {
    if (input.evaluatorReliability < this.minimumEvaluatorReliability) {
      return { mode: 'darwin-fast', reason: 'evaluator reliability is below the autonomy floor', score: 0 };
    }
    const score = Math.max(0, Math.min(1,
      input.complexity * 0.5
      + Math.min(input.failedAttempts, 3) / 3 * 0.3
      + input.estimatedValue * 0.2,
    ));
    return score >= this.threshold
      ? { mode: 'avo', reason: 'complexity/failure/value score clears the autonomous threshold', score }
      : { mode: 'darwin-fast', reason: 'simple work stays on the low-overhead path', score };
  }
}
