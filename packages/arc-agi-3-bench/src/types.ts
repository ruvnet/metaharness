import type {
  ArcAction,
  ArcAvoContext,
  ArcAvoConfigInput,
  ArcRunManifest,
  ExactArcObservation,
  FrontierEdge,
  MemoryQueryResult,
  SupervisorCaseBundle,
  SupervisorDirectiveCommit,
} from '@metaharness/arc-agi-3';

export const BENCHMARK_ARMS = ['direct', 'direct-reflection', 'avo'] as const;
export type BenchmarkArm = (typeof BENCHMARK_ARMS)[number];

export interface MechanismTask {
  readonly id: string;
  readonly availableActions: readonly ArcAction['name'][];
  readonly goalAction: ArcAction['name'];
  readonly frameSalt: number;
  /** Efficient reference length used only by the synthetic fixture score. */
  readonly referenceActions: number;
}

export interface MechanismFixtureSuite {
  readonly schema: 'metaharness.arc_agi_3.mechanism_fixture.v1';
  readonly suiteId: string;
  readonly description: string;
  readonly actionLatencyMs: number;
  readonly tasks: readonly MechanismTask[];
}

export interface BenchmarkBudgets {
  readonly maxActions: number;
  readonly maxModelTurns: number;
  readonly maxWallTimeMs: number;
}

export interface FrozenModelConfig {
  readonly driver: 'scripted-v1' | 'file-broker-v1';
  readonly visibleModelLabel: string;
  readonly modelId: string;
  readonly modelSeed: number | null;
  readonly temperature: number | null;
  readonly reasoningEffort: string | null;
  readonly operatorDeclaredIdentity: boolean;
}

export interface FrozenStatisticsConfig {
  readonly bootstrapResamples: number;
  readonly permutationResamples: number;
  readonly confidenceLevel: number;
  readonly randomSeed: number;
  readonly clusterUnit: 'fixture-task';
  readonly alternative: 'avo-greater';
}

export interface FrozenAcceptanceConfig {
  readonly primaryComparison: 'avo-vs-direct-reflection';
  readonly minimumMeanScoreDelta: number;
  readonly requireConfidenceLowerBoundAboveZero: boolean;
  readonly maximumPermutationPValue: number;
  readonly requireAllReceiptChainsValid: boolean;
}

export interface FrozenBenchmarkManifestBody {
  readonly schema: 'metaharness.arc_agi_3.benchmark_manifest.v1';
  readonly benchmarkId: string;
  readonly benchmarkKind: 'offline-deterministic-mechanism';
  readonly officialArcScore: false;
  readonly claimEligible: false;
  readonly claimBoundary: string;
  readonly fixtureSuiteId: string;
  readonly fixtureSuiteHash: string;
  readonly arms: readonly BenchmarkArm[];
  readonly armOrderSeed: number;
  readonly episodeSeeds: readonly number[];
  readonly budgets: BenchmarkBudgets;
  readonly controller: {
    readonly version: string;
    readonly supervisorThresholds: {
      readonly repeatedEdgeCount: number;
      readonly noEffectCount: number;
      readonly noEffectWindow: number;
      readonly predictionErrorMean: number;
      readonly predictionErrorWindow: number;
      readonly stagnationWindow: number;
      readonly cycleWithinComponentCount: number;
      readonly coordinateProbeCount: number;
    };
  };
  readonly model: FrozenModelConfig;
  readonly prompts: {
    readonly directHash: string;
    readonly reflectionHash: string;
    readonly avoHash: string;
    readonly supervisorHash: string;
  };
  readonly toolSchemaHash: string;
  readonly environmentAdapterVersion: string;
  readonly statistics: FrozenStatisticsConfig;
  readonly acceptance: FrozenAcceptanceConfig;
}

export interface FrozenBenchmarkManifest extends FrozenBenchmarkManifestBody {
  readonly manifestHash: string;
}

export interface DriverUsage {
  readonly inputUnits?: number;
  readonly outputUnits?: number;
  readonly reasoningUnits?: number;
}

export type ModelTurnKind = 'PLAN' | 'REFLECT' | 'SUPERVISE';

export interface ModelTurnRequest {
  readonly schema: 'metaharness.arc_agi_3.model_turn.v1';
  readonly requestId: string;
  readonly kind: ModelTurnKind;
  readonly arm: BenchmarkArm;
  /** Model-visible opaque handle; never a fixture id or game id. */
  readonly opaqueTaskHandle: string;
  readonly episodeSeed: number;
  readonly turnIndex: number;
  readonly observation?: ExactArcObservation;
  readonly availableActions?: readonly ArcAction['name'][];
  readonly frontier?: readonly FrontierEdge[];
  readonly memory?: MemoryQueryResult;
  readonly reflection?: string;
  readonly supervisorCase?: SupervisorCaseBundle;
  readonly purpose: string;
}

export interface CandidateAction {
  readonly action: ArcAction;
  readonly hypothesis: string;
  readonly confidence: number;
}

