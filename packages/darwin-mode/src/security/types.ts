// SPDX-License-Identifier: MIT
//
// Darwin Shield — shared types (ADR-155). The integration contract for the
// defensive vulnerability-discovery harness. Every module codes against these.
//
//   model_frozen = true ; harness_evolves = true ; unsafe_output = rejected
//
// The thesis (ADR-077/155): the foundation model is frozen; only the HARNESS
// evolves — planner, retrieval policy, reviewer count, retry budget, toolset,
// model mix, fuzz budget. Findings are validated by tests/fuzzers, stored in
// ruVector memory so the system compounds, and every output passes a hard
// safety gate before it leaves the sandbox.

/** A harness variant — the unit Darwin Shield evolves (ADR-155 §genome). */
export interface HarnessGenome {
  id: string;
  parentId?: string;
  /** Order in which the harness explores the repo. */
  planner:
    | 'file-first'
    | 'sink-first'
    | 'diff-first'
    | 'callgraph-first'
    | 'risk-first'
    | 'memory-first';
  /** How much / what kind of context the agents retrieve. */
  contextPolicy: 'minimal' | 'semantic' | 'callgraph' | 'hybrid';
  /** Independent adversarial reviewers (falsification). Clamp 1..5. */
  reviewerCount: number;
  /** Validation retries before giving up on a candidate. Clamp 1..6. */
  retryBudget: number;
  /** Seconds of fuzzing budget per candidate. Clamp 10..600. */
  fuzzBudgetSeconds: number;
  /** Enabled static/dynamic tools (subset of the allowlist). */
  tools: SecurityTool[];
  /** Model identifiers used (frozen; only the mix is a knob). */
  modelMix: string[];
  /** Ordered validation pipeline stages. */
  validationPipeline: string[];
  /** Never mutated — the strict-defensive invariant. */
  safetyProfile: 'strict-defensive';
}

/** The allowlisted security tools a genome may enable (ADR-155 §tools). */
export type SecurityTool =
  | 'semgrep'
  | 'codeql'
  | 'cargo-audit'
  | 'npm-audit'
  | 'osv-scanner'
  | 'trivy'
  | 'cargo-fuzz';

export type Language = 'rust' | 'ts' | 'py' | 'go';

/** A confirmed-or-candidate weakness. `exploitCodeAllowed` is hard `false`. */
export interface Finding {
  id: string;
  repo: string;
  commit: string;
  file: string;
  symbol?: string;
  weakness: string;
  /** 0..1 confidence after review. */
  confidence: number;
  evidence: string[];
  patch?: string;
  test?: string;
  verdict: 'confirmed' | 'false_positive' | 'needs_review';
  /** HARD INVARIANT — never true. The type pins it to the literal `false`. */
  exploitCodeAllowed: false;
}

/** ruVector metadata schema for a stored code/finding vector (ADR-155 §memory). */
export interface SecurityVectorMeta {
  repo: string;
  commit: string;
  language: Language;
  path: string;
  symbol?: string;
  chunkType: 'function' | 'class' | 'module' | 'test' | 'config';
  riskTags: string[];
  callgraphDegree?: number;
  taintRole?: 'source' | 'sink' | 'sanitizer' | 'unknown';
  findingId?: string;
  genomeId?: string;
  benchmarkId?: string;
  verdict?: 'confirmed' | 'false_positive' | 'needs_review';
}

/** A scope/authorization assertion for a scan target (ADR-155 §safety). */
export interface ScopeAssertion {
  repo: string;
  scope: 'owned' | 'authorized';
  /** Caller-supplied proof of authorization (e.g. an attestation id). */
  authorization?: string;
}

/** The repository intelligence the profiler produces. */
export interface RepoProfile {
  repo: string;
  commit: string;
  languages: Language[];
  frameworks: string[];
  /** Number of source units (functions/modules) discovered. */
  unitCount: number;
  /** Risk-ranked attack-surface summary. */
  attackSurface: string[];
  summary: string;
}

/** The context bundle the builder assembles for the security agents. */
export interface SecurityContext {
  riskyFiles: RankedSite[];
  similarFindings: Finding[];
  knownFalsePositives: Finding[];
  acceptedPatches: PatchExample[];
  successfulGenomes: HarnessGenome[];
}

export interface PatchExample {
  weakness: string;
  patch: string;
  test: string;
}

/** A code site ranked by the file-ranker / hybrid retriever. */
export interface RankedSite {
  siteId: string;
  file: string;
  symbol?: string;
  rank: number;
}

/** An auditable, replayable record of one swarm run (a "receipt"). */
export interface BenchmarkReceipt {
  taskId: string;
  genomeId: string;
  repo: string;
  commit: string;
  seed: number;
  findings: Finding[];
  /** Metrics computed for this single run. */
  metrics: RunMetrics;
  /** Hash of the inputs, for tamper-evident replay. */
  inputHash: string;
  createdAt: string;
}

/** Per-run measurements that fold into the fitness function. */
export interface RunMetrics {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Confirmed sites that reproduced under a test/fuzzer. */
  reproduced: number;
  /** Patches that passed their generated test. */
  patchesPassing: number;
  patchesProposed: number;
  /** Findings whose static tools agreed (≥2 tools). */
  toolAgreements: number;
  /** Findings unseen in prior memory (novelty). */
  novelFindings: number;
  /** Unsafe outputs that reached scoring (MUST be 0). */
  unsafeOutputs: number;
  /** Wall-clock proxy in arbitrary units (deterministic). */
  costUnits: number;
  /** Time-to-first-finding proxy. */
  timeToFinding: number;
}

/** A scan target: a corpus repo plus its authorization. */
export interface ScanTask {
  taskId: string;
  scope: ScopeAssertion;
  policy: 'strict-defensive';
}
