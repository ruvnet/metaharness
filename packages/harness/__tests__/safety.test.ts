// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { PolicyGate, allowTools, denyTools } from '../src/safety.js';

describe('PolicyGate (default-deny + risk scoring)', () => {
  it('denies an unknown tool by default (no allow rule matched)', () => {
    const gate = new PolicyGate([allowTools(['read'])]);
    const d = gate.evaluate({ tool: 'shell' });
    expect(d.allow).toBe(false);
    expect(d.reasons.join(' ')).toContain('default-deny');
  });

  it('allows an allow-listed tool', () => {
    const gate = new PolicyGate([allowTools(['read', 'plan'])]);
    expect(gate.evaluate({ tool: 'plan' }).allow).toBe(true);
  });

  it('deny dominates allow', () => {
    const gate = new PolicyGate([allowTools(['shell']), denyTools(['shell'])]);
    expect(gate.evaluate({ tool: 'shell' }).allow).toBe(false);
  });

  it('takes the MAX risk of matched rules and blocks above the ceiling', () => {
    const gate = new PolicyGate(
      [{ id: 'hot', effect: 'allow', match: (a) => a.tool === 'http', risk: 0.9 }],
      0.5,
    );
    const d = gate.evaluate({ tool: 'http' });
    expect(d.risk).toBe(0.9);
    expect(d.allow).toBe(false); // risk over ceiling
  });

  it('a throwing matcher never silently allows', () => {
    const gate = new PolicyGate([{ id: 'boom', effect: 'allow', match: () => { throw new Error('x'); } }]);
    expect(gate.evaluate({ tool: 'anything' }).allow).toBe(false);
  });
});