export interface ModelTurnResponse {
  readonly schema: 'metaharness.arc_agi_3.model_turn_response.v1';
  readonly requestId: string;
  readonly candidateActions?: readonly CandidateAction[];
  readonly reflection?: string;
  readonly supervisorDirective?: SupervisorDirectiveCommit;
  /** Deterministic fixture latency or operator/provider reported latency. */
  readonly latencyMs?: number;
  readonly usage?: DriverUsage;
}

export interface ModelDriver {
  readonly id: string;
  readonly latencySource: 'fixture-simulated' | 'wall-clock' | 'provider-reported';
  turn(request: Readonly<ModelTurnRequest>): Promise<ModelTurnResponse>;
}

export interface MeteredModelSummary {
  readonly turnCount: number;
  readonly failedTurnCount: number;
  readonly planTurns: number;
  readonly reflectionTurns: number;
  readonly supervisorTurns: number;
  readonly latencyMs: number;
  readonly latencySource: ModelDriver['latencySource'];
  readonly usage: Required<DriverUsage>;
  readonly totalUsageUnits: number;
  readonly usageComplete: boolean;
}

export interface EpisodeIdentity {
  readonly pairId: string;
  readonly clusterId: string;
  readonly taskId: string;
  readonly episodeSeed: number;
  readonly arm: BenchmarkArm;
  readonly randomizedOrder: number;
}

/** Redacted identity safe to expose to a provider/model driver factory. */
export interface DriverEpisodeIdentity {
  readonly pairHandle: string;
  readonly clusterHandle: string;
  readonly episodeSeed: number;
  readonly arm: BenchmarkArm;
  readonly randomizedOrder: number;
}

export interface EpisodeMetrics extends EpisodeIdentity {
  readonly initialObservationFingerprint: string;
  readonly finalState: ExactArcObservation['state'];
  readonly levelsCompleted: number;
  readonly winLevels: number;
  readonly score: number;
  readonly actionCount: number;
  readonly resetCount: number;
  readonly controllerEpisodeCount: number;
  readonly model: MeteredModelSummary;
  readonly simulatedLatencyMs: number;
  readonly elapsedWallMs: number;
  readonly receiptVerification: {
    readonly ok: boolean;
    readonly count: number;
    readonly headHash?: string;
    readonly reason?: string;
  };
  readonly openSupervisorCaseAtEnd: boolean;
  readonly ruleCount: number;
  readonly stoppedReason: 'TERMINAL' | 'ACTION_BUDGET' | 'MODEL_TURN_BUDGET' | 'ERROR';
  readonly error?: string;
}

export interface MetricSummary {
  readonly nPairs: number;
  readonly nClusters: number;
  readonly meanDelta: number;
  readonly confidenceInterval: readonly [number, number];
  readonly signFlipPValue: number;
}

export interface ArmAggregate {
  readonly episodes: number;
  readonly meanScore: number;
  readonly winRate: number;
  readonly meanActions: number;
  readonly meanModelTurns: number;
  readonly meanTotalUsageUnits: number;
  readonly meanSimulatedLatencyMs: number;
  readonly allReceiptsValid: boolean;
}

export interface ComparisonReport {
  readonly challenger: BenchmarkArm;
  readonly baseline: BenchmarkArm;
  readonly score: MetricSummary;
  readonly actions: MetricSummary;
  readonly modelTurns: MetricSummary;
  readonly simulatedLatencyMs: MetricSummary;
}

export interface BenchmarkReport {
  readonly schema: 'metaharness.arc_agi_3.benchmark_report.v1';
  readonly generatedAt: string;
  readonly manifest: FrozenBenchmarkManifest;
  readonly fixtureSuiteHash: string;
  readonly randomizedOrders: readonly {
    readonly pairId: string;
    readonly order: readonly BenchmarkArm[];
  }[];
  readonly episodes: readonly EpisodeMetrics[];
  readonly aggregates: Readonly<Record<BenchmarkArm, ArmAggregate>>;
  readonly comparisons: {
    readonly avoVsDirect: ComparisonReport;
    readonly avoVsDirectReflection: ComparisonReport;
  };
  readonly acceptance: {
    readonly passed: boolean;
    readonly checks: Readonly<Record<string, boolean>>;
  };
  readonly limitations: readonly string[];
  /** Excludes generatedAt and observed wall-clock diagnostics. */
  readonly deterministicEvidenceHash: string;
  readonly reportHash: string;
}

export interface EpisodeRunContext {
  readonly identity: DriverEpisodeIdentity;
  readonly manifest: FrozenBenchmarkManifest;
  readonly coreRunManifest: ArcRunManifest;
  readonly avoConfig: ArcAvoConfigInput;
}

export type DriverFactory = (context: Readonly<EpisodeRunContext>) => ModelDriver;

export interface PlannerEpisodeState {
  readonly arm: BenchmarkArm;
  readonly taskId: string;
  readonly episodeSeed: number;
  readonly maxModelTurns: number;
  readonly lastReflection?: string;
  readonly context?: ArcAvoContext;
}
