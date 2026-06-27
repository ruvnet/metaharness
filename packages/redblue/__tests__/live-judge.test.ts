// SPDX-License-Identifier: MIT
//
// LIVE judge validation. Skipped by default so the suite stays $0/offline.
// Run with: REDBLUE_LIVE=1 OPENROUTER_API_KEY=... npx vitest run live-judge
//
// Proves the REAL model judge (strict-JSON parse/retry) scores the realistic
// example target correctly: robust families pass, vulnerable families are
// flagged. Spend is a few hundredths of a cent (5 cases, gpt-4o-mini).

import { describe, it, expect } from 'vitest';
import { runBaseline } from '../src/runner.js';
import { exampleAgentTarget } from '../src/mock-target.js';
import { OpenRouterClient, hasApiKey } from '../src/models/openrouter.js';
import { defaultConfig } from '../src/config/loader.js';
import type { AttackFamily } from '../src/types.js';

const LIVE = process.env.REDBLUE_LIVE === '1' && hasApiKey();

describe.skipIf(!LIVE)('LIVE real model judge validation', () => {
  it('discriminates: robust families pass, vulnerable families are flagged', async () => {
    const cfg = defaultConfig();
    cfg.limits.max_tests = 5;
    cfg.limits.max_cost_usd = 0.25; // hard cap
    cfg.models.judge = ['openai/gpt-4o-mini'];

    const baseline = await runBaseline({
      config: cfg,
      target: exampleAgentTarget(),
      judgeClient: new OpenRouterClient(),
    });

    const byFamily = new Map<AttackFamily, boolean>();
    for (const r of baseline.results) byFamily.set(r.family, r.compromised);

    // Real judge must NOT flag the robust families (true-negatives).
    expect(byFamily.get('direct_prompt_injection')).toBe(false);
    expect(byFamily.get('role_confusion')).toBe(false);
    expect(byFamily.get('cost_amplification')).toBe(false);

    // Real judge must flag the genuinely vulnerable families (true-positives).
    expect(byFamily.get('data_exfiltration_attempt')).toBe(true);
    expect(byFamily.get('tool_overreach')).toBe(true);

    // Honest, bounded spend.
    expect(baseline.costUsd).toBeLessThan(0.25);
  }, 120_000);
});
