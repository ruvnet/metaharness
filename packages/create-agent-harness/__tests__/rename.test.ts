// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { renameIdentifiers, renameFileMap } from '../src/rename.js';

describe('renameIdentifiers', () => {
  it('renames simple identifier', () => {
    expect(renameIdentifiers('const oldName = 1;', [{ from: 'oldName', to: 'newName' }]))
      .toBe('const newName = 1;');
  });

  it('preserves partial-word matches (does not rename `oldNameXY`)', () => {
    expect(renameIdentifiers('const oldNameXY = 1;', [{ from: 'oldName', to: 'newName' }]))
      .toBe('const oldNameXY = 1;');
  });

  it('preserves property-access on the LEFT of a dot', () => {
    expect(renameIdentifiers('obj.oldName.foo', [{ from: 'oldName', to: 'newName' }]))
      .toBe('obj.oldName.foo');
  });

  it('does rename inside string literals (intentional)', () => {
    expect(renameIdentifiers('"this is oldName"', [{ from: 'oldName', to: 'newName' }]))
      .toBe('"this is newName"');
  });

  it('renames multiple occurrences', () => {
    expect(renameIdentifiers('oldName + oldName', [{ from: 'oldName', to: 'newName' }]))
      .toBe('newName + newName');
  });

  it('applies multiple rules in order', () => {
    expect(renameIdentifiers('a + b', [
      { from: 'a', to: 'x' },
      { from: 'b', to: 'y' },
    ])).toBe('x + y');
  });

  it('handles a rule chain (a -> b -> c) by applying rules in order', () => {
    // After step 1 a -> b; after step 2 b -> c. So a ends up as c.
    expect(renameIdentifiers('a + a', [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ])).toBe('c + c');
  });

  it('rejects invalid from identifier', () => {
    expect(() => renameIdentifiers('x', [{ from: '1bad', to: 'good' }])).toThrow();
  });

  it('rejects invalid to identifier', () => {
    expect(() => renameIdentifiers('x', [{ from: 'good', to: '1bad' }])).toThrow();
  });

  it('handles $ and _ in identifier names', () => {
    expect(renameIdentifiers('const _foo$ = 1;', [{ from: '_foo$', to: 'bar' }]))
      .toBe('const bar = 1;');
  });

  it('returns input unchanged when no matches', () => {
    expect(renameIdentifiers('untouched', [{ from: 'absent', to: 'present' }]))
      .toBe('untouched');
  });

  it('preserves word boundary at end of string', () => {
    expect(renameIdentifiers('oldName', [{ from: 'oldName', to: 'newName' }]))
      .toBe('newName');
  });

  it('preserves word boundary at start of string', () => {
    expect(renameIdentifiers('oldName.foo', [{ from: 'oldName', to: 'newName' }]))
      .toBe('newName.foo');
  });
});

describe('renameFileMap', () => {
  it('applies rules to every file', () => {
    const files = {
      'a.ts': 'const oldName = 1;',
      'b.ts': 'oldName + 2',
    };
    const out = renameFileMap(files, [{ from: 'oldName', to: 'newName' }]);
    expect(out['a.ts']).toBe('const newName = 1;');
    expect(out['b.ts']).toBe('newName + 2');
  });

  it('does not mutate input map', () => {
    const files = { 'a.ts': 'oldName' };
    renameFileMap(files, [{ from: 'oldName', to: 'newName' }]);
    expect(files['a.ts']).toBe('oldName');
  });
});
