// SPDX-License-Identifier: MIT
//
// iter 106 — Verifies the per-host usage guide stays in lockstep with the
// canonical HOSTS catalog. The HostGuide modal is what users land on after
// downloading a `.zip`; if it ever drifts from the actual host adapters, the
// guidance is wrong and the loop the user has to close (unzip → install →
// launch) becomes broken. This test is the bottom of that loop.
import { describe, expect, it } from 'vitest';
import { GUIDES } from '../HostGuide';
import { HOSTS } from '../../generator/catalog';

describe('HostGuide × HOSTS catalog parity (iter 106)', () => {
  it('every canonical host has a guide entry', () => {
    for (const h of HOSTS) {
      const g = GUIDES.find((x) => x.id === h.id);
      expect(g, `no guide for host ${h.id}`).toBeDefined();
    }
  });

  it('no orphan guides — every guide maps to a real host', () => {
    const hostIds = new Set(HOSTS.map((h) => h.id));
    for (const g of GUIDES) {
      expect(hostIds.has(g.id), `orphan guide for ${g.id}`).toBe(true);
    }
  });

  it('every guide has at least 2 steps (install + launch is the minimum)', () => {
    for (const g of GUIDES) {
      expect(g.steps.length, `${g.id} guide too short`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every guide step has a non-empty title and body', () => {
    for (const g of GUIDES) {
      for (const s of g.steps) {
        expect(s.title.length, `${g.id} step missing title`).toBeGreaterThan(0);
        expect(s.body.length, `${g.id} step missing body`).toBeGreaterThan(0);
      }
    }
  });

  it('guide IDs are exhaustively the 10 supported hosts (iter 127 + 128 + 147 + ADR-247)', () => {
    // iter 127 added 'copilot' (ADR-032); iter 128 added 'opencode' (ADR-036);
    // iter 147 added 'github-actions' (ADR-033, first non-interactive host);
    // 'prime-agent' added per ADR-247 (skills-only host, no MCP).
    const expected = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm', 'copilot', 'opencode', 'github-actions', 'prime-agent'];
    const actual = GUIDES.map((g) => g.id).sort();
    expect(actual).toEqual(expected.sort());
  });
});
