// SPDX-License-Identifier: MIT
//
// Tests for the archive (ADR-073): tree integrity, RETENTION (archive-wide
// selection that escapes hill-climbing), global best, persistence round-trip,
// the lineage-graph projection, and the cycle guard.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../src/archive.js';
import type { HarnessVariant, ScoreCard } from '../src/types.js';

/** Build a HarnessVariant with sensible defaults; override as needed. */
function variant(over: Partial<HarnessVariant> & { id: string }): HarnessVariant {
  return {
    id: over.id,
    parentId: over.parentId ?? null,
    generation: over.generation ?? 0,
    dir: over.dir ?? `/tmp/variants/${over.id}`,
    mutationSurface: over.mutationSurface ?? 'planner',
    mutationSummary: over.mutationSummary ?? `mutation for ${over.id}`,
    createdAt: over.createdAt ?? '2026-06-17T00:00:00.000Z',
  };
}

/** Build a ScoreCard with a given finalScore and promotion flag. */
function score(
  variantId: string,
  finalScore: number,
  promoted = false,
): ScoreCard {
  return {
    variantId,
    taskSuccess: 0,
    testPassRate: 0,
    traceQuality: 0,
    costEfficiency: 0,
    latencyEfficiency: 0,
    safetyScore: 0,
    secretExposure: 0,
    destructiveAction: 0,
    hallucinatedFile: 0,
    toolLoop: 0,
    costOverrun: 0,
    baseScore: finalScore,
    finalScore,
    promoted,
    reason: `scored ${finalScore}`,
  };
}

// Track temp dirs so we can clean them up after each test.
const tempDirs: string[] = [];
async function tempArchiveFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'darwin-archive-'));
  tempDirs.push(dir);
  return join(dir, 'archive.json');
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

/** baseline → c1, c2 ; c1 → c3. */
function buildTree(): Archive {
  const archive = new Archive('/unused.json');
  archive.addVariant(variant({ id: 'baseline', parentId: null, generation: 0 }));
  archive.addVariant(variant({ id: 'c1', parentId: 'baseline', generation: 1 }));
  archive.addVariant(variant({ id: 'c2', parentId: 'baseline', generation: 1 }));
  archive.addVariant(variant({ id: 'c3', parentId: 'c1', generation: 2 }));
  return archive;
}

describe('Archive tree integrity', () => {
  it('records parent→child edges', () => {
    const archive = buildTree();
    expect(archive.get('baseline')!.children).toEqual(['c1', 'c2']);
    expect(archive.get('c1')!.children).toEqual(['c3']);
    expect(archive.get('c2')!.children).toEqual([]);
    expect(archive.get('c3')!.children).toEqual([]);
  });

  it('reconstructs the full lineage path root→target', () => {
    const archive = buildTree();
    expect(archive.lineageOf('c3')).toEqual(['baseline', 'c1', 'c3']);
    expect(archive.lineageOf('baseline')).toEqual(['baseline']);
    expect(archive.lineageOf('unknown')).toEqual([]);
  });

  it('addVariant is idempotent and does not duplicate child edges', () => {
    const archive = buildTree();
    archive.addVariant(variant({ id: 'c1', parentId: 'baseline', generation: 1 }));
    expect(archive.get('baseline')!.children).toEqual(['c1', 'c2']);
    expect(archive.all()).toHaveLength(4);
  });
});

describe('Archive retention (archive-wide selection escapes hill-climbing)', () => {
  it('selectParents includes an older high-scoring non-promoted branch', () => {
    const archive = buildTree();
    // An OLDER variant (c2) scores HIGH but was never promoted.
    archive.setScore('c2', score('c2', 0.91, /* promoted */ false));
    // The "current best" promoted variant (c3) scores slightly LOWER.
    archive.setScore('c3', score('c3', 0.88, /* promoted */ true));
    // A weak baseline.
    archive.setScore('baseline', score('baseline', 0.40, false));

    const parents = archive.selectParents(2).map((v) => v.id);
    // Top-2 by finalScore across the WHOLE archive: c2 (0.91) then c3 (0.88).
    expect(parents).toEqual(['c2', 'c3']);
    // The crux: the older, non-promoted high scorer is retained and selectable.
    expect(parents).toContain('c2');
  });

  it('selectParents is deterministic on ties (insertion order)', () => {
    const archive = buildTree();
    archive.setScore('c1', score('c1', 0.5));
    archive.setScore('c2', score('c2', 0.5));
    archive.setScore('c3', score('c3', 0.5));
    // All tied — earlier insertions (c1, then c2) win the top-2 slots.
    expect(archive.selectParents(2).map((v) => v.id)).toEqual(['c1', 'c2']);
  });

  it('selectParents ignores unscored records and handles non-positive limits', () => {
    const archive = buildTree();
    archive.setScore('c1', score('c1', 0.7));
    expect(archive.selectParents(5).map((v) => v.id)).toEqual(['c1']);
    expect(archive.selectParents(0)).toEqual([]);
    expect(archive.selectParents(-1)).toEqual([]);
  });
});

