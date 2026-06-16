// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { VerifierRegistry, predicateVerifier, critiqueLoop } from '../src/verifier.js';

describe('VerifierRegistry', () => {
  it('ANDs all verifiers and aggregates reasons on failure', async () => {
    const reg = new VerifierRegistry().register(
      predicateVerifier('nonempty', 'syntax', (o) => String(o).length > 0, 'empty'),
      predicateVerifier('hasFoo', 'schema', (o) => String(o).includes('foo'), 'missing foo'),
    );
    expect((await reg.run('foobar')).pass).toBe(true);
    const bad = await reg.run('bar');
    expect(bad.pass).toBe(false);
    expect(bad.reasons.join(' ')).toContain('missing foo');
  });

  it('filters verifiers by kind', async () => {
    const reg = new VerifierRegistry().register(
      predicateVerifier('always-fail', 'cost', () => false),
    );
    // No "syntax" verifier registered → vacuously passes for that kind.
    expect((await reg.run('x', {}, ['syntax'])).pass).toBe(true);
    expect((await reg.run('x', {}, ['cost'])).pass).toBe(false);
  });
});

describe('critiqueLoop', () => {
  it('repairs a failing output then passes', async () => {
    const reg = new VerifierRegistry().register(
      predicateVerifier('hasFoo', 'schema', (o) => String(o).includes('foo'), 'missing foo'),
    );
    const res = await critiqueLoop(reg, 'bar', (o) => `${o}+foo`, { maxAttempts: 2 });
    expect(res.verdict.pass).toBe(true);
    expect(res.attempts).toBe(1);
    expect(res.output).toBe('bar+foo');
  });

  it('exhausts attempts when repair cannot fix it', async () => {
    const reg = new VerifierRegistry().register(
      predicateVerifier('hasFoo', 'schema', (o) => String(o).includes('foo')),
    );
    const res = await critiqueLoop(reg, 'bar', (o) => `${o}!`, { maxAttempts: 2 });
    expect(res.verdict.pass).toBe(false);
    expect(res.attempts).toBe(2);
  });
});
