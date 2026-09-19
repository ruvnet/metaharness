// SPDX-License-Identifier: MIT
//
// @metaharness/host-grok (ADR-280) contract tests, in the style of the
// host-prime-agent (ADR-247) suite: identity, TOML escaping and strict
// parsing, server-name admission, [permission] pass-through, hook mapping,
// instructions/agents/skills, the fail-closed trust banner, autonomous
// projection, golden file and determinism.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_NAME,
  INSTALL_MD,
  CONFIG_TOML,
  GROK_HOOK_EVENTS,
  adapter,
  configToml,
  grokMatcher,
  hookHandlerFor,
  hooksJson,
  normalizeServerName,
  normalizeSkillName,
  permissionToml,
  serverToToml,
  tomlKey,
  tomlString,
} from '../src/index.js';
import { defaultSpec, stableStringify } from './fixtures.js';
// ADR-027 parity: the CLI scaffold's host-config.ts is dependency-free, so the
// adapter test can import it and compare bytes.
import { hostConfigFiles } from '../../create-agent-harness/src/host-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'default-spec.json');

// Strict TOML 1.0 parser without a new dependency: Python >= 3.11 stdlib
// `tomllib`. Tests that need it skip when it is unavailable.
let hasTomllib = false;
try {
  execFileSync('python3', ['-c', 'import tomllib'], { stdio: 'ignore' });
  hasTomllib = true;
} catch {
  hasTomllib = false;
}
function parseToml(src: string): any {
  const out = execFileSync(
    'python3',
    ['-c', 'import json,sys,tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))'],
    { input: src, encoding: 'utf-8' },
  );
  return JSON.parse(out);
}

const gen = (spec: object) => adapter.generateConfig(spec as any);

