// ADR-241 §2.4 Test Contract item 6 — PTC deferral contract.
// The experiment manifest exists, parses, and pre-registers arms, metrics, seeds,
// and the promotion criterion, so the deferral is executable, not vaporware.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../experiments/ptc-ab.json');

describe('ADR-241 §2.4 — ptc-ab pre-registered experiment manifest', () => {
  it('exists and parses', () => {
    expect(existsSync(manifestPath)).toBe(true);
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(m.schema).toBe(1);
    expect(m.name).toBe('ptc-ab');
  });

  it('is pre-registered with SYNTHETIC data discipline', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(m.status).toBe('pre-registered');
    expect(m.dataSource).toBe('SYNTHETIC');
  });

  it('pre-registers exactly two arms with distinct ids', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(Array.isArray(m.arms)).toBe(true);
    expect(m.arms).toHaveLength(2);
    const ids = m.arms.map((a: { id: string }) => a.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain('json-schema-tools');
    expect(ids).toContain('repl-ptc');
    for (const a of m.arms) expect(typeof a.description).toBe('string');
  });

  it('pre-registers both metrics', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(m.metrics).toContain('tokensPerTask');
    expect(m.metrics).toContain('successRate');
  });

  it('pre-registers >=3 fixed integer seeds', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(Array.isArray(m.seeds)).toBe(true);
    expect(m.seeds.length).toBeGreaterThanOrEqual(3);
    for (const s of m.seeds) expect(Number.isInteger(s)).toBe(true);
  });

  it('pre-registers the promotion criterion (20% reduction, alpha=0.05) and the honest null', () => {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(m.promotionCriterion.adopt).toContain('20%');
    expect(m.promotionCriterion.adopt).toContain('alpha=0.05');
    expect(m.promotionCriterion.otherwise).toContain('ADR-235');
  });
});
