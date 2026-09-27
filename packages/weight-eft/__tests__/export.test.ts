// SPDX-License-Identifier: MIT
//
// Tests for the archive→training-data exporter: SFT/DPO shapes, the
// contamination guard (the key test), on-policy DPO purity, long-context
// filtering, and tool-call fidelity. All $0, fixture-driven.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  exportTrainingData,
  assertTrainEvalDisjoint,
  estimateTokens,
} from '../src/export.js';
import type { DarwinTrajectory, ChatMessage } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const archive = JSON.parse(
  readFileSync(join(here, 'fixtures', 'mock-archive.json'), 'utf8'),
) as DarwinTrajectory[];

describe('exporter — SFT/DPO shapes', () => {
  it('SFT contains ALL gold-resolved trajectories (cheap-own AND frontier-escalation)', () => {
    const { sft, report } = exportTrainingData(archive, { evalHoldout: [] });
    // resolved: astropy glm (cheap), django opus (frontier), sympy opus (frontier) = 3
    expect(report.sftRows).toBe(3);
    expect(report.sftInstanceIds).toEqual(
      ['astropy__astropy-14182', 'django__django-15252', 'sympy__sympy-21055'].sort(),
    );
    // every SFT row is a {messages:[...]} with a non-empty trajectory
    for (const row of sft) {
      expect(Array.isArray(row.messages)).toBe(true);
      expect(row.messages.length).toBeGreaterThan(0);
      expect(row.messages[0].role).toBe('system');
    }
  });

  it('DPO contains ONLY on-policy cheap-vs-cheap pairs (no frontier-chosen)', () => {
    const { dpo, report } = exportTrainingData(archive, { evalHoldout: [] });
    // Only astropy has a cheap resolved (sample 0) + a cheap failed (sample 1) on the SAME model.
    expect(report.dpoRows).toBe(1);
    expect(report.dpoInstanceIds).toEqual(['astropy__astropy-14182']);
    const row = dpo[0];
    // prompt = shared system+user (issue); chosen/rejected = full completions
    expect(row.prompt.map((m) => m.role)).toEqual(['system', 'user']);
    expect(row.chosen.length).toBeGreaterThan(0);
    expect(row.rejected.length).toBeGreaterThan(0);
    expect(row.chosen[0].role).toBe('assistant');
  });

  it('DPO never pairs a frontier-chosen against a cheap-rejected (off-policy excluded)', () => {
    // django has frontier-resolved (opus) + cheap-failed (glm) on the same instance.
    // That must NOT become a DPO pair — off-policy. It only feeds SFT.
    const { dpo } = exportTrainingData(archive, { evalHoldout: [] });
    expect(dpo.some((d) => d.prompt.some((m) => (m.content ?? '').includes('db router')))).toBe(false);
  });
});

describe('exporter — THE CONTAMINATION GUARD (train/eval disjointness)', () => {
  it('excludes trajectories whose instance_id is in the eval holdout', () => {
    const { report } = exportTrainingData(archive, {
      evalHoldout: ['django__django-15252'],
    });
    // django (2 trajectories) excluded; SFT loses the opus django success.
    expect(report.excludedByHoldout).toBe(2);
    expect(report.sftInstanceIds).not.toContain('django__django-15252');
    expect(report.dpoInstanceIds).not.toContain('django__django-15252');
  });

  it('REJECTS a train/eval overlap — assert throws on contamination', () => {
    // assertTrainEvalDisjoint is the load-bearing guard: it MUST throw if any
    // training instance_id is in the holdout. This is the headline correctness
    // property — training on eval instances is fake lift.
    expect(() =>
      assertTrainEvalDisjoint(archive, ['astropy__astropy-14182']),
    ).toThrow(/contamination guard/i);
  });

  it('the exporter itself never leaks a held-out instance into either set', () => {
    const holdout = ['astropy__astropy-14182', 'sympy__sympy-21055'];
    const { sft, dpo, report } = exportTrainingData(archive, { evalHoldout: holdout });
    const allTrainIds = new Set([...report.sftInstanceIds, ...report.dpoInstanceIds]);
    for (const h of holdout) expect(allTrainIds.has(h)).toBe(false);
    // and concretely: no message anywhere references a held-out instance's content
    for (const row of sft) expect(row.messages.some((m) => (m.content ?? '').includes('header_rows'))).toBe(false);
    expect(dpo.length).toBe(0); // astropy was the only DPO pair, now held out
  });
});