describe('@metaharness/host-grok (ADR-280)', () => {
  it('HOST_NAME is "grok"', () => {
    expect(HOST_NAME).toBe('grok');
    expect(adapter.name).toBe('grok');
  });

  describe('TOML rendering', () => {
    it('tomlString escapes quote, backslash, control characters, DEL and lone surrogates', () => {
      expect(tomlString('plain')).toBe('"plain"');
      expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
      expect(tomlString('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
      expect(tomlString('\u0000\u001f\u007f')).toBe('"\\u0000\\u001F\\u007F"');
      expect(tomlString('x\ud800y')).toBe('"x\\uFFFDy"');
      expect(tomlString('é 😀')).toBe('"é 😀"'); // non-ASCII passes through
    });

    it('tomlKey is bare only for [A-Za-z0-9_-]+', () => {
      expect(tomlKey('LOG_LEVEL')).toBe('LOG_LEVEL');
      expect(tomlKey('demo-bot')).toBe('demo-bot');
      expect(tomlKey('a.b')).toBe('"a.b"');
      expect(tomlKey('')).toBe('""');
    });

    it('stdio server: command + args + enabled, env as a sub-table, no type key', () => {
      const t = serverToToml({ name: 'demo', command: ['npx', '-y', 'demo@latest'], env: [['LOG_LEVEL', 'info']] })!;
      expect(t).toBe([
        '[mcp_servers.demo]',
        'command = "npx"',
        'args = ["-y", "demo@latest"]',
        'enabled = true',
        '',
        '[mcp_servers.demo.env]',
        'LOG_LEVEL = "info"',
      ].join('\n'));
      expect(t).not.toMatch(/^type =/m);
    });

    it('remote server: url + enabled and NO type key (Grok infers http from url)', () => {
      const t = serverToToml({ name: 'remote', url: 'https://example.com/mcp' })!;
      expect(t).toBe('[mcp_servers.remote]\nurl = "https://example.com/mcp"\nenabled = true');
    });

    it('a server with neither command nor url is not emitted (Grok drops it) and the runbook names it', () => {
      expect(serverToToml({ name: 'ghost' })).toBeNull();
      const out = gen({ name: 'h', mcpServers: [{ name: 'ghost' }] });
      expect(out[CONFIG_TOML]).not.toContain('ghost');
      expect(out[INSTALL_MD]).toMatch(/Not emitted[\s\S]*`ghost`/);
    });

    it('repeated env keys keep the last value (a duplicate TOML key would be a parse error)', () => {
      const t = serverToToml({ name: 's', command: ['x'], env: [['A', '1'], ['A', '2']] })!;
      expect(t.match(/^A = /gm)).toHaveLength(1);
      expect(t).toContain('A = "2"');
    });

    it('configToml has no `type =` line and ends with a newline', () => {
      const t = configToml(defaultSpec);
      expect(t).not.toMatch(/^type\s*=/m);
      expect(t.endsWith('\n')).toBe(true);
    });

    it.skipIf(!hasTomllib)('the golden spec config parses under a strict TOML 1.0 parser with the expected structure', () => {
      const parsed = parseToml(configToml(defaultSpec));
      expect(parsed).toEqual({
        mcp_servers: {
          codeindex: { command: 'node', args: ['./dist/mcp-server.js'], enabled: true, env: { LOG_LEVEL: 'info' } },
          remote: { url: 'https://example.com/mcp', enabled: true },
        },
        permission: {
          allow: ['mcp__codeindex__*', 'Bash(npm run:*)'],
          deny: ['Read(./.env)', 'Bash(rm:*)', 'Bash(git push:*)'],
        },
      });
    });

    // ADR-046 lesson: adversarial input must not inject a second table or key.
    it.skipIf(!hasTomllib)('adversarial names, args, env keys and values cannot inject TOML structure', () => {
      const evil = 'x]\n[evil]\nkey = "pwned"';
      const spec = {
        name: 'harness\n[injected]',
        mcpServers: [{
          name: evil,
          command: ['node', 'a"b\\c', 'line\nbreak', '\u0000nul', 'lone\ud800'],
          env: [['KEY.WITH.DOTS', 'v"\n[x]'], ['NORMAL', '${SECRET}']],
        }],
        permissions: { allow: ['Bash(echo "hi")'], deny: ['Read(./.env)\n[permission2]'] },
      };
      const src = configToml(spec as any);
      const parsed = parseToml(src);
      expect(Object.keys(parsed).sort()).toEqual(['mcp_servers', 'permission']);
      const servers = Object.keys(parsed.mcp_servers);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
      const srv = parsed.mcp_servers[servers[0]!];
      expect(srv.args).toEqual(['a"b\\c', 'line\nbreak', '\u0000nul', 'lone\ufffd']);
      expect(srv.env).toEqual({ 'KEY.WITH.DOTS': 'v"\n[x]', NORMAL: '${SECRET}' });
      expect(parsed.permission.deny).toEqual(['Read(./.env)\n[permission2]']);
      expect(src.split('\n')[0]).toBe('# harness [injected] — Grok Build project config (metaharness host: grok, ADR-280).');
    });
  });

  describe('server names (Grok tool-catalog admission)', () => {
    it('normalizes to [A-Za-z0-9_-], no `__`, no leading digit/hyphen, no trailing `_`, ≤ 64', () => {
      expect(normalizeServerName('demo-bot')).toBe('demo-bot');
      expect(normalizeServerName('code_index')).toBe('code_index');
      expect(normalizeServerName('dotted.name')).toBe('dotted-name');
      expect(normalizeServerName('has space')).toBe('has-space');
      expect(normalizeServerName('1digit')).toBe('mcp-1digit');
      expect(normalizeServerName('trailing_')).toBe('trailing');
      expect(normalizeServerName('a__b')).toBe('a_b');
      expect(normalizeServerName('-lead')).toBe('lead');
      expect(normalizeServerName('_under')).toBe('_under');
      expect(normalizeServerName('!!!')).toBe('mcp');
      expect(normalizeServerName('a'.repeat(100))).toBe('a'.repeat(64));
      for (const n of ['x]\n[evil]', 'a..b', '../../etc']) {
        expect(normalizeServerName(n)).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
        expect(normalizeServerName(n)).not.toMatch(/__|_$/);
      }
    });

    it('colliding normalized names get deterministic -2/-3 suffixes and the runbook lists the renames', () => {
      const out = gen({
        name: 'h',
        mcpServers: [
          { name: 'my.server', command: ['a'] },
          { name: 'my server', command: ['b'] },
          { name: 'my-server', command: ['c'] },
        ],
      });
      const toml = out[CONFIG_TOML]!;
      expect(toml).toContain('[mcp_servers.my-server]\ncommand = "a"');
      expect(toml).toContain('[mcp_servers.my-server-2]\ncommand = "b"');
      expect(toml).toContain('[mcp_servers.my-server-3]\ncommand = "c"');
      expect(out[INSTALL_MD]).toContain('`my.server` → `my-server`');
      expect(out[INSTALL_MD]).toContain('`my server` → `my-server-2`');
    });
  });

  describe('[permission]', () => {
    it('allow and deny pass through verbatim, one rule per line', () => {
      expect(permissionToml({ allow: ['Bash(npm run:*)'], deny: ['Bash(rm:*)'] })).toBe(
        '[permission]\nallow = [\n  "Bash(npm run:*)",\n]\ndeny = [\n  "Bash(rm:*)",\n]',
      );
    });

    it('no rules → no table; deny-only → only deny', () => {
      expect(permissionToml(undefined)).toBeNull();
      expect(permissionToml({ allow: [], deny: [] })).toBeNull();
      const t = permissionToml({ deny: ['Write(*)'] })!;
      expect(t).toContain('deny = [');
      expect(t).not.toContain('allow');
      expect(configToml({ name: 'bare' })).not.toContain('[permission]');
    });

    it('rules outside Grok\'s vocabulary are named in the runbook (grok 1.0.34 drops them silently)', () => {
      const md = gen({ name: 'h', permissions: { allow: ['Task(*)'], deny: ['Bash(rm:*)', 'MultiEdit(*)', 'Agent(explore)'] } })[INSTALL_MD]!;
      const section = md.slice(md.indexOf('## 4.'));
      for (const r of ['Task(*)', 'MultiEdit(*)', 'Agent(explore)']) expect(section).toContain(`\`${r}\``);
      expect(section).toMatch(/outside Grok's rule vocabulary/);
      expect(section.slice(0, section.indexOf('```bash'))).not.toMatch(/- `Bash\(rm:\*\)`/);
      // The expected `grok inspect` count only counts rules Grok recognizes.
      expect(md).toContain('Permissions: source `.grok/config.toml`, 1 loaded');
    });
  });

  describe('hooks', () => {
    it('maps helper, http and matcher forms into the Claude-shaped hooks JSON', () => {
      const json = JSON.parse(hooksJson(defaultSpec)!);
      expect(json.hooks.SessionStart).toEqual([
        { hooks: [{ type: 'command', command: 'node "$GROK_WORKSPACE_ROOT/.claude/helpers/session-start.cjs"' }] },
      ]);
      expect(json.hooks.PreToolUse).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$GROK_WORKSPACE_ROOT/.claude/helpers/guard.cjs"' }] },
      ]);
      expect(json.hooks.PostToolUse).toEqual([
        { matcher: 'Edit|Write', hooks: [{ type: 'http', url: 'https://hooks.example.com/grok' }] },
      ]);
    });

    it('every documented event passes; Setup/FileChanged/PermissionRequest are dropped from JSON and named in the runbook', () => {
      const hooks = [...GROK_HOOK_EVENTS, 'Setup', 'FileChanged', 'PermissionRequest'].map((event) => ({ event, handler: 'h' }));
      const out = gen({ name: 'h', hooks });
      const json = JSON.parse(out['.grok/hooks/h.json']!);
      expect(Object.keys(json.hooks)).toEqual([...GROK_HOOK_EVENTS]);
      const md = out[INSTALL_MD]!;
      const unsupported = md.slice(md.indexOf('## Unsupported on this host'));
      for (const e of ['Setup', 'FileChanged', 'PermissionRequest']) expect(unsupported).toContain(`Grok has no \`${e}\` hook event`);
    });

    it('SubagentEnd is emitted under its documented canonical name SubagentStop', () => {
      const json = JSON.parse(hooksJson({ name: 'h', hooks: [{ event: 'SubagentEnd', handler: 'h' }] })!);
      expect(Object.keys(json.hooks)).toEqual(['SubagentStop']);
    });

    it('mcp:/prompt:/agent: handlers and unsafe helper names are not emitted and are named', () => {
      for (const handler of ['mcp:server/tool', 'prompt:Be careful', 'agent:reviewer', 'x"; rm -rf ~; "', '../escape', '$(id)']) {
        expect('unsupported' in hookHandlerFor(handler)).toBe(true);
      }
      const out = gen({ name: 'h', hooks: [{ event: 'PreToolUse', handler: 'prompt:Be careful' }, { event: 'Stop', handler: 'x"; rm -rf ~; "' }] });
      expect(out['.grok/hooks/h.json']).toBeUndefined();
      const md = out[INSTALL_MD]!;
      expect(md).toMatch(/## 5\. Hooks\n\nNo declared hook maps to a Grok hook/);
      expect(md).toContain('`prompt:` handlers have no Grok hook type');
      expect(md).toContain('not a plain file name');
    });

    it('matchers: `*`/empty are omitted (Grok matches all), Tool(args) keeps the tool and is reported as widened', () => {
      expect(grokMatcher(undefined)).toEqual({});
      expect(grokMatcher('*')).toEqual({});
      expect(grokMatcher(' ')).toEqual({});
      expect(grokMatcher('Bash(rm *)')).toEqual({ matcher: 'Bash', droppedPredicate: 'rm *' });
      expect(grokMatcher('Edit|Write')).toEqual({ matcher: 'Edit|Write' });
      const out = gen({ name: 'h', hooks: [{ event: 'PreToolUse', matcher: '*', handler: 'h' }] });
      expect(out['.grok/hooks/h.json']).not.toContain('"matcher"');
      expect(gen(defaultSpec)[INSTALL_MD]).toMatch(/matcher `Bash\(rm \*\)` is emitted as `Bash`/);
    });

    it('no supported hooks → no hooks file and no Hooks section', () => {
      const out = gen({ name: 'h' });
      expect(Object.keys(out).some((k) => k.startsWith('.grok/hooks/'))).toBe(false);
      expect(out[INSTALL_MD]).not.toContain('## 5. Hooks');
    });
  });

  describe('instructions, agents, skills', () => {
    it('AGENTS.md carries name, description, prompt, agent roster and the server__tool names', () => {
      const md = gen(defaultSpec)['AGENTS.md']!;
      expect(md).toMatch(/^# demo\n/);
      expect(md).toContain('You are demo, a repo-aware agent.');
      expect(md).toContain('### reviewer');
      expect(md).toContain('- `codeindex__*`');
      expect(md).toContain('- `remote__*`');
      expect(md).not.toContain('mcp__codeindex');
    });

    it('a bare spec emits only .grok/config.toml and the runbook (no AGENTS.md, no banner)', () => {
      const out = gen({ name: 'bare' });
      expect(Object.keys(out).sort()).toEqual([CONFIG_TOML, INSTALL_MD].sort());
      expect(out[INSTALL_MD]).not.toContain('ACTION REQUIRED');
    });

    it('one instruction-only SKILL.md per tool, Grok-valid names, collision suffixes, surrogate-safe 1024 cap', () => {
      const out = gen({
        name: 'h',
        tools: [
          { name: 'My_Weird Tool!', description: `${'x'.repeat(1023)}😀tail` },
          { name: 'my weird tool' },
        ],
      });
      const skills = Object.keys(out).filter((k) => /^\.grok\/skills\/[^/]+\/SKILL\.md$/.test(k)).sort();
      expect(skills).toEqual(['.grok/skills/my-weird-tool-2/SKILL.md', '.grok/skills/my-weird-tool/SKILL.md']);
      const md = out['.grok/skills/my-weird-tool/SKILL.md']!;
      const fm = /^---\nname: ([a-z0-9-]{1,64})\ndescription: "((?:[^"\\]|\\.)*)"\n---\n/.exec(md)!;
      expect(fm[1]).toBe('my-weird-tool');
      expect(fm[2]).toBe('x'.repeat(1023)); // the pair at 1023-1024 is not split
      expect(md).toContain('declarative contract, not an executable binding');
      expect(normalizeSkillName('---My---Tool---')).toBe('my-tool');
    });

    it('agents land in .grok/agents/<name>.md with a required name and sanitized description', () => {
      const out = gen({ name: 'h', agents: [{ name: 'Code Reviewer', systemPrompt: 'Say "hi"\nthen: stop' }] });
      const md = out['.grok/agents/code-reviewer.md']!;
      expect(md).toMatch(/^---\nname: code-reviewer\ndescription: "Say \\"hi\\" then: stop"\n---\n/);
      expect(md).toContain('Say "hi"\nthen: stop'); // body keeps the prompt verbatim
    });
  });

  describe('fail-closed trust posture (ADR-280 §2.2)', () => {
    it('the runbook OPENS with the trust banner naming every deny rule', () => {
      const md = gen(defaultSpec)[INSTALL_MD]!;
      const banner = md.indexOf('ACTION REQUIRED');
      expect(banner).toBeGreaterThan(-1);
      expect(banner).toBeLessThan(md.indexOf('## 1. Install Grok Build'));
      const head = md.slice(0, md.indexOf('## 1.'));
      for (const d of defaultSpec.permissions!.deny!) expect(head).toContain(`\`${d}\``);
      expect(head).toContain('not enforced');
    });

    it('the headless line repeats every deny rule as a shell-quoted --deny flag', () => {
      const out = gen({ name: 'h', permissions: { deny: ['Bash(rm:*)', "Read(it's)"] } });
      expect(out[INSTALL_MD]).toContain(`grok -p '<task>' --deny 'Bash(rm:*)' --deny 'Read(it'"'"'s)'`);
    });

    it('the banner appears whenever a trust-gated surface is emitted', () => {
      for (const spec of [
        { name: 'h', systemPrompt: 'x' },
        { name: 'h', mcpServers: [{ name: 's', command: ['x'] }] },
        { name: 'h', permissions: { allow: ['Read'] } },
        { name: 'h', tools: [{ name: 't' }] },
        { name: 'h', hooks: [{ event: 'Stop', handler: 'h' }] },
      ]) {
        expect(gen(spec)[INSTALL_MD], JSON.stringify(spec)).toContain('ACTION REQUIRED');
      }
    });
  });

  describe('no silent drops', () => {
    it('statusLine is named under "Unsupported on this host"; without it there is no such section', () => {
      expect(gen({ name: 'h', statusLine: 'node statusline.js' })[INSTALL_MD]).toMatch(
        /## Unsupported on this host[\s\S]*`statusLine` \(`node statusline.js`\)[\s\S]*\[ui\.status_line\]/,
      );
      expect(gen({ name: 'h' })[INSTALL_MD]).not.toContain('## Unsupported on this host');
    });

    // ADR-246 §2.2 / PR #332 convention: project or disclose, never drop.
    it('autonomous: maxTurns → --max-turns, goal → /goal --budget, heartbeat → /loop, gateCommand disclosed', () => {
      const md = gen({
        name: 'h',
        permissions: { deny: ['Bash(rm:*)'] },
        autonomous: {
          goal: { text: 'Ship it', tokenBudget: 5000 },
          heartbeat: { cadence: '30m', instruction: 'check CI' },
          gateCommand: 'npm test',
          maxTurns: 12,
        },
      })[INSTALL_MD]!;
      expect(md).toContain("grok -p 'Ship it' --max-turns 12 --deny 'Bash(rm:*)'");
      expect(md).toContain('/goal Ship it --budget 5000');
      expect(md).toContain('/loop 30m check CI');
      expect(md).toMatch(/`gateCommand` \(`npm test`\) is \*\*not projected\*\*/);
    });

    it('autonomous: absent optionals are not fabricated; an empty block is disclosed; no block → no section', () => {
      const goalOnly = gen({ name: 'h', autonomous: { goal: { text: 'g' } } })[INSTALL_MD]!;
      expect(goalOnly).toContain('/goal g\n');
      expect(goalOnly).not.toContain('--budget');
      expect(goalOnly).not.toContain('--max-turns');
      expect(gen({ name: 'h', autonomous: {} })[INSTALL_MD]).toContain('declares no fields');
      expect(gen({ name: 'h' })[INSTALL_MD]).not.toContain('## Autonomous mode');
    });
  });

  describe('ADR-027 parity with the CLI scaffold (packages/create-agent-harness/src/host-config.ts)', () => {
    // The CLI scaffold registers `npx -y <name>@latest mcp start` and its
    // policyLists() posture; the adapter given the same server + permissions
    // must emit the same .grok/config.toml bytes. (Remote servers differ by
    // design: McpServerSpec has no headers field, the CLI entry carries an
    // Authorization header.)
    for (const mcp of ['off', 'local'] as const) {
      for (const allowShell of [false, true]) {
        for (const allowFileWrite of [false, true]) {
          it(`mcp=${mcp} allowShell=${allowShell} allowFileWrite=${allowFileWrite}`, () => {
            const name = 'parity-bot';
            const cli = hostConfigFiles('grok', { name, description: 'd', mcp, allowShell, allowFileWrite });
            const cliToml = cli.find((f) => f.path === CONFIG_TOML)!.content;
            const allow = [...(mcp === 'off' ? [] : [`mcp__${name}__*`]), ...(allowShell ? ['Bash(*)'] : [])];
            const deny = ['Read(./.env)', 'Read(./.env.*)', 'Bash(rm:*)', 'Bash(git push:*)', ...(allowFileWrite ? [] : ['Write(*)', 'Edit(*)'])];
            const spec = {
              name,
              mcpServers: mcp === 'off' ? [] : [{ name, command: ['npx', '-y', `${name}@latest`, 'mcp', 'start'] }],
              permissions: { allow, deny },
            };
            expect(configToml(spec)).toBe(cliToml);
          });
        }
      }
    }
  });

  describe('determinism', () => {
    it('generateConfig(defaultSpec) matches the committed golden byte-for-byte', () => {
      const config = gen(defaultSpec);
      const raw = readFileSync(GOLDEN, 'utf8');
      expect(JSON.parse(raw)).toEqual(config);
      expect(raw).toBe(`${stableStringify(config)}\n`);
    });

    it('two calls produce identical output', () => {
      expect(stableStringify(gen(defaultSpec))).toBe(stableStringify(gen(defaultSpec)));
    });
  });
});
