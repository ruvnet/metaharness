// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { render, extractVarReferences, validateHarnessName } from '../src/renderer.js';

describe('render', () => {
  it('substitutes a single {{var}}', () => {
    const r = render('hello {{name}}', { name: 'world' });
    expect(r.output).toBe('hello world');
    expect(r.unresolved).toEqual([]);
  });

  it('tolerates whitespace inside braces', () => {
    expect(render('{{ name }}', { name: 'x' }).output).toBe('x');
    expect(render('{{  name  }}', { name: 'x' }).output).toBe('x');
  });

  it('leaves unresolved vars in place AND reports them', () => {
    const r = render('hi {{a}} {{b}}', { a: 'x' });
    expect(r.output).toBe('hi x {{b}}');
    expect(r.unresolved).toEqual(['b']);
  });

  it('coerces numbers and booleans to strings', () => {
    expect(render('{{n}}', { n: 42 }).output).toBe('42');
    expect(render('{{b}}', { b: true }).output).toBe('true');
  });

  it('substitutes the same var multiple times', () => {
    expect(render('{{x}}-{{x}}-{{x}}', { x: 'a' }).output).toBe('a-a-a');
  });

  // GH #4 (mutation finding): the {{var}} name charset is deliberately strict —
  // `[a-zA-Z_][a-zA-Z0-9_]*` — so a template can't reference dotted/hyphenated/leading-digit keys
  // (e.g. `{{a.b}}`, `{{../x}}`, path-like or prototype-walking names). Mutation testing showed the
  // regex can be loosened to admit `.`/`-`/leading-digit and every existing test still passes. These
  // pin the boundary: such tokens must be left LITERAL (not interpolated), even when vars would match.
  it('does NOT interpolate dotted/hyphenated/leading-digit names (injection-safety, #4)', () => {
    // A loosened regex would substitute these; the strict one leaves them untouched.
    const dotted = render('{{foo.bar}}', { 'foo.bar': 'INJECTED', foo: 'X' });
    expect(dotted.output).toBe('{{foo.bar}}');
    expect(dotted.unresolved).toEqual([]);   // no var matched at all

    expect(render('{{foo-bar}}', { 'foo-bar': 'INJECTED' }).output).toBe('{{foo-bar}}');
    expect(render('{{1foo}}', { '1foo': 'INJECTED' }).output).toBe('{{1foo}}');
    expect(render('{{a b}}', { 'a b': 'INJECTED' }).output).toBe('{{a b}}');
  });

  it('ignores malformed braces', () => {
    // Single braces shouldn't trigger substitution.
    expect(render('{name}', { name: 'x' }).output).toBe('{name}');
  });
});

describe('extractVarReferences', () => {
  it('returns unique sorted names', () => {
    expect(extractVarReferences('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });

  it('returns [] when no vars are referenced', () => {
    expect(extractVarReferences('no template vars')).toEqual([]);
  });

  // GH #4: same strict charset as render() — dotted/hyphenated/leading-digit tokens are not references.
  it('does not extract dotted/hyphenated/leading-digit tokens (#4)', () => {
    expect(extractVarReferences('{{a.b}} {{c-d}} {{1e}}')).toEqual([]);
  });
});

describe('validateHarnessName', () => {
  it('accepts well-formed kebab-case', () => {
    expect(validateHarnessName('my-bot').valid).toBe(true);
    expect(validateHarnessName('demo').valid).toBe(true);
    expect(validateHarnessName('a').valid).toBe(true);
  });

  it.each([
    ['', 'non-empty'],
    ['MyBot', 'kebab-case'],
    ['my_bot', 'kebab-case'],
    ['1bot', 'lowercase letter'],
    ['-bot', 'kebab-case'],
    ['my--bot', 'consecutive hyphens'],
    ['my-bot-', 'end with a hyphen'],
  ])('rejects %s', (name, reasonFragment) => {
    const r = validateHarnessName(name);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(new RegExp(reasonFragment));
  });

  it('rejects names longer than 214 chars (npm limit)', () => {
    const r = validateHarnessName('a' + 'b'.repeat(214));
    expect(r.valid).toBe(false);
  });
});
