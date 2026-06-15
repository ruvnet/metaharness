// SPDX-License-Identifier: MIT
// DRACO self-consistency arm (ADR-038 arm 2) — offline, mock-transport tests.

import { describe, it, expect, vi } from 'vitest';
import { selfConsistentResearch, parseQuality, CANDIDATE_ANGLES } from '../src/draco/self-consistency.js';
import type { OpenRouterTransport } from '../src/draco/fusion.js';

describe('parseQuality', () => {
  it('parses a bare number', () => expect(parseQuality('0.82')).toBeCloseTo(0.82));
  it('parses a number embedded in prose', () => expect(parseQuality('I rate this 0.7 overall.')).toBeCloseTo(0.7));
  it('parses 1.0 and 0', () => {
    expect(parseQuality('1.0')).toBe(1);
    expect(parseQuality('0')).toBe(0);
  });
  it('fails closed to 0 on non-numeric', () => expect(parseQuality('excellent')).toBe(0));
  it('clamps to [0,1]', () => expect(parseQuality('0.99')).toBeLessThanOrEqual(1));
});

describe('selfConsistentResearch — best-of-N selection', () => {
  it('selects the highest judge-rated candidate and never transforms it', async () => {
    // base transport returns a distinct dossier per angle (by length marker).
    const transport = vi.fn(async (_model: string, messages: { content: string }[]) => {
      const sys = messages[0].content;
      const idx = CANDIDATE_ANGLES.findIndex((a) => a !== '' && sys.includes(a)) ;
      const tag = idx === -1 ? 'neutral' : `angle${idx}`;
      return { text: `dossier-${tag}`, tokens: 100 };
    }) as unknown as OpenRouterTransport;
    // judge rates: neutral=0.5, angle1=0.9 (best), angle2=0.6
    const judge = vi.fn(async (_m: string, messages: { content: string }[]) => {
      const d = messages[1].content;
      if (d.includes('angle1')) return { text: '0.9', tokens: 5 };
      if (d.includes('angle2')) return { text: '0.6', tokens: 5 };
      return { text: '0.5', tokens: 5 };
    }) as unknown as OpenRouterTransport;

    const r = await selfConsistentResearch(
      { id: 'sci-001', prompt: 'q' },
      { baseModel: 'anthropic/claude-opus-4', judgeModel: 'google/gemini-2.5-pro', transport, judgeTransport: judge, candidates: 3 },
    );
    expect(r.answer).toBe('dossier-angle1'); // highest rated, returned VERBATIM
    expect(r.selectedIndex).toBe(1);
    expect(r.scores.length).toBe(3);
    expect(r.totalTokens).toBe(3 * 100 + 3 * 5);
  });

  it('prefers the neutral candidate on a tie (earliest index)', async () => {
    const transport = (async (_m: string, messages: { content: string }[]) => {
      const sys = messages[0].content;
      const idx = CANDIDATE_ANGLES.findIndex((a) => a !== '' && sys.includes(a));
      return { text: idx === -1 ? 'neutral' : `angle${idx}`, tokens: 10 };
    }) as OpenRouterTransport;
    const judge = (async () => ({ text: '0.7', tokens: 2 })) as OpenRouterTransport; // all tie
    const r = await selfConsistentResearch(
      { id: 'x', prompt: 'q' },
      { baseModel: 'anthropic/claude-opus-4', judgeModel: 'google/gemini-2.5-pro', transport, judgeTransport: judge, candidates: 3 },
    );
    expect(r.selectedIndex).toBe(0);
    expect(r.answer).toBe('neutral');
  });
});
