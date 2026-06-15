// SPDX-License-Identifier: MIT
// DRACO live-citation enforcer (ADR-038 arm 6) — Self-RAG dead→live mirror swap.
// Proves it preserves coverage where the gate alone would drop the claim, and the
// honesty invariants (only genuine mirrors, never fabricate, never hide). Offline.

import { describe, it, expect } from 'vitest';
import { enforceLiveCitations, runLiveCitationPipeline, type PooledSource } from '../src/draco/live-citation.js';
import { scoreWithGate } from '../src/draco/grounding-gate.js';
import { scoreAnswer, type UrlChecker, type Rubric } from '../src/draco/scorer.js';

// "/live" URLs resolve; everything else is dead.
const checker: UrlChecker = async (u) => (/\/live/.test(u) ? 'ok' : 'dead');

describe('enforceLiveCitations — dead→live mirror swap', () => {
  it('swaps a dead-only citation for a live pooled source that supports the claim', async () => {
    const answer = 'Green hydrogen output doubled in 2025 https://a.com/dead-primary this year.';
    const pool: PooledSource[] = [{ url: 'https://b.com/live-iea', supports: ['hydrogen'] }];
    const r = await enforceLiveCitations(answer, pool, checker);
    expect(r.swapped).toBe(1);
    expect(r.unresolved).toBe(0);
    expect(r.enforcedAnswer).toContain('live-iea');
    expect(r.enforcedAnswer).not.toContain('dead-primary');
    expect(r.enforcedAnswer).toContain('hydrogen'); // claim + coverage term preserved
  });

  it('leaves a dead-only claim untouched when NO live mirror supports it (no fabrication)', async () => {
    const answer = 'Tidal energy surged https://a.com/dead-only notably.';
    const pool: PooledSource[] = [{ url: 'https://b.com/live-solar', supports: ['solar'] }]; // wrong topic
    const r = await enforceLiveCitations(answer, pool, checker);
    expect(r.swapped).toBe(0);
    expect(r.unresolved).toBe(1);
    expect(r.enforcedAnswer).toContain('dead-only'); // untouched — gate will drop it honestly
  });

  it('never reuses the same mirror twice (no manufactured redundancy)', async () => {
    const answer =
      'Solar grew https://a.com/dead1 fast. Solar also fell https://a.com/dead2 later.';
    const pool: PooledSource[] = [{ url: 'https://b.com/live-solar', supports: ['solar'] }];
    const r = await enforceLiveCitations(answer, pool, checker);
    expect(r.swapped).toBe(1); // only ONE claim gets the single live mirror
    expect(r.unresolved).toBe(1);
  });

  it('leaves already-live-cited sentences alone', async () => {
    const answer = 'Wind capacity rose https://a.com/live-gwec sharply.';
    const r = await enforceLiveCitations(answer, [], checker);
    expect(r.alreadyLive).toBe(1);
    expect(r.swapped).toBe(0);
    expect(r.enforcedAnswer).toContain('live-gwec');
  });
});

describe('pipeline beats gate-alone when a live mirror exists (the coverage rescue)', () => {
  const rubric: Rubric = { must_contain: ['hydrogen'] };
  const prompt = 'Discuss hydrogen.';
  // The ONLY sentence with the rubric term is cited by a dead URL — gate alone drops it.
  const answer = 'Green hydrogen scaled https://a.com/dead-only in 2025.';
  const pool: PooledSource[] = [{ url: 'https://b.com/live-iea', supports: ['hydrogen'] }];

  it('gate alone loses the coverage term (claim dropped)', async () => {
    const g = await scoreWithGate(answer, rubric, prompt, checker);
    expect(g.after.coverage).toBeCloseTo(0, 5); // "hydrogen" gone with the dropped claim
  });

  it('enforce→gate pipeline keeps coverage AND grounds it (live mirror swapped in)', async () => {
    const { pipelineAnswer } = await runLiveCitationPipeline(answer, pool, checker);
    const scored = await scoreAnswer(pipelineAnswer, rubric, prompt, checker);
    expect(scored.coverage).toBeCloseTo(1, 5); // "hydrogen" preserved
    expect(scored.grounding).toBeCloseTo(1, 5); // now cited by a live source
    // strictly better composite than gate-alone
    const g = await scoreWithGate(answer, rubric, prompt, checker);
    expect(scored.mean).toBeGreaterThan(g.after.mean);
  });
});

describe('honesty: pipeline never emits a dead citation', () => {
  it('every URL in the final answer resolves live', async () => {
    const answer =
      'A https://a.com/live-1 ok. B https://a.com/dead-mirror needs help. C https://a.com/dead-nohelp gone.';
    const pool: PooledSource[] = [{ url: 'https://b.com/live-2', supports: ['needs help'] }];
    const { pipelineAnswer } = await runLiveCitationPipeline(answer, pool, checker);
    const urls = pipelineAnswer.match(/https?:\/\/[^\s)\]]+/g) ?? [];
    for (const u of urls) expect(await checker(u)).toBe('ok');
    // claim B rescued via mirror; claim C (no mirror) dropped by the gate
    expect(pipelineAnswer).toContain('live-2');
    expect(pipelineAnswer).not.toContain('dead-nohelp');
  });
});
