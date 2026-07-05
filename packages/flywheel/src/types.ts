// @metaharness/flywheel — the abstract API surface.
//
// DESIGN RULE (load-bearing): this package must NOT know about any host, model, or benchmark — no
// Claude Code, no SWE-bench, no GLM/Sonnet/Fable, no code-repair. It knows only CANDIDATES, SCORES,
// GATES, RECEIPTS, and PROMOTION LINEAGE. Everything host- or benchmark-specific enters through the
// injected `Proposer` / `Evaluator` (and, if you like, a custom `PromotionRule`). If you find yourself
// wanting a benchmark-specific branch in here, it belongs in the caller, not the flywheel.

/** A policy is an opaque bag of named string levers — the thing being evolved. The flywheel never
 *  interprets a lever's meaning; the caller's Evaluator does. */
export type Policy = Record<string, string>;

/** A versioned policy node in the evolution graph. `parents` is a DAG (usually one parent = the winner
 *  it re-based on); the gen-0 root has `parents: []` and never changes. */
export interface PolicyGenome {
  id: string;
  generation: number;
  parents: string[];
  policy: Policy;
}

/** One mutation attempt: which lever was changed, and a short human summary of how. */
export interface CandidateMutation {
  target: string;
  summary: string;
}

/** The abstract quality of a policy on a suite. All host/benchmark meaning is projected onto these four
 *  axes by the Evaluator. Higher `primary` is better; lower `noopRate`/`costPerWin` is better;
 *  `regressed` is a hard safety/security stop. (Named generically on purpose — "primary" not "gold".) */
export interface Score {
  /** The main quality signal (wins / accuracy / resolved) — higher is better. */
  primary: number;
  /** Fraction of non-committal / empty / no-op outputs — lower is better (the "never end empty" signal). */
  noopRate: number;
  /** Resource cost per successful outcome — lower is better. */
  costPerWin: number;
  /** A hard safety/security regression flag — any `true` blocks promotion outright. */
  regressed: boolean;
}

/** What a promotion gate decides over. `anchor` (optional) is the FROZEN, never-optimized-against suite
 *  score — the anti-Goodhart check. */
export interface PromotionEvidence {
  baseline: Score;
  candidate: Score;
  anchor?: { baseline: number; candidate: number };
}

export interface PromotionDecision {
  promote: boolean;
  reasons: string[];
}

/** THE GATE. Pure, deterministic, and — for a given deployment — FROZEN ("the gate is the product").
 *  Injectable so enterprises can supply their own; {@link meetsPromotionRule} is the default. */
export type PromotionRule = (evidence: PromotionEvidence) => PromotionDecision;

/** An opaque evaluation suite — the flywheel treats `items` as a black box. HoldoutSuite is optimized
 *  against; AnchorSuite is NOT (it is the frozen no-regression guard). Same shape; different role. */
export interface Suite {
  id: string;
  items: unknown[];
}
export type HoldoutSuite = Suite;
export type AnchorSuite = Suite;

/** Proposes an improved value for ONE policy lever. The ONLY seam where a model/host enters propose. */
export type Proposer = (base: PolicyGenome, target: string) => Promise<string>;

/** Scores a policy on a suite. The ONLY seam where a host/benchmark enters evaluate. Everything
 *  Claude-Code-, SWE-bench-, or trading-specific lives HERE, in the caller — never in the flywheel. */
export type Evaluator = (policy: Policy, suite: Suite) => Promise<Score>;

/* ── receipts (trust the signature, not the producer) ───────────────────────── */

export interface PromotionReceipt {
  payload: Record<string, unknown>;
  signature: string; // base64 signature over canon(payload)
  publicKey: string; // base64 SPKI DER
  alg: 'ed25519';
}

/** Signs a receipt + publishes its public key. Injectable (per-process, secret-backed, HSM, …). */
export interface Signer {
  sign(payload: Record<string, unknown>): PromotionReceipt;
  publicKey(): string;
}

/* ── lineage (git for operating policies) ───────────────────────────────────── */

export interface LineageCommit {
  id: string;
  generation: number;
  parents: string[];
  mutation: CandidateMutation | null;
  /** baseline→candidate deltas on each axis (for the knowledge base / regression ancestry). */
  primaryDelta: number;
  anchorScore: number | null;
  verdict: 'ROOT' | 'PROMOTED' | 'REJECTED';
  failureReasons: string[];
  receipt: PromotionReceipt;
  createdAt: string;
}

export interface LineageStore {
  append(commit: LineageCommit): Promise<void>;
  get(id: string): Promise<LineageCommit | null>;
  /** Walk parents from `id` to the immutable gen-0 root (current → root). */
  walkToRoot(id: string): Promise<LineageCommit[]>;
  list(): Promise<LineageCommit[]>;
}

/* ── the observable proof ───────────────────────────────────────────────────── */

/** One point per promoted generation — the compounding curve. */
export interface LiftPoint {
  generation: number;
  primary: number;
  delta: number;
  anchor: number | null;
}
export type LiftCurve = LiftPoint[];

/** Everything an EXTERNAL reviewer needs to replay the run with no trust in the producer. */
export interface ReplayBundle {
  data_source: string; // caller-stamped ('SYNTHETIC' | 'LIVE' | …). Never a benchmark name.
  root_id: string;
  /** current → gen-0 root (the promoted chain). */
  chain: LineageCommit[];
  /** every candidate commit across all generations (promoted + rejected) — the full diagnostic ledger. */
  all_commits: LineageCommit[];
  lift_curve: LiftCurve;
  /** sha256 of the PromotionRule source, when the caller supplies it — proves the gate was UNCHANGED. */
  gate_fingerprint: string | null;
  verified_improvements: number;
  anchor_surviving_improvements: number;
  milestone_reached: boolean;
  created_at: string;
}