describe('Archive.best', () => {
  it('returns null when nothing is scored', () => {
    const archive = buildTree();
    expect(archive.best()).toBeNull();
  });

  it('returns the global max-finalScore record', () => {
    const archive = buildTree();
    archive.setScore('baseline', score('baseline', 0.3));
    archive.setScore('c1', score('c1', 0.85));
    archive.setScore('c2', score('c2', 0.6));
    expect(archive.best()!.variant.id).toBe('c1');
  });

  it('breaks ties toward the earlier insertion', () => {
    const archive = buildTree();
    archive.setScore('c2', score('c2', 0.7));
    archive.setScore('c1', score('c1', 0.7));
    // c1 was inserted before c2, so it wins the tie regardless of scoring order.
    expect(archive.best()!.variant.id).toBe('c1');
  });
});

describe('Archive.setScore', () => {
  it('throws a clear error for an unknown variant', () => {
    const archive = buildTree();
    expect(() => archive.setScore('ghost', score('ghost', 1))).toThrow(/unknown variant "ghost"/);
  });
});

describe('Archive persistence round-trip', () => {
  it('save → new Archive → load deep-equals all()', async () => {
    const file = await tempArchiveFile();
    const archive = buildTree();
    archive.setScore('baseline', score('baseline', 0.3));
    archive.setScore('c1', score('c1', 0.85, true));
    archive.setScore('c3', score('c3', 0.5));
    // Re-target the in-memory archive to the temp file and persist.
    const writer = new Archive(file);
    for (const r of archive.all()) {
      writer.addVariant(r.variant);
      if (r.score) writer.setScore(r.variant.id, r.score);
    }
    await writer.save();

    const reader = new Archive(file);
    await reader.load();
    expect(reader.all()).toEqual(writer.all());

    // And the round-trip is stable: load → save → load is identical.
    await reader.save();
    const reader2 = new Archive(file);
    await reader2.load();
    expect(reader2.all()).toEqual(reader.all());
  });

  it('load tolerates a missing file by starting empty', async () => {
    const file = await tempArchiveFile(); // dir exists, file does not
    const archive = new Archive(file);
    await archive.load();
    expect(archive.all()).toEqual([]);
  });
});

describe('Archive.toLineageGraph', () => {
  it('returns the right node and edge counts', () => {
    const archive = buildTree();
    archive.setScore('c1', score('c1', 0.85, true));
    const graph = archive.toLineageGraph();

    expect(graph.nodes).toHaveLength(4); // baseline, c1, c2, c3
    expect(graph.edges).toHaveLength(3); // baseline→c1, baseline→c2, c1→c3
    expect(graph.edges).toContainEqual({ from: 'baseline', to: 'c1' });
    expect(graph.edges).toContainEqual({ from: 'baseline', to: 'c2' });
    expect(graph.edges).toContainEqual({ from: 'c1', to: 'c3' });

    const c1 = graph.nodes.find((n) => n.id === 'c1')!;
    expect(c1.finalScore).toBe(0.85);
    expect(c1.promoted).toBe(true);
    expect(c1.generation).toBe(1);

    const c2 = graph.nodes.find((n) => n.id === 'c2')!;
    expect(c2.finalScore).toBeNull(); // unscored
    expect(c2.promoted).toBeNull();
  });
});

describe('Archive cycle guard', () => {
  it('lineageOf does not infinite-loop on a self-parent', () => {
    const archive = new Archive('/unused.json');
    archive.addVariant(variant({ id: 'self', parentId: 'self' }));
    expect(archive.lineageOf('self')).toEqual(['self']);
  });

  it('lineageOf does not infinite-loop on a cyclic ancestor chain', () => {
    // Manufacture a 2-cycle: a's parent is b, b's parent is a.
    const archive = new Archive('/unused.json');
    archive.addVariant(variant({ id: 'a', parentId: 'b' }));
    archive.addVariant(variant({ id: 'b', parentId: 'a' }));
    const lineage = archive.lineageOf('a');
    // Terminates and visits each id at most once.
    expect(new Set(lineage).size).toBe(lineage.length);
    expect(lineage).toContain('a');
  });
});
