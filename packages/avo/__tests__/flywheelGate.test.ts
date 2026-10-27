// ADR-271 — the AVO → meta-llm flywheel-gate serializer. These tests pin the harness side of the
// cross-repo contract: every receipt this producer emits must verify the exact way the gateway's
// `receiptValid` does (Ed25519 over `canon(payload)`), the scope must agree across payloads, and the
// replay receipt's decision must reproduce `meetsPromotionRule`. The gateway-side proof that its real
// `evaluateGate` ACCEPTS this shape lives in meta-llm `tests/adr271-avo-gate-contract.test.ts`.
import { describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import {
  canon,
  canonEquals,
  meetsPromotionRule,
  receiptsToGateInput,
  generateGateSigner,
  gateTrustedKey,
  submitToFlywheelGate,
  type AvoRunSummary,
  type SignedReceipt,
  type GateInput,
} from '../src/flywheelGate.js';

function deepNest(n: number): unknown {
  let o: unknown = { leaf: true };
  for (let i = 0; i < n; i++) o = { next: o };
  return o;
}

/** Verify a receipt exactly as the meta-llm gate's `receiptValid` does. */
function receiptValid(r: SignedReceipt): boolean {
  const pub = createPublicKey({ key: Buffer.from(r.publicKey, 'base64'), format: 'der', type: 'spki' });
  return edVerify(null, Buffer.from(canon(r.payload)), pub, Buffer.from(r.signature, 'base64'));
}

const scope = { host: 'acme-ci', cheapModel: 'deepseek/deepseek-chat', taskClass: 'python-bugfix' };

/** A run where the candidate strictly improves on every promotion clause. */
const promoteSummary: AvoRunSummary = {
  ...scope,
  baseline: { gold: 6, emptyPatchRate: 0.47, costPerResolved: 0.033, hostHoldoutGold: 4, hostHoldoutFailureRate: 0.6 },
  candidate: { gold: 13, emptyPatchRate: 0.30, costPerResolved: 0.02, hostHoldoutGold: 7, hostHoldoutFailureRate: 0.4 },
  safetyRegression: false,
  candidateCheckpointHash: 'sha256:deadbeef',
};

/** A run where the candidate resolved FEWER — a hard holdout regression. */
const regressSummary: AvoRunSummary = {
  ...promoteSummary,
  candidate: { ...promoteSummary.candidate, gold: 3 },
};

describe('ADR-271 — receiptsToGateInput', () => {
  it('emits five receipts that each verify the way the gate does (Ed25519 over canon(payload))', () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    for (const k of ['holdout_receipt', 'security_receipt', 'drift_receipt', 'replay_receipt', 'cost_receipt'] as const) {
      expect(receiptValid(gi[k]), `${k} must verify`).toBe(true);
      expect(gi[k].alg).toBe('ed25519');
    }
  });

  it('makes every scope-bearing payload + both manifests agree on {host, cheap_model, task_class}', () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    const scopeOf = (m: Record<string, unknown>) => `${m.host}|${m.cheap_model}|${m.task_class ?? 'null'}`;
    const base = scopeOf(gi.baseline_manifest);
    expect(scopeOf(gi.candidate_manifest)).toBe(base);
    for (const k of ['holdout_receipt', 'security_receipt', 'drift_receipt', 'cost_receipt'] as const) {
      expect(scopeOf(gi[k].payload)).toBe(base);
    }
  });

  it('stamps a replay decision that reproduces meetsPromotionRule, over hashes of the exact manifests', () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    const rp = gi.replay_receipt.payload as { baseline_manifest_hash: string; candidate_manifest_hash: string; decision: { promote: boolean; reasons: string[] } };
    // Recompute the way the gate does: sha256(canon(manifest)).
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(rp.baseline_manifest_hash).toBe(sha(canon(gi.baseline_manifest)));
    expect(rp.candidate_manifest_hash).toBe(sha(canon(gi.candidate_manifest)));
    // The stamped decision equals the rule re-run on the holdout evidence.
    const evidence = (gi.holdout_receipt.payload as { evidence: Parameters<typeof meetsPromotionRule>[0] }).evidence;
    expect(rp.decision).toEqual(meetsPromotionRule(evidence));
    expect(rp.decision.promote).toBe(true);
    expect(rp.decision.reasons).toEqual([]);
  });

  it('a holdout regression yields promote:false with gold_regressed — and still verifies', () => {
    const gi = receiptsToGateInput(regressSummary, generateGateSigner());
    const rp = gi.replay_receipt.payload as { decision: { promote: boolean; reasons: string[] } };
    expect(rp.decision.promote).toBe(false);
    expect(rp.decision.reasons).toContain('gold_regressed');
    expect(receiptValid(gi.replay_receipt)).toBe(true); // the receipt is honest, not forged
  });

  it('#118 — gateTrustedKey returns the exact key to register in the gate allowlist (matches receipts)', () => {
    const signer = generateGateSigner();
    const gi = receiptsToGateInput(promoteSummary, signer);
    const registered = gateTrustedKey(signer);
    // The key the operator registers in FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON is the same SPKI-DER base64
    // the receipts carry — so registering it is exactly what authorizes this harness's submissions.
    for (const k of ['holdout_receipt', 'security_receipt', 'drift_receipt', 'replay_receipt', 'cost_receipt'] as const) {
      expect(gi[k].publicKey).toBe(registered);
    }
  });

  it('carries the AVO checkpoint hash + security_regression flag through to the receipts', () => {
    const gi = receiptsToGateInput({ ...promoteSummary, safetyRegression: true }, generateGateSigner());
    expect((gi.candidate_manifest as Record<string, unknown>).candidate_checkpoint_hash).toBe('sha256:deadbeef');
    expect((gi.security_receipt.payload as { security_regression: boolean }).security_regression).toBe(true);
  });
});

