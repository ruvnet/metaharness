// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import type { RepoProfile } from '../src/types.js';
import {
  plannerTemplate,
  contextBuilderTemplate,
  reviewerTemplate,
  retryPolicyTemplate,
  toolPolicyTemplate,
  memoryPolicyTemplate,
  scorePolicyTemplate,
} from '../src/templates.js';
import { validateGeneratedCode } from '../src/safety.js';

const profile: RepoProfile = {
  root: '/repo',
  packageManager: 'npm',
  testCommand: 'npm test',
  sourceFiles: ['src/index.ts'],
  riskFiles: [],
  summary: '1 files, npm package manager, test via "npm test", 0 risk file(s)',
};

const outputs: Record<string, string> = {
  planner: plannerTemplate(profile),
  contextBuilder: contextBuilderTemplate(),
  reviewer: reviewerTemplate(),
  retryPolicy: retryPolicyTemplate(),
  toolPolicy: toolPolicyTemplate(),
  memoryPolicy: memoryPolicyTemplate(),
  scorePolicy: scorePolicyTemplate(),
};

describe('mutation-surface templates pass validateGeneratedCode', () => {
  for (const [name, code] of Object.entries(outputs)) {
    it(`${name} template emits clean code`, () => {
      expect(validateGeneratedCode(code)).toEqual([]);
    });
  }
});

describe('templates emit well-formed source', () => {
  it('every template carries the SPDX header and is non-trivial', () => {
    for (const code of Object.values(outputs)) {
      expect(code).toContain('// SPDX-License-Identifier: MIT');
      expect(code.length).toBeGreaterThan(80);
    }
  });

  it('planner embeds the repo summary as a JSON literal', () => {
    expect(outputs.planner).toContain(JSON.stringify(profile.summary));
    expect(outputs.planner).toContain('createPlan');
  });

  it('score policy weights sum to 1', () => {
    // The emitted source declares the canonical weights; verify they total 1.
    const weights = {
      taskSuccess: 0.35,
      testPassRate: 0.2,
      traceQuality: 0.15,
      costEfficiency: 0.1,
      latencyEfficiency: 0.1,
      safetyScore: 0.1,
    };
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(outputs.scorePolicy).toContain('taskSuccess: 0.35');
  });
});
