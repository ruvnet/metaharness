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

    // Regression: env var names land in a YAML *key* position, not a value
    // position — unlike env values (already JSON-escaped), the key itself
    // was previously interpolated bare.
    it('leaves a conventional env var name unquoted', () => {
      const y = optionalMcpYaml({
        name: 'demo',
        command: ['npx', 'demo'],
        env: [['API_KEY', 'secret']],
      });
      expect(y).toContain('API_KEY: "secret"');
    });

    it('escapes an env var name containing a YAML-significant character as a mapping key', () => {
      const y = optionalMcpYaml({
        name: 'demo',
        command: ['npx', 'demo'],
        env: [['weird:key', 'value']],
      });
      expect(y).toContain('"weird:key": "value"');
      // The old unquoted form would have produced a second, spurious
      // top-level `:` on the same line — no longer present.
      expect(y).not.toMatch(/^  weird:key:/m);
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

    it('leaves conventional kebab/snake-case names unquoted (no unnecessary re-quoting)', () => {
      const c = cliConfigYaml({
        name: 'my-harness',
        agents: [{ name: 'code_reviewer', systemPrompt: 'x' }],
      } as any);
      expect(c).toContain('my-harness: ');
      expect(c).not.toContain('"my-harness"');
      expect(c).toContain('code_reviewer: "x"');
    });

    // Regression: `spec.name`/`AgentSpec.name` land in a YAML *key* position
    // (`agent.personalities.<name>`) but were previously interpolated bare.
    // A name containing `:` (unconstrained at the kernel type level — see
    // packages/kernel-js/src/types.ts, AgentSpec.name is a plain `string`)
    // silently corrupted the document: the personality's own colon plus the
    // name's embedded colon produced two top-level `:` on one line, which
    // either breaks parsing or smuggles a bogus second key depending on the
    // parser. This is a real, reachable defect — harness/agent names can
    // originate outside @metaharness/sdk's kebab-case-enforcing
    // `defineHarness`/`defineAgent` (e.g. hand-authored or generated
    // HarnessSpec JSON), so the kernel type does not guarantee safety.
    it('escapes a harness/agent name containing YAML-significant characters as a mapping key', () => {
      const c = cliConfigYaml({
        name: 'h',
        agents: [{ name: 'evil: agent', systemPrompt: 'x' }],
      } as any);
      expect(c).toContain('"evil: agent": "x"');
      // The old unquoted form: `    evil: agent: "x"` — two top-level `:`.
      expect(c).not.toMatch(/^ {4}evil: agent:/m);
    });

    it('escapes the top-level harness name the same way when it needs quoting', () => {
      const c = cliConfigYaml({ name: 'weird#name', systemPrompt: 'x' } as any);
      expect(c).toContain('"weird#name": "x"');
    });

    // Adversarial-critique finding: a bare name matching the identifier
    // regex can still be a YAML 1.1 reserved scalar (PyYAML-family loaders,
    // which is what Hermes-agent uses, resolve bare `true`/`null`/digits to
    // bool/null/int, not string) — a silent semantic mistype, not a syntax
    // break, but no less real. Must stay quoted even though it "looks safe".
    it('quotes an agent name that is a YAML-reserved bare scalar even though it matches the identifier shape', () => {
      const c = cliConfigYaml({
        name: 'h',
        agents: [
          { name: 'true', systemPrompt: 'a' },
          { name: 'null', systemPrompt: 'b' },
          { name: '123', systemPrompt: 'c' },
        ],
      } as any);
      expect(c).toContain('"true": "a"');
      expect(c).toContain('"null": "b"');
      expect(c).toContain('"123": "c"');
      expect(c).not.toMatch(/^ {4}true:/m);
      expect(c).not.toMatch(/^ {4}null:/m);
      expect(c).not.toMatch(/^ {4}123:/m);
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
