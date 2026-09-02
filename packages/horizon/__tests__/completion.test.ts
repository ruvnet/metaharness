import { describe, it, expect, beforeAll } from 'vitest';
import {
  HorizonCore,
  LongHorizonDriver,
  verifyCompletionCertificate,
  type CompletionCertificate,
  type HorizonEvent,
  type StepResult,
} from '../src/index.js';

function receipt(overrides: Partial<NonNullable<HorizonEvent['receipt']>> = {}): NonNullable<HorizonEvent['receipt']> {
  return {
    stdout: 'observed',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    artifactDigest: 'sha256:test',
    policyReceipt: {
      verdict: 'allow',
      reasons: ['test'],
      authorized: true,
      approvalRequired: false,
      approved: true,
    },
    ...overrides,
  };
}

const validEvents: HorizonEvent[] = [
  { id: 'tool:1', role: 'tool', text: 'first', receipt: receipt({ stdout: 'wrong' }) },
  { id: 'tool:2', role: 'tool', text: 'second', receipt: receipt({ stdout: '42', artifactDigest: 'sha256:answer' }) },
];

const validCertificate: CompletionCertificate = {
  claims: [
    {
      id: 'answer',
      value: '42',
      evidence: [{ eventId: 'tool:2', artifactDigest: 'sha256:answer' }],
    },
  ],
};

describe('Evidence carrying completion verifier', () => {
  it('accepts only a required claim reconstructed from authorized successful evidence', async () => {
    const result = await verifyCompletionCertificate(
      validCertificate,
      validEvents,
      { requiredClaims: ['answer'] },
      async (_claim, evidence) => evidence[0]?.receipt?.stdout ?? '',
    );
    expect(result).toEqual({ ok: true, errors: [], checkedClaims: ['answer'] });
  });

  it('binds references to stable event ids instead of transcript positions', async () => {
    const reordered = [validEvents[1], validEvents[0]];
    const result = await verifyCompletionCertificate(
      validCertificate,
      reordered,
      { requiredClaims: ['answer'] },
      async (_claim, evidence) => evidence[0]?.receipt?.stdout ?? '',
    );
    expect(result.ok).toBe(true);
  });

  it('fails closed for missing claims, missing replay, denied evidence, digest mismatch, and ambiguity', async () => {
    const missing = await verifyCompletionCertificate(
      { claims: [] },
      validEvents,
      { requiredClaims: ['answer'] },
      async () => '42',
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors).toContain('required claim missing: answer');

    const noReplay = await verifyCompletionCertificate(
      validCertificate,
      validEvents,
      { requiredClaims: ['answer'] },
      undefined,
    );
    expect(noReplay.errors).toContain('completion replay seam missing');

    const deniedEvents: HorizonEvent[] = [{
      id: 'tool:2',
      role: 'tool',
      text: 'denied',
      receipt: receipt({
        stdout: '42',
        artifactDigest: 'sha256:answer',
        policyReceipt: {
          verdict: 'gate', reasons: ['approval'], authorized: false,
          approvalRequired: true, approved: false,
        },
      }),
    }];
    const denied = await verifyCompletionCertificate(
      validCertificate,
      deniedEvents,
      { requiredClaims: ['answer'] },
      async () => '42',
    );
    expect(denied.errors.some((e) => e.includes('was not authorized'))).toBe(true);

    const digestMismatch = await verifyCompletionCertificate(
      validCertificate,
      [{ ...validEvents[1], receipt: receipt({ stdout: '42', artifactDigest: 'sha256:changed' }) }],
      { requiredClaims: ['answer'] },
      async () => '42',
    );
    expect(digestMismatch.errors.some((e) => e.includes('artifact digest mismatch'))).toBe(true);

    const ambiguous = await verifyCompletionCertificate(
      validCertificate,
      [validEvents[1], { ...validEvents[1], text: 'duplicate id' }],
      { requiredClaims: ['answer'] },
      async () => '42',
    );
    expect(ambiguous.errors.some((e) => e.includes('ambiguous'))).toBe(true);
  });

  it('rejects replay mismatch even when the model supplied value looks plausible', async () => {
    const result = await verifyCompletionCertificate(
      validCertificate,
      validEvents,
      { requiredClaims: ['answer'] },
      async () => '41',
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('claim answer: replay mismatch');
  });
});

const wasmOk = await HorizonCore.load().then(() => true).catch(() => false);
let core: HorizonCore;
beforeAll(async () => {
  if (wasmOk) core = await HorizonCore.load();
});

describe.skipIf(!wasmOk)('LongHorizonDriver evidence carrying termination', () => {
  it('recovers from premature completion and finishes only after new replayable evidence', async () => {
    let stepNumber = 0;
    const executor = {
      execute: async (request: any) => ({
        stdout: 'observed',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
        artifactDigest: 'sha256:test',
        policyReceipt: {
          verdict: request.classification.verdict,
          reasons: request.classification.reasons,
          authorized: true,
          approvalRequired: false,
          approved: true,
        },
      }),
    };
    const compaction = {
      estimateTokens: (events: HorizonEvent[]) => events.reduce((n, e) => n + e.text.length, 0),
      flushDurableFacts: async () => undefined,
      summarize: async () => ({ role: 'summary' as const, text: 'summary' }),
    };

    const driver = new LongHorizonDriver(core, {
      executor,
      compaction,
      replayCompletion: async (_claim, evidence) => evidence[0]?.receipt?.stdout ?? '',
      step: async (): Promise<StepResult> => {
        stepNumber += 1;
        if (stepNumber === 1) return { kind: 'final', output: 'premature' };
        if (stepNumber === 2) return { kind: 'tool', command: 'ls', progress: 'evidence-collected' };
        return {
          kind: 'final',
          output: 'done',
          certificate: {
            claims: [{
              id: 'result',
              value: 'observed',
              evidence: [{ eventId: 'tool:1', artifactDigest: 'sha256:test' }],
            }],
          },
        };
      },
    }, {
      halt: { maxIterations: 20, noProgressLimit: 3, repeatedFailureLimit: 3 },
      policy: {},
      compaction: { thresholdTokens: 1e9, keepRecent: 6 },
      completion: { requiredClaims: ['result'] },
    });

    const outcome = await driver.runTurn('produce a supported result');
    expect(outcome.kind).toBe('final');
    if (outcome.kind === 'final') {
      expect(outcome.output).toBe('done');
      expect(outcome.completion?.ok).toBe(true);
      expect(outcome.events.some((e) => e.text.includes('[completion rejected]'))).toBe(true);
      expect(outcome.events.some((e) => e.id === 'tool:1')).toBe(true);
    }
  });
});
