import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  prepareIndependentReviewPacket,
  verifyIndependentReviewPacket,
  type IndependentReviewInput,
  type ReviewPacketExpectation,
} from '../src/review-context.js';

const digest = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;

const base = (): IndependentReviewInput => ({
  reviewId: 'review:1',
  runId: 'run:1',
  tenantDigest: digest('tenant'),
  candidateDigest: digest('candidate'),
  taskDigest: digest('task'),
  policyDigest: digest('policy'),
  evaluatorDigest: digest('evaluator'),
  role: 'security',
  createdAt: '2026-09-24T14:00:00.000Z',
  expiresAt: '2026-09-24T15:00:00.000Z',
  maxEvidenceBytes: 4096,
  evidence: [
    { id: 'test:1', kind: 'test_result', digest: digest('test'), sourceDigest: digest('source-test'), bytes: 512 },
    { id: 'artifact:1', kind: 'artifact', digest: digest('artifact'), sourceDigest: digest('source-artifact'), bytes: 1024 },
  ],
});

const expectation = (): ReviewPacketExpectation => ({
  tenantDigest: digest('tenant'),
  candidateDigest: digest('candidate'),
  taskDigest: digest('task'),
  policyDigest: digest('policy'),
  evaluatorDigest: digest('evaluator'),
  role: 'security',
});

describe('independent review context', () => {
  it('builds a deterministic evidence only packet with no authority', () => {
    const input = base();
    const first = prepareIndependentReviewPacket(input);
    const second = prepareIndependentReviewPacket({ ...input, evidence: [...input.evidence].reverse() });

    expect(first).toEqual(second);
    expect(first.contextPolicy).toBe('independent-review-v1');
    expect(first.authority).toBe('none');
    expect(first.evidence.map((item) => item.id)).toEqual(['artifact:1', 'test:1']);
    expect(first.packetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    'workerReasoning',
    'peerMessages',
    'priorVerdicts',
    'rewardHistory',
    'sharedScratchpad',
    'reviewerIdentity',
  ])('fails closed when forbidden context field %s is present', (field) => {
    const input = { ...base(), [field]: 'do not expose this to an independent reviewer' };
    expect(() => prepareIndependentReviewPacket(input)).toThrow(/forbidden or unknown field/);
  });

  it('rejects unknown evidence kinds', () => {
    const input = base();
    input.evidence = [
      { id: 'peer:1', kind: 'peer_message', digest: digest('peer'), sourceDigest: digest('source-peer'), bytes: 32 },
    ];
    expect(() => prepareIndependentReviewPacket(input)).toThrow(/kind is forbidden or unknown/);
  });

  it('rejects duplicate evidence identifiers and oversized evidence', () => {
    const duplicate = base();
    duplicate.evidence = [duplicate.evidence[0], duplicate.evidence[0]];
    expect(() => prepareIndependentReviewPacket(duplicate)).toThrow(/duplicate evidence id/);

    const oversized = base();
    oversized.maxEvidenceBytes = 100;
    expect(() => prepareIndependentReviewPacket(oversized)).toThrow(/exceeds maxEvidenceBytes/);
  });

  it('detects packet mutation', () => {
    const packet = prepareIndependentReviewPacket(base());
    const mutated = {
      ...packet,
      evidence: packet.evidence.map((item, index) => index === 0 ? { ...item, bytes: item.bytes + 1 } : item),
    };
    expect(verifyIndependentReviewPacket(mutated, expectation(), '2026-09-24T14:30:00.000Z')).toEqual({
      ok: false,
      reason: 'packet digest mismatch',
    });
  });

  it('rejects tenant, policy, evaluator, role, and candidate substitution', () => {
    const packet = prepareIndependentReviewPacket(base());
    const now = '2026-09-24T14:30:00.000Z';

    for (const [field, value] of [
      ['tenantDigest', digest('other-tenant')],
      ['candidateDigest', digest('other-candidate')],
      ['policyDigest', digest('other-policy')],
      ['evaluatorDigest', digest('other-evaluator')],
      ['role', 'release'],
    ] as const) {
      expect(verifyIndependentReviewPacket(packet, { ...expectation(), [field]: value }, now).ok).toBe(false);
    }
  });

  it('rejects expired and not yet valid packets', () => {
    const packet = prepareIndependentReviewPacket(base());
    expect(verifyIndependentReviewPacket(packet, expectation(), '2026-09-24T13:59:59.999Z')).toEqual({
      ok: false,
      reason: 'packet not yet valid',
    });
    expect(verifyIndependentReviewPacket(packet, expectation(), '2026-09-24T15:00:00.000Z')).toEqual({
      ok: false,
      reason: 'packet expired',
    });
  });

  it('accepts an exact fresh packet under the expected bindings', () => {
    const packet = prepareIndependentReviewPacket(base());
    expect(verifyIndependentReviewPacket(packet, expectation(), '2026-09-24T14:30:00.000Z')).toEqual({ ok: true, reason: 'ok' });
  });
});
