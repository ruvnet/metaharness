// SPDX-License-Identifier: MIT
//
// Darwin Shield REAL self-writing loop (ADR-155 Addendum A, Phase 2 §in-loop
// judge). The generated Semgrep rule is judged by REAL semgrep through the
// paired-bootstrap promotion gate. Pure parts always run; the real-tool parts
// skipIf(!available) so the deterministic suite is green with or without semgrep.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateSemgrepRule, evaluateRealCandidate } from '../../src/security/real-loop.js';
import { SemgrepDetectorOracle, type TargetLabel } from '../../src/security/semgrep-oracle.js';

const corpusDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'bench',
  'security',
  'fixtures',
  'semgrep-corpus',
);
const labels: TargetLabel[] = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8')).labels;
const corpus = { dir: corpusDir, labels };
const available = new SemgrepDetectorOracle().isAvailable();

describe('generateSemgrepRule (pure — always runs)', () => {
  it('emits a YAML rules block with one rule per pattern key', () => {
    const yaml = generateSemgrepRule(['eval', 'yaml-load']);
    expect(yaml.startsWith('rules:')).toBe(true);
    expect(yaml).toContain('id: ds-eval');
    expect(yaml).toContain('id: ds-yaml-load');
    expect(yaml).toContain('pattern: yaml.load(...)');
  });
  it('dedupes repeated keys', () => {
    const yaml = generateSemgrepRule(['eval', 'eval']);
    expect(yaml.match(/id: ds-eval/g)).toHaveLength(1);
  });
});

describe('graceful skip (always runs)', () => {
  it('returns available:false for an absent binary, never throws', () => {
    const v = evaluateRealCandidate(['eval'], ['eval', 'exec'], corpus, {
      oracle: new SemgrepDetectorOracle({ binary: '/nonexistent/semgrep' }),
    });
    expect(v.available).toBe(false);
    expect(v.promote).toBe(false);
  });
});

describe.skipIf(!available)('real semgrep as the in-loop judge', () => {
  it('promotes a broader rule over a narrower incumbent (statistically, zero FP)', () => {
    const v = evaluateRealCandidate(
      ['eval'],
      ['eval', 'exec', 'shell-true', 'yaml-load', 'pickle-loads'],
      corpus,
      { seed: 0 },
    );
    expect(v.available).toBe(true);
    expect(v.promote).toBe(true);
    expect(v.bootstrap.lower95).toBeGreaterThan(0);
    expect(v.candidateScore).toBeGreaterThan(v.incumbentScore);
    expect(v.candidateFalsePositives).toBe(0); // ignores yaml.safe_load + evaluate decoy
  });

  it('does NOT promote a candidate equal to the incumbent (no improvement)', () => {
    const v = evaluateRealCandidate(['eval', 'exec'], ['eval', 'exec'], corpus, { seed: 0 });
    expect(v.promote).toBe(false);
    expect(v.bootstrap.lower95).toBe(0);
  });

  it('is deterministic (same verdict + receipt hash for a fixed version/seed)', () => {
    const a = evaluateRealCandidate(['eval'], ['eval', 'pickle-loads'], corpus, { seed: 1 });
    const b = evaluateRealCandidate(['eval'], ['eval', 'pickle-loads'], corpus, { seed: 1 });
    expect(a.promote).toBe(b.promote);
    expect(a.receiptHash).toBe(b.receiptHash);
    expect(a.bootstrap.lower95).toBe(b.bootstrap.lower95);
  });
});
