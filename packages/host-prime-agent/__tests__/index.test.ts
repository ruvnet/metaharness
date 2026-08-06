// SPDX-License-Identifier: MIT
//
// @metaharness/host-prime-agent (ADR-242) contract tests, in the style of the
// iter-128 host-opencode suite. Covers the ADR-242 §Test Contract: frontmatter
// validity, completeness, golden file, fail-closed sandbox posture, no silent
// drops, autonomous projection — plus byte-determinism and Python shim
// structural validity.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  adapter,
  normalizeSkillName,
  skillMd,
  skillShimPy,
} from '../src/index.js';
import { defaultSpec, stableStringify } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'default-spec.json');
const RUNBOOK = 'install-prime-agent.md';

// python3 availability probe (test 8 py_compile is skipped without it).
let hasPython3 = false;
try {
  execFileSync('python3', ['--version'], { stdio: 'ignore' });
  hasPython3 = true;
} catch {
  hasPython3 = false;
}

/** Parse the YAML frontmatter of a generated SKILL.md (flat scalar form). */
function frontmatter(md: string): { name: string; description: string } {
  const m = md.match(/^---\nname: (.+)\ndescription: "((?:[^"\\]|\\.)*)"\n---\n/);
  expect(m, 'SKILL.md must open with name+description frontmatter').not.toBeNull();
  return { name: m![1]!, description: m![2]! };
}