describe('ADR-271 — meetsPromotionRule mirror (reason order is load-bearing for replay)', () => {
  const base = {
    currentGold: 6, candidateGold: 13, currentEmptyPatchRate: 0.4, candidateEmptyPatchRate: 0.3,
    currentCostPerResolved: 0.03, candidateCostPerResolved: 0.02, currentHostHoldoutGold: 4,
    candidateHostHoldoutGold: 7, currentHostHoldoutFailureRate: 0.6, candidateHostHoldoutFailureRate: 0.4,
    safetyRegression: false, laggedFalsifier: null as null,
  };
  it('promotes only when every clause holds', () => {
    expect(meetsPromotionRule(base)).toEqual({ promote: true, reasons: [] });
  });
  it('emits ALL failed clauses in the fixed gate order', () => {
    const bad = { ...base, candidateGold: 1, candidateEmptyPatchRate: 0.9, candidateCostPerResolved: 0.9, candidateHostHoldoutGold: 0, safetyRegression: true };
    expect(meetsPromotionRule(bad).reasons).toEqual([
      'gold_regressed', 'empty_patch_not_improved', 'cost_per_resolved_worsened', 'host_holdout_not_improved', 'safety_regression',
    ]);
  });
});

describe('ADR-271 — submitToFlywheelGate', () => {
  it('POSTs the GateInput to /v1/flywheel/gate with the api key and returns the parsed verdict', async () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.example.test/v1/flywheel/gate');
      expect((init.headers as Record<string, string>)['X-API-Key']).toBe('cog_test');
      expect(JSON.parse(init.body as string)).toHaveProperty('replay_receipt');
      return new Response(JSON.stringify({ verdict: 'PASS_FOR_PROMOTION', reasons: [], checks: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await submitToFlywheelGate(gi as GateInput, { baseUrl: 'https://api.example.test/', apiKey: 'cog_test', fetchImpl });
    expect(out.verdict).toBe('PASS_FOR_PROMOTION');
  });

  it('throws on a transport/auth failure (non-2xx)', async () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    await expect(submitToFlywheelGate(gi as GateInput, { baseUrl: 'https://api.example.test', apiKey: 'bad', fetchImpl }))
      .rejects.toThrow(/flywheel gate 403/);
  });
});

// Dream Cycle 2026-10-26 — this `canon()` is an "exact mirror" of the gate's (see module doc comment
// above) and, until tonight, had neither hardening `@metaharness/flywheel`'s own `receipts.ts` shipped
// on 2026-10-16 (depth bound) and 2026-10-21 (non-finite rejection). Disclosed-not-fixed in the
// 2026-10-21 ledger row; closed here. Every case below proves the FIX (a clean rejection feeding real
// `edSign`/`sha256hex` call sites), not just "didn't crash."
describe('canon() — ported hardening (recursion depth + non-finite numbers)', () => {
  it('canonicalizes normal, shallow values exactly as before (byte-identical)', () => {
    expect(canon({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canon([1, 2, { a: 1 }])).toBe('[1,2,{"a":1}]');
  });

  it('still canonicalizes a reasonably-nested value (well under the bound), deterministically', () => {
    expect(canon(deepNest(20))).toBe(canon(deepNest(20)));
  });

  it('throws a clear, bounded Error — not a native stack overflow — past the depth limit', () => {
    expect(() => canon(deepNest(100_000))).toThrow(/exceeds max nesting depth/);
  });

  it('rejects NaN/Infinity/-Infinity instead of collapsing them to the same string as null', () => {
    expect(() => canon(NaN)).toThrow(/non-finite/);
    expect(() => canon(Infinity)).toThrow(/non-finite/);
    expect(() => canon(-Infinity)).toThrow(/non-finite/);
    // Pre-fix, all three of these (plus `null`) canonicalized to the identical `"null"` — a forged
    // field could swap in NaN/Infinity for a legitimate null and still verify.
  });

  it('a non-finite field nested inside a signed-shaped payload is rejected the same way', () => {
    expect(() => canon({ candidateGold: NaN, reasons: ['gold_regressed'] })).toThrow(/non-finite/);
  });

  it('canonEquals() is fail-closed: a value that cannot be canonicalized counts as NOT equal, never throws', () => {
    expect(canonEquals({ a: 1 }, { a: 1 })).toBe(true);
    expect(canonEquals({ a: 1 }, { a: 2 })).toBe(false);
    expect(canonEquals({ a: NaN }, { a: null })).toBe(false); // the exact collision this fix closes
    expect(canonEquals(deepNest(100_000), { a: 1 })).toBe(false);
  });

  it('a tampered NaN field cannot forge a receipt previously signed over a legitimate null value', () => {
    // Pre-fix: canon({ v: NaN }) === canon({ v: null }) === '{"v":null}', so a signature over the
    // null-valued payload would also verify over the NaN-valued one — the exact bypass this closes.
    expect(() => canon({ v: NaN })).toThrow(/non-finite/);
    expect(canon({ v: null })).toBe('{"v":null}');
  });

  it('manifest-hash binding (sha256hex(canon(manifest))) rejects a non-finite field instead of hashing a collided string', () => {
    const gi = receiptsToGateInput(promoteSummary, generateGateSigner());
    // The real call site (receiptsToGateInput → sha256hex(canon(baseline_manifest))) only ever sees
    // finite fields today; this proves the choke point itself, independent of that caller, fails
    // closed rather than silently hashing a NaN/null-collided string if a future caller passed one.
    expect(() => canon({ ...gi.baseline_manifest, poisoned: NaN })).toThrow(/non-finite/);
  });
});
