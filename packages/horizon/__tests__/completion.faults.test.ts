import { describe, it, expect } from 'vitest';
import {
  verifyCompletionCertificate,
  type CompletionCertificate,
  type HorizonEvent,
} from '../src/index.js';

function makeReceipt(overrides: Partial<NonNullable<HorizonEvent['receipt']>> = {}): NonNullable<HorizonEvent['receipt']> {
  return {
    stdout: '42',
    stderr: '',
    exitCode: 0,
    durationMs: 1,
    artifactDigest: 'sha256:good',
    policyReceipt: {
      verdict: 'allow',
      reasons: ['fixture'],
      authorized: true,
      approvalRequired: false,
      approved: true,
    },
    ...overrides,
  };
}

function certificate(eventId = 'tool:1', artifactDigest = 'sha256:good'): CompletionCertificate {
  return {
    claims: [{
      id: 'answer',
      value: '42',
      evidence: [{ eventId, artifactDigest }],
    }],
  };
}

describe('completion verifier deterministic fault injections', () => {
  it('rejects 128 unsupported completion variants', async () => {
    for (let i = 0; i < 128; i += 1) {
      const fault = i % 4;
      let events: HorizonEvent[] = [{
        id: 'tool:1',
        role: 'tool',
        text: 'fixture',
        receipt: makeReceipt(),
      }];
      let cert = certificate();
      let replay = async () => '42';

      if (fault === 0) {
        cert = certificate(`missing:${i}`);
      } else if (fault === 1) {
        cert = certificate('tool:1', `sha256:stale:${i}`);
      } else if (fault === 2) {
        events = [{
          id: 'tool:1',
          role: 'tool',
          text: 'failed fixture',
          receipt: makeReceipt({ exitCode: 1, stderr: `failure ${i}` }),
        }];
      } else {
        replay = async () => `wrong:${i}`;
      }

      const result = await verifyCompletionCertificate(
        cert,
        events,
        { requiredClaims: ['answer'] },
        replay,
      );
      expect(result.ok, `fault injection ${i} must fail closed`).toBe(false);
    }
  });
});
