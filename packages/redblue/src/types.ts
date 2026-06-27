// SPDX-License-Identifier: MIT
//
// MetaHarness Adversarial Operators (Red/Blue Team Harness) — shared types.
//
// SAFETY BOUNDARY (enforced in code, see config/safety.ts):
//   Red actors are uncontrolled in BEHAVIOR, not CAPABILITY. No real
//   credentials, no live external targets, no production data, no arbitrary
//   network, no shell, no code execution outside a sandbox, no persistence
//   outside run logs. We store SAFE attack-family LABELS (taxonomy), never
//   exploit instructions. This is a defensive tool for testing one's OWN
//   systems.

/** OWASP LLM Top-10 categories we operationalize (safe labels only). */
export type OwaspLlmCategory =
  | 'LLM01_prompt_injection'
  | 'LLM02_insecure_output_handling'
  | 'LLM06_sensitive_information_disclosure'
  | 'LLM07_insecure_plugin_design'
  | 'LLM08_excessive_agency'
  | 'LLM05_supply_chain';

/** NIST AI RMF functions our tests map to. */
export type NistRmfFunction = 'GOVERN' | 'MAP' | 'MEASURE' | 'MANAGE';

/** The five attack families in the MVP. These are taxonomy LABELS. */
export type AttackFamily =
  | 'direct_prompt_injection'
  | 'tool_overreach'
  | 'data_exfiltration_attempt'
  | 'role_confusion'
  | 'cost_amplification';

/** Red and blue actor roles. */
export type RedActorRole = 'malicious_user' | 'insider_operator' | 'prompt_injector';
export type BlueActorRole = 'policy_architect' | 'prompt_hardener';
export type ActorRole = RedActorRole | BlueActorRole | 'judge';

/** Severity bands per the spec. */
export type SeverityBand = 'Info' | 'Low' | 'Med' | 'High' | 'Critical';

/**
 * A generated adversarial test case. The generator describes the adversarial
 * OBJECTIVE and the safe behavior we expect — never a copy-paste exploit.
 */
export interface TestCase {
  id: string;
  family: AttackFamily;
  actor: RedActorRole;
  /** Plain-language description of the adversarial GOAL (not an exploit). */
  objective: string;
  /** The benign-looking probe sent to the target. Safe, no live payloads. */
  input: string;
  /** What a correctly-behaving target should do (refuse, sanitize, scope). */
  expectedSafeBehavior: string;
  /** Outcomes that, if observed, count as a compromise. */
  forbiddenOutcomes: string[];
  /** OWASP/NIST mapping for the report. */
  owasp: OwaspLlmCategory;
  nist: NistRmfFunction;
}

/** Telemetry captured from a single target invocation. */
export interface TargetTelemetry {
  /** Raw (possibly redacted) response text from the target. */
  output: string;
  /** Tool/function calls the target attempted, if observable. */
  toolCalls: string[];
  latencyMs: number;
  /** HTTP status when the target is an http endpoint. */
  status?: number;
}

/** Result of running one TestCase against the target. */
export interface TestResult {
  testId: string;
  family: AttackFamily;
  passed: boolean;
  /** True if the target did something forbidden. */
  compromised: boolean;
  /** Redacted, safe-to-store evidence strings. */
  evidence: string[];
  severity: SeverityBand;
  severityScore: number;
  toolAbuse: boolean;
  dataLeakage: boolean;
  policyViolation: boolean;
  costUsd: number;
  latencyMs: number;
  /** Judge's recommended fix (blue team consumes this). */
  recommendedFix?: string;
}

/** The judge's strict-JSON verdict. */
export interface JudgeVerdict {
  compromised: boolean;
  severity: SeverityBand;
  evidence: string[];
  policy_violation: boolean;
  recommended_fix: string;
}

/** Sub-dimensions scored 0..1 for severity. */
export interface SeverityInputs {
  impact: number;
  exploitability: number;
  repeatability: number;
  dataSensitivity: number;
  autonomyLevel: number;
  detectionGap: number;
}

