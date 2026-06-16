// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { scrubHermesBlocks, optionalMcpYaml, cliConfigYaml } from '../src/index.js';

describe('@metaharness/host-hermes — Hermes-4 quirk handling', () => {
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

  // ADR-046 — verified against the authoritative hermes cli-config.yaml.example.
  describe('cliConfigYaml', () => {
    it('emits the real hermes schema: model + agent.personalities (no invented keys)', () => {
      const c = cliConfigYaml({ name: 'h', systemPrompt: 'Be terse.' } as any);
      expect(c).toContain('model:');
      expect(c).toContain('provider: "auto"');
      expect(c).toContain('agent:');
      expect(c).toContain('personalities:');
      expect(c).toContain('h: "Be terse."'); // harness identity → default personality
      // The previously-invented keys are NOT in the real hermes schema.
      expect(c).not.toContain('scrub_think_blocks');
      expect(c).not.toContain('system_prompt:');
      expect(c).not.toMatch(/^name:/m);
    });

    it('maps each agent to a named personality', () => {
      const c = cliConfigYaml({
        name: 'h',
        agents: [{ name: 'reviewer', systemPrompt: 'Review code.' }, { name: 'tester', systemPrompt: 'Write tests.' }],
      } as any);
      expect(c).toContain('reviewer: "Review code."');
      expect(c).toContain('tester: "Write tests."');
    });
  });

  // CodeQL js/polynomial-redos regression (alert #1, fixed iter 138).
  describe('ReDoS hardening', () => {
    it('handles a pathological UNCLOSED <think> in linear time', () => {
      // The old lazy pattern `<think>[\s\S]*?</think>` was O(n²) here: it
      // scanned to EOF then backtracked at every position for the missing
      // close tag. The tempered-greedy rewrite is linear.
      const evil = '<think>' + 'a'.repeat(200000); // no closing tag
      const start = Date.now();
      const out = scrubHermesBlocks(evil);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
      // Unclosed tag doesn't match -> left in place (don't silently drop).
      expect(out).toBe(evil);
    });

    it('still strips a well-formed block after a long prefix (linear)', () => {
      const big = 'x'.repeat(200000);
      const out = scrubHermesBlocks(`${big}<think>drop</think>${big}`);
      expect(out).toBe(big + big);
    });

    it('strips only up to the FIRST close tag (tempered token correctness)', () => {
      const out = scrubHermesBlocks('a<think>one</think>b<think>two</think>c');
      expect(out).toBe('abc');
    });
  });
});
