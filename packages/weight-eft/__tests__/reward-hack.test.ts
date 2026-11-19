// SPDX-License-Identifier: MIT
//
// Tests for the deterministic reward-hacking monitor (Ornith-1.0 borrow) and
// its integration into the exporter: a trajectory that read a withheld gold
// path (or tampered with the verification harness, or escaped the sandbox) is
// EXCLUDED from the training set with a logged reason and a surfaced count.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectRewardHack, isRewardHacked } from '../src/reward-hack.js';
import { exportTrainingData } from '../src/export.js';
import type { DarwinTrajectory } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const archive = JSON.parse(
  readFileSync(join(here, 'fixtures', 'reward-hack-archive.json'), 'utf8'),
) as DarwinTrajectory[];

const byId = (id: string) => archive.find((t) => t.instance_id === id)!;

describe('reward-hack monitor — deterministic detection', () => {
  it('flags a trajectory that READ a withheld gold path', () => {
    const findings = detectRewardHack(byId('cheater__cheater-goldread'));
    expect(findings.some((f) => f.kind === 'gold-read')).toBe(true);
    expect(isRewardHacked(byId('cheater__cheater-goldread'))).toBe(true);
  });

  it('flags a trajectory that MODIFIED the verification harness (conftest)', () => {
    const findings = detectRewardHack(byId('cheater__cheater-tamper'));
    expect(findings.some((f) => f.kind === 'verification-tamper')).toBe(true);
  });

  it('flags a trajectory that ESCAPED the sandbox (/etc write)', () => {
    const findings = detectRewardHack(byId('cheater__cheater-escape'));
    expect(findings.some((f) => f.kind === 'sandbox-escape')).toBe(true);
  });

  it('does NOT flag an honest trajectory (clean repo read + patch)', () => {
    expect(detectRewardHack(byId('honest__honest-1'))).toEqual([]);
    expect(isRewardHacked(byId('honest__honest-1'))).toBe(false);
  });
});

// READ_TOOLS/WRITE_TOOLS must cover THIS repo's own agentic tool surface
// (`ls`/`read`/`grep`/`edit`/`line_edit`/`run_tests`/`submit` — see
// `bench/swebench/agentic-loop.mjs`'s `buildAgenticToolsSchema` and
// `gepa/genome.ts`'s `TOOL_ORDER`), not just a generic/other-harness naming
// convention (`read_file`, `edit_file`, ...). A trajectory that reads the
// withheld oracle via this repo's own `read` tool, or tampers via `edit`/
// `line_edit`, must be caught exactly like the `read_file`/`edit_file` cases
// above already are.
describe('reward-hack monitor — this repo\'s own tool names (ls/read/edit/line_edit)', () => {
  const trajectoryWithToolCall = (tool: string, args: Record<string, unknown>): DarwinTrajectory =>
    ({
      instance_id: `inline__${tool}`,
      model: 'test',
      tier: 'cheap',
      resolved: true,
      sample: 0,
      model_patch: 'diff --git a/x b/x\n',
      messages: [
        { role: 'user', content: 'fix it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }],
        },
      ],
    }) as unknown as DarwinTrajectory;

  it('flags a gold-read via this repo\'s own "read" tool (not just "read_file")', () => {
    const findings = detectRewardHack(trajectoryWithToolCall('read', { path: 'test_patch.py' }));
    expect(findings.some((f) => f.kind === 'gold-read')).toBe(true);
  });

  it('flags a gold-read via "ls" listing a gold-marked directory', () => {
    const findings = detectRewardHack(trajectoryWithToolCall('ls', { dir: 'gold_patch/' }));
    expect(findings.some((f) => f.kind === 'gold-read')).toBe(true);
  });

  it('flags verification-tamper via this repo\'s own "edit"/"line_edit" tools', () => {
    expect(
      detectRewardHack(trajectoryWithToolCall('edit', { path: 'conftest.py', search: 'a', replace: 'b' }))
        .some((f) => f.kind === 'verification-tamper'),
    ).toBe(true);
    expect(
      detectRewardHack(trajectoryWithToolCall('line_edit', { path: 'run_tests.sh', start: 1, end: 2, replace: 'x' }))
        .some((f) => f.kind === 'verification-tamper'),
    ).toBe(true);
  });

  it('does not flag an honest "read"/"edit" call with no gold/verification pattern in its args', () => {
    expect(detectRewardHack(trajectoryWithToolCall('read', { path: 'src/main.py' }))).toEqual([]);
    expect(detectRewardHack(trajectoryWithToolCall('edit', { path: 'src/main.py', search: 'a', replace: 'b' }))).toEqual([]);
  });
});

describe('reward-hack filter — exporter integration', () => {
  it('EXCLUDES reward-hacked successes from the training set and reports the count', () => {
    const { sft, report } = exportTrainingData(archive, { evalHoldout: [] });
    // 4 resolved trajectories, 3 of them reward-hacked → only the honest one survives.
    expect(report.droppedRewardHacked).toBe(3);
    expect(report.sftRows).toBe(1);
    expect(report.sftInstanceIds).toEqual(['honest__honest-1']);
    // a logged reason per drop, naming the instance and the kind
    expect(report.notes.filter((n) => n.includes('reward-hack drop')).length).toBe(3);
    expect(report.notes.some((n) => n.includes('cheater__cheater-goldread') && n.includes('gold-read'))).toBe(true);
    // the gold-read cheater's content never reaches SFT
    expect(sft.some((r) => r.messages.some((m) => (m.content ?? '').includes('WITHHELD gold')))).toBe(false);
  });

  it('reward-hacked cheap trajectories never enter DPO either', () => {
    const { dpo } = exportTrainingData(archive, { evalHoldout: [] });
    // no chosen completion may come from a cheater
    expect(dpo.length).toBe(0); // honest-1 has no failed sibling → no pair
  });

  it('the filter is separate from disjointness — both can drop the same instance', () => {
    const { report } = exportTrainingData(archive, {
      evalHoldout: ['cheater__cheater-goldread'],
    });
    // held-out cheater is excluded by the holdout guard FIRST (not double-counted)
    expect(report.excludedByHoldout).toBe(1);
    expect(report.droppedRewardHacked).toBe(2); // the other two cheaters
  });

  it('dropRewardHacked:false disables the filter (debug only) but still counts honest', () => {
    const { report } = exportTrainingData(archive, { evalHoldout: [], dropRewardHacked: false });
    expect(report.droppedRewardHacked).toBe(0);
    expect(report.sftRows).toBe(4); // all 4 resolved survive when the filter is off
  });
});
