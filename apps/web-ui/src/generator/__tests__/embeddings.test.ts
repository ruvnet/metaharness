import { describe, expect, it } from 'vitest';
import { cosine, clamp01, round3, profileText, archetypeText } from '../embeddings';
import { ARCHETYPES, analyzeFiles, recommendPlan, scoreArchetypes } from '../repo';
import type { RepoInput } from '../repo';

describe('embedding math (pure)', () => {
  it('cosine of identical vectors is 1, orthogonal is 0', () => {
    expect(round3(cosine([1, 0, 0], [1, 0, 0]))).toBe(1);
    expect(round3(cosine([1, 0, 0], [0, 1, 0]))).toBe(0);
  });
  it('cosine of zero vector is 0 (no NaN)', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  it('clamp01 + round3', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(round3(0.123456)).toBe(0.123);
  });
  it('profileText / archetypeText produce non-empty strings', () => {
    const a = ARCHETYPES[0]!;
    expect(archetypeText(a).length).toBeGreaterThan(0);
  });
});

const rustRepo: RepoInput = {
  owner: 'ruvnet',
  repo: 'ruvector',
  files: { 'README.md': 'Rust WASM vector db', 'Cargo.toml': '[package]\nname="ruvector"' },
};

describe('injected semantic scores', () => {
  it('an injected map can override the ranking deterministically', () => {
    const profile = analyzeFiles(rustRepo);
    // Force the research archetype to dominate via the semantic term.
    const semantic: Record<string, number> = Object.fromEntries(ARCHETYPES.map((a) => [a.id, a.id === 'research-harness' ? 1 : 0]));
    const ranked = scoreArchetypes(profile, semantic);
    // research-harness should now outrank with a near-max semantic contribution.
    const research = ranked.find((r) => r.archetype.id === 'research-harness')!;
    expect(research.breakdown.semantic).toBe(1);
    // Same inputs -> same ranking (determinism).
    expect(scoreArchetypes(profile, semantic)).toEqual(ranked);
  });

  it('profileText feeds embeddings; lexical default still works without it', () => {
    const profile = analyzeFiles(rustRepo);
    expect(profileText(profile)).toContain('ruvector');
    // No semantic map -> lexical path -> rust archetype wins (unchanged contract).
    expect(recommendPlan(profile).archetypeId).toBe('rust-crate-harness');
  });
});