/** A patch proposed by a blue actor. */
export interface Patch {
  id: string;
  /** Which test/finding it addresses. */
  forTestId: string;
  family: AttackFamily;
  blueActor: BlueActorRole;
  /** Human-readable description of the mitigation. */
  description: string;
  /**
   * A guard predicate applied to the target's input/output in the patched
   * run. Returns true if the request/response should be BLOCKED. The harness
   * applies these guards — it never executes model-authored code.
   */
  kind: 'input_filter' | 'output_filter' | 'policy_prompt' | 'tool_scope';
  /** Serializable rule the harness interprets (safe — no eval). */
  rule: PatchRule;
}

/** A declarative, harness-interpreted guard rule (no code execution). */
export interface PatchRule {
  /** Substrings that, if present in input or output, trigger a block. */
  blockSubstrings?: string[];
  /** Tool names the target is allowed to call (allow-list). */
  allowedTools?: string[];
  /** Max tokens/iterations the target may consume (cost amplification guard). */
  maxIterations?: number;
  /** A system-prompt prefix to harden role confusion / injection. */
  hardeningPrefix?: string;
}

/** The target under test. */
export interface TargetConfig {
  kind: 'http' | 'none';
  url?: string;
  /** Header names allowed (values never include real credentials). */
  headers?: Record<string, string>;
  /** Path to extract the target's text from a JSON response, e.g. "choices.0.text". */
  responsePath?: string;
}

/** OpenRouter model candidates by role. */
export interface ModelConfig {
  red: string[];
  blue: string[];
  judge: string[];
  /** Cheap model used to mutate/vary scenarios. */
  mutate?: string[];
}

/** Hard safety + budget limits. Enforced at config load time. */
export interface Limits {
  max_tests: number;
  max_cost_usd: number;
  max_runtime_minutes: number;
  allow_network: boolean;
  allow_shell: boolean;
  allow_real_credentials: boolean;
}

export interface RiskPolicy {
  block_critical: boolean;
  require_evidence: boolean;
  redact_sensitive_outputs: boolean;
  save_transcripts: boolean;
}

export interface Gates {
  max_policy_violation_rate: number;
  max_data_leakage_rate: number;
  max_tool_abuse_rate: number;
  min_patch_reduction_rate: number;
}

/** The full engagement config (loaded from YAML). */
export interface RedBlueConfig {
  target: TargetConfig;
  models: ModelConfig;
  limits: Limits;
  risk_policy: RiskPolicy;
  gates: Gates;
  /** Which attack families to run; default = all five. */
  families?: AttackFamily[];
}

/** Aggregate rates across a run. */
export interface RunRates {
  compromise: number;
  tool_abuse: number;
  data_leakage: number;
  prompt_injection_success: number;
  recovery: number;
}

/** The JSON report shape. */
export interface RunReport {
  run_id: string;
  summary: {
    tests_run: number;
    failures_found: number;
    critical: number;
    high: number;
    med: number;
    low: number;
    info: number;
    cost_usd: number;
    cost_per_failure: number;
  };
  rates: RunRates;
  /** baseline -> patched failure reduction, 0..1. */
  patch_reduction_rate?: number;
  should_block_production: boolean;
  gates_passed: boolean;
  recommendations: string[];
  /** Per-test compact breakdown (so per-family judge decisions are auditable). */
  findings: Array<{
    testId: string;
    family: AttackFamily;
    compromised: boolean;
    severity: SeverityBand;
    toolAbuse: boolean;
    dataLeakage: boolean;
    policyViolation: boolean;
  }>;
}

/** The target invocation interface (http or in-proc mock both satisfy it). */
export interface TargetDriver {
  invoke(input: string): Promise<TargetTelemetry>;
}

/** Model client interface — mockable in tests ($0). */
export interface ModelClient {
  complete(req: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; costUsd: number; promptTokens: number; completionTokens: number }>;
}
