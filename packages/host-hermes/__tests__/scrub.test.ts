// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { scrubHermesBlocks, optionalMcpYaml, cliConfigYaml } from '../src/index.js';

describe('@ruflo/host-hermes — Hermes-4 quirk handling', () => {
  describe('scrubHermesBlocks', () => {
    it('strips well-formed <think>...</think>', () => {
      const r = scrubHermesBlocks('keep me <think>drop me</think> keep me too');
      expect(r).toBe('keep me  keep me too');
    });

    it('strips stray <tool_call>...</tool_call> (Hermes #741 quirk)', () => {
      const r = scrubHermesBlocks(
        'answer: 42 <tool_call>{"name":"x","arguments":{}}</tool_call> done',
      );
      expect(r).toBe('answer: 42  done');
    });

    it('strips <thinking> and <reasoning> (extended-thinking variants)', () => {
      expect(scrubHermesBlocks('a <thinking>b</thinking> c')).toBe('a  c');
      expect(scrubHermesBlocks('a <reasoning>b</reasoning> c')).toBe('a  c');
    });

    it('leaves prose mentioning the tag names alone', () => {
      // No paired tags -> nothing to strip.
      const r = scrubHermesBlocks('We can use the <think> tag to express reasoning.');
      expect(r).toBe('We can use the <think> tag to express reasoning.');
    });

    it('handles non-string input by returning it unchanged', () => {
      // Type-casted: realistic at the boundary between providers and our code.
      expect(scrubHermesBlocks(null as unknown as string)).toBe(null);
    });

    it('handles strings with no < at all by short-circuiting', () => {
      expect(scrubHermesBlocks('no tags here')).toBe('no tags here');
    });
  });

  describe('optionalMcpYaml', () => {
    it('emits name + command + args', () => {
      const y = optionalMcpYaml({
        name: 'demo',
        command: ['npx', '-y', 'demo'],
      });
      expect(y).toContain('name: demo');
      expect(y).toContain('command: npx');
      expect(y).toMatch(/args:[\s\S]*"-y"[\s\S]*"demo"/);
    });

    it('emits url for streamable-HTTP servers', () => {
      const y = optionalMcpYaml({
        name: 'remote',
        url: 'https://example.com/mcp',
      });
      expect(y).toContain('url: https://example.com/mcp');
    });
  });

  describe('cliConfigYaml', () => {
    it('sets both scrub flags to true (per issue #741)', () => {
      const c = cliConfigYaml({ name: 'h' });
      expect(c).toContain('scrub_think_blocks: true');
      expect(c).toContain('scrub_stray_tool_calls: true');
    });
  });
});
