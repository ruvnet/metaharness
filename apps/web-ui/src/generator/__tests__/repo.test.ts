import { describe, expect, it } from 'vitest';
import { analyzeFiles, parseGitHubUrl, planFromFiles, recommendPlan, planToConfig } from '../repo';
import { buildScaffold } from '../scaffold';
import type { RepoInput } from '../repo';

const rustRepo: RepoInput = {
  owner: 'ruvnet',
  repo: 'ruvector',
  files: {
    'README.md': 'ruvector is a Rust + WASM vector and agentic database. cargo build, clippy, wasm-pack. HNSW.',
    'Cargo.toml': '[package]\nname = "ruvector"\nedition = "2021"\n[dependencies]\nserde = "1"',
  },
};

const mcpRepo: RepoInput = {
  owner: 'acme',
  repo: 'tool-server',
  files: {
    'README.md': 'An MCP server exposing tools over stdio. Implements the model context protocol with resources and prompts.',
    'package.json': JSON.stringify({ name: 'tool-server', dependencies: { '@modelcontextprotocol/sdk': '1.0.0' }, scripts: { build: 'tsc', test: 'vitest' } }),
    '.mcp.json': '{}',
    '.codex/config.toml': '[mcp_servers.x]',
  },
};

describe('parseGitHubUrl', () => {
  it.each([
    ['https://github.com/ruvnet/ruflo', { owner: 'ruvnet', repo: 'ruflo' }],
    ['https://github.com/ruvnet/ruflo.git', { owner: 'ruvnet', repo: 'ruflo' }],
    ['git@github.com:org/proj.git', { owner: 'org', repo: 'proj' }],
    ['https://github.com/org/proj/tree/main', { owner: 'org', repo: 'proj' }],
  ])('%s', (url, expected) => {
    expect(parseGitHubUrl(url)).toEqual(expected);
  });
  it('rejects non-github urls', () => {
    expect(parseGitHubUrl('https://example.com/x/y')).toBeNull();
  });
});

describe('analyzeFiles', () => {
  it('detects rust + build/test commands', () => {
    const p = analyzeFiles(rustRepo);
    expect(p.languages).toContain('rust');
    expect(p.buildCommands).toContain('cargo build');
    expect(p.testCommands).toContain('cargo test');
  });
  it('detects mcp + codex host', () => {
    const p = analyzeFiles(mcpRepo);
    expect(p.hasMcp).toBe(true);
    expect(p.hasCodex).toBe(true);
    expect(p.languages).toContain('typescript');
  });
});

describe('recommendPlan', () => {
  it('routes a Rust crate to the rust-crate archetype + coding template', () => {
    const plan = recommendPlan(analyzeFiles(rustRepo));
    expect(plan.archetypeId).toBe('rust-crate-harness');
    expect(plan.template).toBe('vertical:coding');
    expect(plan.name).toBe('ruvector-harness');
    expect(plan.agents).toContain('architect');
  });

  it('routes an MCP server repo to the mcp-server archetype with remote MCP', () => {
    const plan = recommendPlan(analyzeFiles(mcpRepo));
    expect(plan.archetypeId).toBe('mcp-server-harness');
    expect(plan.mcp).toBe('remote');
    expect(plan.hosts).toContain('codex');
  });

  it('suggests commands but marks execution disabled', () => {
    const plan = recommendPlan(analyzeFiles(mcpRepo));
    expect(plan.suggestedCommands.every((c) => c.execution === 'disabled')).toBe(true);
    expect(plan.suggestedCommands.some((c) => c.command === 'npm test')).toBe(true);
  });
});

describe('determinism (acceptance test)', () => {
  it('same files -> same plan -> same zip-able file map', () => {
    const a = planFromFiles(rustRepo);
    const b = planFromFiles(rustRepo);
    expect(a.plan).toEqual(b.plan);
    // Same plan -> identical scaffold file map (byte-stable inputs to the zip).
    expect(buildScaffold(planToConfig(a.plan))).toEqual(buildScaffold(planToConfig(b.plan)));
  });

  it('planToConfig produces a buildable scaffold with the MCP surface', () => {
    const cfg = planToConfig(recommendPlan(analyzeFiles(mcpRepo)));
    const paths = buildScaffold(cfg).map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('src/mcp/server.ts'); // remote MCP archetype
    expect(paths).toContain('src/mcp/auth.ts');
  });
});
