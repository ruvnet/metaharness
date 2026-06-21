// SPDX-License-Identifier: MIT
//
// Darwin Shield — ruVector security memory (ADR-155 §advanced ruVector
// integration; ADR-074 fabric). Turns the scanner into a learning memory system.
//
// Seven collections — code_chunks, callgraph_nodes, confirmed_findings,
// false_positives, patches, genomes, benchmark_receipts — with deterministic
// embeddings (util.embed) so retrieval is reproducible with no network/weights.
//
// The two things that make Darwin Mode COMPOUND across runs:
//   • negative memory — down-rank hypotheses similar to past false positives,
//   • genome memory   — seed a new repo's population from prior winners.
//
// Hybrid ranking (ADR-155):
//   rank = 0.45·vector_similarity
//        + 0.20·callgraph_centrality
//        + 0.15·taint_sink_proximity
//        + 0.10·historical_finding_similarity
//        + 0.10·recent_change_weight
//        − 0.25·false_positive_similarity

import type {
  Finding,
  HarnessGenome,
  PatchExample,
  RepoProfile,
  SecurityVectorMeta,
} from './types.js';
import type { CorpusSite } from './corpus.js';
import { clamp, cosine, embed, round6 } from './util.js';

/** A stored vector: its embedding plus typed metadata and payload. */
interface VectorEntry<T> {
  vector: number[];
  meta: SecurityVectorMeta;
  payload: T;
}

/** A typed collection of vectors (a thin in-memory ruVector stand-in). */
class VectorCollection<T> {
  private readonly entries: VectorEntry<T>[] = [];

  add(text: string, meta: SecurityVectorMeta, payload: T): void {
    this.entries.push({ vector: embed(text), meta, payload });
  }

  size(): number {
    return this.entries.length;
  }

