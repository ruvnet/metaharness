// @metaharness/evals-math — $0 tests for the LIVE GSM8K wiring (loader gold-parse + the committed frozen
// split). No network: parseGsm8kGold is pure, and the frozen-file test reads the committed artifact. The
// network loader itself (loadGsm8kFromHub) is exercised by the freeze script, not here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseGsm8kGold, manifestOf, hashItems } from '../src/data.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('parseGsm8kGold', () => {
  it('extracts the integer after the final #### marker', () => {
    expect(parseGsm8kGold('Janet sells 9 eggs.\nShe makes $18.\n#### 18')).toBe('18');
  });
  it('strips $, commas, and whitespace', () => {
    expect(parseGsm8kGold('... #### 1,000')).toBe('1000');
    expect(parseGsm8kGold('... ####  $2,500 ')).toBe('2500');
  });
  it('returns null (never fabricates) when there is no marker or a non-numeric gold', () => {
    expect(parseGsm8kGold('no marker here')).toBeNull();
    expect(parseGsm8kGold('#### forty-two')).toBeNull();
    expect(parseGsm8kGold('')).toBeNull();
  });
});

describe('committed frozen GSM8K split (bench/gsm8k-frozen.json)', () => {
  const frozen = JSON.parse(readFileSync(join(HERE, '..', 'bench', 'gsm8k-frozen.json'), 'utf8'));
  const sets = frozen.sets;
  const all = [...sets.publicDev, ...sets.privateTrain, ...sets.privateValidation, ...sets.frozenHoldout];

  it('is a real, non-empty openai/gsm8k split', () => {
    expect(frozen.dataset).toBe('openai/gsm8k');
    expect(all.length).toBeGreaterThan(100);
    for (const it of all) expect(typeof it.question).toBe('string');
  });

  it('the four sets are DISJOINT (procedural anti-overfit)', () => {
    const ids = all.map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every gold answer is a clean integer (exact-match gradable — never fabricated)', () => {
    for (const it of all) {
      expect(it.answerFormat).toBe('integer');
      expect(/^-?\d+(\.\d+)?$/.test(it.answer)).toBe(true);
    }
  });

  it('the committed manifest hashes + splitFingerprint match a recomputation (the split is verifiable)', () => {
    const recomputed = manifestOf(sets);
    expect(recomputed.splitFingerprint).toBe(frozen.splitFingerprint);
    for (const k of ['publicDev', 'privateTrain', 'privateValidation', 'frozenHoldout'] as const) {
      expect(hashItems(sets[k])).toBe(frozen.hashes[k]);
    }
  });
});