describe('exporter — tool-call fidelity', () => {
  it('tool_calls survive into SFT messages as structured objects (not stringified)', () => {
    const { sft } = exportTrainingData(archive, { evalHoldout: [] });
    const astropy = sft.find((r) => r.messages.some((m) => (m.content ?? '').includes('RST writer')));
    expect(astropy).toBeDefined();
    const assistantWithTool = astropy!.messages.find(
      (m: ChatMessage) => m.role === 'assistant' && Array.isArray(m.tool_calls),
    );
    expect(assistantWithTool).toBeDefined();
    const tc = assistantWithTool!.tool_calls![0];
    // structured object, NOT a string
    expect(typeof tc).toBe('object');
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('read_file');
    expect(typeof tc.function.arguments).toBe('string'); // OpenAI args are a JSON string
    // and a matching tool-result message preserves its tool_call_id
    const toolResult = astropy!.messages.find((m) => m.role === 'tool' && m.tool_call_id === tc.id);
    expect(toolResult).toBeDefined();
  });
});

describe('exporter — long-context filter', () => {
  function bigTrajectory(id: string, resolved: boolean): DarwinTrajectory {
    const filler = 'x'.repeat(200000); // ~50k tokens — over a 28k budget
    return {
      instance_id: id,
      model: 'z-ai/glm-5.2',
      tier: 'cheap',
      resolved,
      sample: 0,
      model_patch: '+fix',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'issue: ' + filler },
        { role: 'assistant', content: 'patched' },
      ],
    };
  }

  it('DROPS an over-length trajectory and REPORTS it (no silent loss)', () => {
    const small = archive.filter((t) => t.instance_id === 'sympy__sympy-21055');
    const big = bigTrajectory('huge__huge-1', true);
    const { report, sft } = exportTrainingData([...small, big], { evalHoldout: [] });
    expect(report.droppedOverLength).toBe(1);
    expect(report.notes.some((n) => n.includes('huge__huge-1') && n.includes('dropped'))).toBe(true);
    // the dropped instance never enters SFT
    expect(sft.some((r) => r.messages.some((m) => (m.content ?? '').includes('xxxxx')))).toBe(false);
  });

  it('TRUNCATES instead of dropping when truncateOverLength is set, still reported', () => {
    const big = bigTrajectory('huge__huge-2', true);
    const { report } = exportTrainingData([big], {
      evalHoldout: [],
      truncateOverLength: true,
      maxTokens: 28000,
    });
    // The trajectory's single user turn is itself over budget, so even truncated
    // it may not fit — what matters: it is NOT silently dropped; it's accounted.
    expect(report.droppedOverLength + report.truncatedOverLength).toBe(1);
    expect(report.notes.length).toBeGreaterThan(0);
  });

  it('estimateTokens counts tool_call arguments toward the budget', () => {
    const withTool: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: 'y'.repeat(400) } }] },
    ];
    expect(estimateTokens(withTool)).toBeGreaterThan(90); // ~400/4 + overhead
  });

  it('REJECTS a NaN maxTokens (a malformed --max-tokens flag) instead of silently exporting 0 rows', () => {
    // Number('abc') → NaN; NaN survives `options.maxTokens ?? DEFAULT`; every
    // trajectory then looks "over budget" (`tokens <= NaN` is always false) and
    // the export would silently yield 0 SFT/DPO rows at exit code 0.
    expect(() => exportTrainingData(archive, { evalHoldout: [], maxTokens: NaN })).toThrow(/finite/i);
  });

  it('REJECTS a non-positive maxTokens (0 or negative)', () => {
    expect(() => exportTrainingData(archive, { evalHoldout: [], maxTokens: 0 })).toThrow(/finite/i);
    expect(() => exportTrainingData(archive, { evalHoldout: [], maxTokens: -1 })).toThrow(/finite/i);
  });
});