  /** Top-k by cosine similarity to the query text. */
  search(queryText: string, k: number): Array<{ score: number; meta: SecurityVectorMeta; payload: T }> {
    const q = embed(queryText);
    return this.entries
      .map((e) => ({ score: cosine(q, e.vector), meta: e.meta, payload: e.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Best cosine similarity of `queryText` to anything in the collection (0 if empty). */
  maxSimilarity(queryText: string): number {
    if (this.entries.length === 0) return 0;
    const q = embed(queryText);
    let best = 0;
    for (const e of this.entries) {
      const s = cosine(q, e.vector);
      if (s > best) best = s;
    }
    return best;
  }

  all(): ReadonlyArray<VectorEntry<T>> {
    return this.entries;
  }
}

/** The weights of the hybrid ranking formula (ADR-155). Exposed for audit. */
export const HYBRID_WEIGHTS = {
  vectorSimilarity: 0.45,
  callgraphCentrality: 0.2,
  taintSinkProximity: 0.15,
  historicalFindingSimilarity: 0.1,
  recentChangeWeight: 0.1,
  falsePositiveSimilarity: -0.25,
} as const;

/** Inputs to the hybrid ranker for a single candidate site. */
export interface RankInputs {
  vectorSimilarity: number;
  callgraphCentrality: number;
  taintSinkProximity: number;
  historicalFindingSimilarity: number;
  recentChangeWeight: number;
  falsePositiveSimilarity: number;
}

/** The pure hybrid-ranking score for one candidate (can be negative). */
export function hybridRank(x: RankInputs): number {
  const w = HYBRID_WEIGHTS;
  return round6(
    w.vectorSimilarity * x.vectorSimilarity +
      w.callgraphCentrality * x.callgraphCentrality +
      w.taintSinkProximity * x.taintSinkProximity +
      w.historicalFindingSimilarity * x.historicalFindingSimilarity +
      w.recentChangeWeight * x.recentChangeWeight +
      w.falsePositiveSimilarity * x.falsePositiveSimilarity,
  );
}

/** The learning security memory (ADR-155 §key API `RuvSecurityMemory`). */
export class RuvSecurityMemory {
  readonly codeChunks = new VectorCollection<CorpusSite>();
  readonly callgraphNodes = new VectorCollection<{ siteId: string }>();
  readonly confirmedFindings = new VectorCollection<Finding>();
  readonly falsePositives = new VectorCollection<Finding>();
  readonly patches = new VectorCollection<PatchExample>();
  readonly genomes = new VectorCollection<HarnessGenome>();
  readonly receipts = new VectorCollection<{ taskId: string }>();

  /** Index a repo's code sites so future runs can retrieve similar code. */
  indexSites(repo: string, commit: string, sites: CorpusSite[]): { indexed: number } {
    for (const s of sites) {
      const meta: SecurityVectorMeta = {
        repo,
        commit,
        language: s.language,
        path: s.file,
        symbol: s.symbol,
        chunkType: 'function',
        riskTags: s.riskTags,
        callgraphDegree: s.callgraphDegree,
        taintRole: s.taintRole,
      };
      this.codeChunks.add(`${s.weakness} ${s.symbol} ${s.file} ${s.riskTags.join(' ')}`, meta, s);
      this.callgraphNodes.add(`${s.symbol} ${s.taintRole}`, meta, { siteId: s.siteId });
    }
    return { indexed: sites.length };
  }

  /** Record a confirmed finding + its patch into long-term memory. */
  writeConfirmed(finding: Finding): void {
    const meta: SecurityVectorMeta = {
      repo: finding.repo,
      commit: finding.commit,
      language: 'ts',
      path: finding.file,
      symbol: finding.symbol,
      chunkType: 'function',
      riskTags: [finding.weakness],
      findingId: finding.id,
      verdict: 'confirmed',
    };
    this.confirmedFindings.add(`${finding.weakness} ${finding.symbol ?? ''} ${finding.file}`, meta, finding);
    if (finding.patch && finding.test) {
      this.patches.add(`${finding.weakness} ${finding.patch}`, meta, {
        weakness: finding.weakness,
        patch: finding.patch,
        test: finding.test,
      });
    }
  }

  /** Record a rejected hypothesis (negative memory). */
  writeFalsePositive(finding: Finding): void {
    const meta: SecurityVectorMeta = {
      repo: finding.repo,
      commit: finding.commit,
      language: 'ts',
      path: finding.file,
      symbol: finding.symbol,
      chunkType: 'function',
      riskTags: [finding.weakness],
      findingId: finding.id,
      verdict: 'false_positive',
    };
    this.falsePositives.add(`${finding.weakness} ${finding.symbol ?? ''} ${finding.file}`, meta, finding);
  }

  /** Record a winning genome keyed by the repo profile it succeeded on. */
  writeGenome(profile: RepoProfile, genome: HarnessGenome): void {
    const meta: SecurityVectorMeta = {
      repo: profile.repo,
      commit: profile.commit,
      language: profile.languages[0] ?? 'ts',
      path: '<genome>',
      chunkType: 'config',
      riskTags: profile.frameworks,
      genomeId: genome.id,
    };
    this.genomes.add(`${profile.languages.join(' ')} ${profile.frameworks.join(' ')}`, meta, genome);
  }

  /**
   * Negative-memory penalty for a candidate (0..1): how similar it is to a known
   * false positive. The hybrid ranker subtracts 0.25× this, so a harness with
   * memory stops re-reporting dead hypotheses (ADR-155 §negative memory).
   */
  falsePositiveSimilarity(candidateText: string): number {
    return round6(this.falsePositives.maxSimilarity(candidateText));
  }

  /** Similarity of a candidate to a prior CONFIRMED finding (historical signal). */
  historicalFindingSimilarity(candidateText: string): number {
    return round6(this.confirmedFindings.maxSimilarity(candidateText));
  }

  /** Retrieve accepted patches for code similar to a weakness (patch memory). */
  retrievePatches(weaknessQuery: string, k = 3): PatchExample[] {
    return this.patches.search(weaknessQuery, k).map((r) => r.payload);
  }

  /**
   * Seed a population from prior winning genomes on similar repos (genome
   * memory). Returns up to `k` genomes ranked by repo-profile similarity.
   */
  seedPopulation(profile: RepoProfile, k: number): HarnessGenome[] {
    const query = `${profile.languages.join(' ')} ${profile.frameworks.join(' ')}`;
    return this.genomes.search(query, k).map((r) => r.payload);
  }

  /**
   * recall@k for a set of relevant code paths: of the ground-truth paths, the
   * fraction surfaced in the top-k retrieval for `query` (ADR-155 acceptance:
   * context recall@20 ≥ 0.85).
   */
  recallAtK(query: string, relevantPaths: string[], k: number): number {
    if (relevantPaths.length === 0) return 1;
    const hits = new Set(this.codeChunks.search(query, k).map((r) => r.meta.path));
    const found = relevantPaths.filter((p) => hits.has(p)).length;
    return round6(found / relevantPaths.length);
  }
}

/** Normalise a raw callgraph degree (0..~12) into a 0..1 centrality. */
export function centrality(degree: number): number {
  return clamp(degree / 12, 0, 1);
}

/** A node in the lineage tree, with its measured fitness. */
interface LineageNode {
  id: string;
  parentId: string | null;
  fitness: number;
  children: string[];
}

/**
 * Metaproductivity lineage memory (ADR-155 Addendum B; HGM, arXiv:2510.21614).
 * The Huxley–Gödel insight: the best PARENT is not the best current scorer — it
 * is the variant whose DESCENDANTS improve fastest. ruVector cross-run seeding
 * should therefore retrieve productive LINEAGES, not just prior winners. This is
 * the metaproductivity signal that drives that selection. Pure, deterministic.
 */
export class LineageMemory {
  private readonly nodes = new Map<string, LineageNode>();

  /** Record (or update) a variant and link it to its parent. */
  record(id: string, parentId: string | null, fitness: number): void {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.fitness = fitness;
      existing.parentId = parentId;
    } else {
      this.nodes.set(id, { id, parentId, fitness, children: [] });
    }
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent && !parent.children.includes(id)) parent.children.push(id);
    }
  }

  size(): number {
    return this.nodes.size;
  }

  /** All transitive descendant ids of a node (excluding the node itself). */
  private descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...(this.nodes.get(id)?.children ?? [])];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      stack.push(...(this.nodes.get(cur)?.children ?? []));
    }
    return out;
  }

  /**
   * Metaproductivity of a node: the mean fitness of its descendants (a clade-
   * metaproductivity approximation). A node with no descendants falls back to its
   * own fitness (we have no evidence its branch is productive yet). This is the
   * signal HGM selects on — NOT the node's own score.
   */
  metaproductivity(id: string): number {
    const desc = this.descendants(id);
    if (desc.length === 0) return this.nodes.get(id)?.fitness ?? 0;
    let sum = 0;
    for (const d of desc) sum += this.nodes.get(d)?.fitness ?? 0;
    return round6(sum / desc.length);
  }

  /**
   * Top-k parent ids to continue from, ranked by metaproductivity (descendant
   * potential) rather than raw fitness — so a high-scoring dead-end loses to a
   * lower-scoring node whose lineage keeps improving.
   */
  topByMetaproductivity(k: number): Array<{ id: string; metaproductivity: number; ownFitness: number }> {
    return [...this.nodes.values()]
      .map((n) => ({ id: n.id, metaproductivity: this.metaproductivity(n.id), ownFitness: n.fitness }))
      .sort((a, b) => b.metaproductivity - a.metaproductivity || b.ownFitness - a.ownFitness)
      .slice(0, k);
  }

  /** Top-k by raw fitness (the naive baseline metaproductivity improves on). */
  topByFitness(k: number): string[] {
    return [...this.nodes.values()]
      .sort((a, b) => b.fitness - a.fitness)
      .slice(0, k)
      .map((n) => n.id);
  }
}
