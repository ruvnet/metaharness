/** Trusted adapters execute effects; the core never evaluates component content. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Scope = 'invariant' | 'domain';
export interface Component {
  readonly id: string;
  readonly scope: Scope;
  readonly content: JsonValue;
  readonly requires?: readonly string[];
  readonly trigger?: 'always' | 'dependency';
}
export interface HarnessDocument { readonly components: readonly Component[] }
export interface ExperienceLibrary {
  readonly tenantId: string;
  readonly projectId: string;
  readonly entries: readonly JsonValue[];
}
export interface Observation {
  readonly id: string;
  readonly componentId: string;
  readonly message: string;
}
export interface Edit {
  readonly componentId: string;
  readonly content: JsonValue;
  readonly citations: readonly string[];
}
export interface Budget {
  /** Budget amounts use exact nanodollar precision within safe integer units. */
  readonly maxUsd: number;
  readonly maxCalls: number;
  readonly timeoutMs: number;
  readonly probeUsd: number;
  readonly proposeUsd: number;
  readonly composeUsd: number;
}
export interface Context {
  readonly tenantId: string;
  readonly projectId: string;
  readonly task: JsonValue;
  readonly environment: JsonValue;
  readonly library: ExperienceLibrary;
  /** Immutable caller-owned capabilities, never a mutation surface. */
  readonly envelope: JsonValue;
}
export interface CallContext extends Context {
  readonly signal: AbortSignal;
  /** Adapter must enforce this ceiling at its effect boundary. */
  readonly ceilingUsd: number;
}
export interface ProbeInput extends CallContext {
  readonly candidate: HarnessDocument;
  readonly candidateDigest: string;
}
export interface ProbeOutput {
  readonly appliedDigest: string;
  /** Development evidence only; never a promotion verdict. */
  readonly score: number;
  readonly observations: readonly Observation[];
  readonly costUsd: number;
}
export interface ProposalInput extends CallContext {
  readonly baseline: HarnessDocument;
  readonly candidateDigest: string;
  readonly scope: Scope;
  readonly observations: readonly Observation[];
}
export interface CompositionInput extends CallContext {
  readonly baseline: HarnessDocument;
  readonly candidateDigest: string;
  readonly supportedEdits: readonly Edit[];
  readonly observations: readonly Observation[];
}
export interface ProposalOutput { readonly edits: readonly Edit[]; readonly costUsd: number }
export interface ContrastiveOptions extends Context {
  readonly baseline: HarnessDocument;
  readonly budget: Budget;
  readonly evaluator: {
    readonly surfaceAware: true;
    probe(input: ProbeInput): Promise<ProbeOutput>;
  };
  readonly proposer: { propose(input: ProposalInput): Promise<ProposalOutput> };
  readonly composer?: { compose(input: CompositionInput): Promise<ProposalOutput> };
}
export type ReceiptKind = 'baseline' | 'propose:invariant' | 'propose:domain' | 'probe:invariant' | 'probe:domain' | 'compose' | 'probe:composition';
export interface Receipt {
  readonly sequence: number;
  readonly kind: ReceiptKind;
  readonly status: 'success' | 'failure' | 'invalid' | 'timeout' | 'budget' | 'deduplicated';
  readonly candidateDigest?: string;
  readonly reservedUsd: number;
  /** Actual adapter report, or the conservative ceiling when no valid report exists. */
  readonly reportedUsd: number;
  readonly cumulativeReservedUsd: number;
  readonly cumulativeReportedUsd: number;
  readonly durationMs: number;
  readonly reason?: string;
}
export interface ContrastiveResult {
  readonly outcome: 'baseline' | 'candidate';
  readonly reason: string;
  readonly candidate: HarnessDocument;
  readonly candidateDigest: string;
  readonly baselineDigest: string;
  readonly baselineScore: number | null;
  readonly selectedScore: number | null;
  readonly receipts: readonly Receipt[];
  readonly calls: number;
  readonly deduplicated: number;
  readonly reservedUsd: number;
  readonly reportedUsd: number;
  /** Explicitly no capability to promote or persist production state. */
  readonly promotion: 'not-authorized';
}