describe('@metaharness/host-prime-agent (ADR-242)', () => {
  // Contract 1 (task) — identity.
  it('HOST_NAME is "prime-agent"', () => {
    expect(HOST_NAME).toBe('prime-agent');
    expect(adapter.name).toBe('prime-agent');
  });

  // ADR-242 test contract 1 — frontmatter validity + deterministic
  // normalization of charset-violating tool names.
  it('every SKILL.md frontmatter name matches ^[a-z0-9-]+$ and description ≤ 1024', () => {
    const longDescription = 'x'.repeat(1500);
    const spec = {
      name: 'weird',
      tools: [
        { name: 'My_Weird Tool!', description: longDescription },
        { name: 'ok-tool', description: 'A well-behaved tool.' },
      ],
    };
    const out = adapter.generateConfig(spec as any);
    const skillMds = Object.entries(out).filter(([k]) =>
      /^\.prime\/agent\/skills\/[^/]+\/SKILL\.md$/.test(k),
    );
    expect(skillMds).toHaveLength(2);
    for (const [, content] of skillMds) {
      const fm = frontmatter(content);
      expect(fm.name).toMatch(/^[a-z0-9-]+$/);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    }
    // Deterministic normalization of the charset-violating name.
    expect(normalizeSkillName('My_Weird Tool!')).toBe('my-weird-tool');
    expect(out['.prime/agent/skills/my-weird-tool/SKILL.md']).toBeDefined();
    // >1024-char description is truncated to exactly 1024.
    const fm = frontmatter(out['.prime/agent/skills/my-weird-tool/SKILL.md']!);
    expect(fm.description).toBe('x'.repeat(1024));
  });

  // ADR-242 test contract 2 — completeness: exactly one skill trio per tool.
  it('emits exactly one SKILL.md + pyproject.toml + src/<pkg>/__init__.py trio per tool', () => {
    const out = adapter.generateConfig(defaultSpec);
    const tools = defaultSpec.tools!;
    for (const t of tools) {
      const name = normalizeSkillName(t.name);
      const pkg = name.replace(/-/g, '_');
      expect(out[`.prime/agent/skills/${name}/SKILL.md`]).toBeDefined();
      expect(out[`.prime/agent/skills/${name}/pyproject.toml`]).toBeDefined();
      expect(out[`.prime/agent/skills/${name}/src/${pkg}/__init__.py`]).toBeDefined();
    }
    // Exactly one trio per tool — no extra skill-directory files besides the
    // supplemental prompt.
    const skillFiles = Object.keys(out).filter(
      (k) => k.startsWith('.prime/agent/skills/') && k !== '.prime/agent/skills/harness-prompt.md',
    );
    expect(skillFiles).toHaveLength(tools.length * 3);
  });

  // ADR-242 test contract 3 — golden file, byte-for-byte.
  it('generateConfig(defaultSpec) matches the committed golden byte-for-byte', () => {
    const config = adapter.generateConfig(defaultSpec);
    const raw = readFileSync(GOLDEN, 'utf8');
    expect(JSON.parse(raw)).toEqual(config);
    expect(raw).toBe(stableStringify(config) + '\n');
  });

  // ADR-242 test contract 4 — fail-closed sandbox posture.
  it('non-empty permissions.deny emits SANDBOX-REQUIRED.md naming every deny entry', () => {
    const out = adapter.generateConfig(defaultSpec);
    const sandbox = out['SANDBOX-REQUIRED.md'];
    expect(sandbox).toBeDefined();
    for (const d of defaultSpec.permissions!.deny!) {
      expect(sandbox).toContain(`\`${d}\``);
    }
  });

  it('non-empty deny: the install runbook OPENS with the sandbox warning', () => {
    const out = adapter.generateConfig(defaultSpec);
    const md = out[RUNBOOK]!;
    const warningAt = md.indexOf('SANDBOX REQUIRED');
    const firstSectionAt = md.indexOf('## Install Prime Agent');
    expect(warningAt).toBeGreaterThan(-1);
    expect(firstSectionAt).toBeGreaterThan(-1);
    expect(warningAt).toBeLessThan(firstSectionAt); // warning precedes all sections
    for (const d of defaultSpec.permissions!.deny!) {
      expect(md).toContain(`\`${d}\``);
    }
  });

  it('empty/absent deny: no SANDBOX-REQUIRED.md and no warning in the runbook', () => {
    for (const permissions of [undefined, { allow: [] }, { allow: [], deny: [] }]) {
      const spec = { ...defaultSpec, permissions } as any;
      const out = adapter.generateConfig(spec);
      expect(Object.keys(out)).not.toContain('SANDBOX-REQUIRED.md');
      expect(out[RUNBOOK]).not.toContain('SANDBOX');
    }
  });

  // ADR-242 test contract 5 — no silent drops: every MCP server is explicitly
  // listed in the runbook as unavailable as MCP on this host.
  it('every mcpServers entry is listed in the runbook as not emitted as MCP', () => {
    const spec = {
      ...defaultSpec,
      mcpServers: [
        ...defaultSpec.mcpServers!,
        { name: 'remote-search', url: 'https://example.com/mcp' },
      ],
    };
    const out = adapter.generateConfig(spec as any);
    const md = out[RUNBOOK]!;
    expect(md).toContain('no MCP support');
    expect(md).toContain('- `codeindex` — not emitted as MCP');
    expect(md).toContain('- `remote-search` — not emitted as MCP');
    expect(md).toContain('remote server, unavailable on this host');
  });

  // ADR-242 test contract 6 (+ task case 7) — autonomous projection.
  it('projects the ADR-241 autonomous block into the exact invocation snippet', () => {
    const spec = { ...defaultSpec } as any;
    spec.autonomous = {
      goal: { text: 'ship it', tokenBudget: 200000 },
      gateCommand: 'npm run check',
      maxTurns: 20,
    };
    const md = adapter.generateConfig(spec)[RUNBOOK]!;
    expect(md).toContain('--autonomous-gate "npm run check"');
    expect(md).toContain('--autonomous-max-turns 20');
    expect(md).toContain(
      'prime-agent --autonomous --autonomous-gate "npm run check" --autonomous-max-turns 20 "ship it"',
    );
    expect(md).toContain('/goal --budget 200000');
  });

  it('without the autonomous block, no "--autonomous" string appears anywhere', () => {
    const out = adapter.generateConfig(defaultSpec);
    for (const [key, content] of Object.entries(out)) {
      expect(content, `unexpected autonomous flag in ${key}`).not.toContain('--autonomous');
    }
  });

  // Task case 6 — byte-determinism (witness-stable ADR-011; golden-file
  // determinism gate for the first Python codegen path).
  it('generateConfig is byte-deterministic per key across calls', () => {
    const first = adapter.generateConfig(defaultSpec);
    const second = adapter.generateConfig(defaultSpec);
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
    for (const [key, content] of Object.entries(first)) {
      expect(second[key], `non-deterministic content for ${key}`).toBe(content);
    }
  });

  // Task case 8 — Python shim structural validity.
  it('the shim defines run(**kwargs) and imports no network modules', () => {
    for (const tool of defaultSpec.tools!) {
      const py = skillShimPy(tool);
      expect(py).toContain('def run(');
      expect(py).not.toContain('import requests');
      expect(py).not.toContain('import urllib');
      expect(py).not.toContain('import socket');
      expect(py).not.toContain('import http');
      expect(py).toContain(`TOOL_NAME = ${JSON.stringify(tool.name)}`);
    }
  });

  it.skipIf(!hasPython3)('the shim py_compiles cleanly under python3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-agent-shim-'));
    try {
      for (const tool of defaultSpec.tools!) {
        const file = join(dir, `${normalizeSkillName(tool.name).replace(/-/g, '_')}.py`);
        writeFileSync(file, skillShimPy(tool));
        expect(() =>
          execFileSync('python3', ['-m', 'py_compile', file], { stdio: 'pipe' }),
        ).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Supporting check — allow entries are projected into SKILL.md (ADR-242
  // §2.2: model-facing surface documents intended scope).
  it('permissions.allow entries are projected into each SKILL.md', () => {
    const md = skillMd(defaultSpec.tools![0]!, defaultSpec);
    expect(md).toContain('## Intended scope');
    expect(md).toContain('- `Bash(npm run:*)`');
  });
});

// Regressions from the P1 adversarial verify round (loop directive P1).
describe('adversarial-verify regressions', () => {
  it('colliding normalized names get deterministic -2 suffixes, nothing overwritten', () => {
    const spec = {
      name: 'collide',
      tools: [
        { name: 'Run Tests', description: 'FIRST' },
        { name: 'run_tests', description: 'SECOND' },
        { name: 'run-tests', description: 'THIRD' },
      ],
      agents: [{ name: 'Helper!' }, { name: 'helper' }],
    };
    const out = adapter.generateConfig(spec);
    const skillDirs = Object.keys(out).filter((k) => k.endsWith('/SKILL.md'));
    expect(skillDirs).toEqual([
      '.prime/agent/skills/run-tests/SKILL.md',
      '.prime/agent/skills/run-tests-2/SKILL.md',
      '.prime/agent/skills/run-tests-3/SKILL.md',
    ]);
    expect(out['.prime/agent/skills/run-tests/SKILL.md']).toContain('FIRST');
    expect(out['.prime/agent/skills/run-tests-2/SKILL.md']).toContain('SECOND');
    expect(out['.prime/agent/skills/run-tests-3/SKILL.md']).toContain('THIRD');
    // The -2 shim imports a matching disambiguated Python package.
    expect(out['.prime/agent/skills/run-tests-2/src/run_tests_2/__init__.py']).toBeDefined();
    expect(Object.keys(out).filter((k) => k.startsWith('.prime/agent/agents/'))).toEqual([
      '.prime/agent/agents/helper.md',
      '.prime/agent/agents/helper-2.md',
    ]);
    // Determinism holds across calls.
    expect(adapter.generateConfig(spec)).toEqual(out);
  });

  it('hooks and statusLine are named as unsupported, never silently ignored', () => {
    const spec = {
      name: 'hooked',
      tools: [],
      hooks: [{ event: 'PostToolUse', command: 'npm run lint' }],
      statusLine: 'harness: {model}',
    };
    const runbook = adapter.generateConfig(spec)[RUNBOOK]!;
    expect(runbook).toContain('## Unsupported on this host');
    expect(runbook).toContain('`hooks`');
    expect(runbook).toContain('`statusLine`');
    // Absent both → no unsupported section at all.
    const clean = adapter.generateConfig({ name: 'clean', tools: [] })[RUNBOOK]!;
    expect(clean).not.toContain('## Unsupported on this host');
  });

  it('autonomous projection never fabricates values for absent optionals', () => {
    const spec = {
      name: 'auto-partial',
      tools: [],
      autonomous: { goal: { text: 'ship' } },
    };
    const runbook = adapter.generateConfig(spec)[RUNBOOK]!;
    expect(runbook).toContain('prime-agent --autonomous "ship"');
    expect(runbook).not.toContain('--autonomous-gate ""');
    expect(runbook).not.toContain('--autonomous-max-turns 0');
    expect(runbook).not.toContain('/goal --budget 0');
  });

  it('autonomous.heartbeat cadence + instruction are projected', () => {
    const spec = {
      name: 'auto-hb',
      tools: [],
      autonomous: { heartbeat: { cadence: 'every 30m', instruction: 'check CI status' } },
    };
    const runbook = adapter.generateConfig(spec)[RUNBOOK]!;
    expect(runbook).toContain('every 30m');
    expect(runbook).toContain('check CI status');
  });

  it('1024-char truncation never splits a surrogate pair', () => {
    const description = 'x'.repeat(1023) + '\u{1F600}' + 'tail';
    const spec = { name: 's', tools: [{ name: 'emoji', description }] };
    const md = adapter.generateConfig(spec)['.prime/agent/skills/emoji/SKILL.md']!;
    const fm = frontmatter(md);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
    // No lone surrogate anywhere in the emitted file.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(md)).toBe(false);
  });
});
