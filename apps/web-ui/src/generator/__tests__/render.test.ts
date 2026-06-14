import { describe, expect, it } from 'vitest';
import { render, validateHarnessName, toPascalCase, toKebabCase, extractVarReferences } from '../render';

describe('render', () => {
  it('substitutes flat vars', () => {
    expect(render('hi {{name}}', { name: 'x' }).output).toBe('hi x');
  });
  it('tolerates whitespace inside braces', () => {
    expect(render('{{  name  }}', { name: 'y' }).output).toBe('y');
  });
  it('leaves unresolved vars in place and reports them', () => {
    const r = render('{{a}} {{b}}', { a: '1' });
    expect(r.output).toBe('1 {{b}}');
    expect(r.unresolved).toEqual(['b']);
  });
  it('extracts var references sorted + unique', () => {
    expect(extractVarReferences('{{b}}{{a}}{{a}}')).toEqual(['a', 'b']);
  });
});

describe('validateHarnessName', () => {
  it.each([
    ['legal-redline', true],
    ['a', true],
    ['', false],
    ['Bad', false],
    ['1lead', false],
    ['double--hyphen', false],
    ['trailing-', false],
  ])('%s -> %s', (name, valid) => {
    expect(validateHarnessName(name).valid).toBe(valid);
  });
});

describe('case helpers', () => {
  it('toPascalCase', () => {
    expect(toPascalCase('runbook-runner')).toBe('RunbookRunner');
    expect(toPascalCase('my agent_name')).toBe('MyAgentName');
  });
  it('toKebabCase', () => {
    expect(toKebabCase('My Cool Agent!')).toBe('my-cool-agent');
    expect(toKebabCase('already-kebab')).toBe('already-kebab');
  });
});
