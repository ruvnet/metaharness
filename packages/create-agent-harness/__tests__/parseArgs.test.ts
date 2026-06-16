// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/index.js';

describe('parseArgs', () => {
  it('parses a bare name', () => {
    expect(parseArgs(['my-bot'])).toEqual({ name: 'my-bot' });
  });

  it('parses --template / -t', () => {
    expect(parseArgs(['x', '--template', 'minimal'])).toEqual({
      name: 'x', template: 'minimal',
    });
    expect(parseArgs(['x', '-t', 'minimal'])).toEqual({
      name: 'x', template: 'minimal',
    });
  });

  it('parses --host (repeatable)', () => {
    const r = parseArgs(['x', '--host', 'claude-code', '--host', 'codex']);
    expect(r.name).toBe('x');
    expect(r.hosts).toEqual(['claude-code', 'codex']);
  });

  it('parses --yes / -y', () => {
    expect(parseArgs(['x', '-y']).yes).toBe(true);
    expect(parseArgs(['x', '--yes']).yes).toBe(true);
  });

  it('treats subsequent positional args as ignored (name is sticky)', () => {
    expect(parseArgs(['x', 'y']).name).toBe('x');
  });

  it('returns empty CLI args for empty input', () => {
    expect(parseArgs([])).toEqual({});
  });

  // GH issue #9: --target must be parsed (was silently ignored).
  it('parses --target <path>', () => {
    const r = parseArgs(['my-bot', '--target', '/tmp/where/i/want/it']);
    expect(r.name).toBe('my-bot');
    expect(r.target).toBe('/tmp/where/i/want/it');
  });

  it('--target does not get swallowed as the name', () => {
    const r = parseArgs(['my-bot', '--host', 'codex', '--target', './out']);
    expect(r.name).toBe('my-bot');
    expect(r.target).toBe('./out');
    expect(r.hosts).toEqual(['codex']);
  });
});
