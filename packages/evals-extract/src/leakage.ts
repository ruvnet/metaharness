// @metaharness/evals-extract — the LEAKAGE DETECTOR (fail-closed).
//
// The single biggest failure mode of benchmark policy evolution is overfit-by-leakage: a policy that encodes
// document-specific hacks, memorized gold objects, or dataset-artifact language. This detector runs on every
// candidate policy BEFORE it can be scored/promoted. Any positive signal fails the candidate CLOSED — it is
// marked `regressed` so the frozen gate rejects it outright. Anti-overfit is procedural, not aspirational.
import type { ExtractPolicyGenome } from './genome.js';

export interface LeakageCheck {
  /** Max n-gram overlap between any policy string and any known public example. [0,1]. */
  ngramOverlapWithPublicExamples: number;
  /** A policy string reproduces a specific holdout/dev document verbatim. */
  exactDocumentSeen: boolean;
  /** Policy mentions a benchmark artifact (dataset ids, split names, "gold record"). */
  policyMentionsBenchmarkArtifact: boolean;
  /** Policy embeds a dataset-specific hack (per-document field lookups, hardcoded values). */
  promptContainsDatasetSpecificHack: boolean;
}

const ARTIFACT_RE = /\b(gold (record|extraction|answer|json|object)|frozen[- ]?holdout|private[- ]?validation|test split|validation split|dev split|eval corpus)\b/i;
const HACK_RE = /\b(if (the )?(document|doc|text) (contains|is|mentions)|field\s*(is|=)\s*["']|lookup table|memoized (record|answer)|hardcod|answer\s*(is|=)\s*["'])/i;

/** Scan a candidate genome for leakage. `publicExamples` are dev-set documents the policy MUST NOT encode. */
export function detectLeakage(genome: ExtractPolicyGenome, publicExamples: string[] = []): LeakageCheck {
  const strings = collectStrings(genome);
  const joined = strings.join('  ').toLowerCase();

  let maxOverlap = 0;
  let exact = false;
  for (const ex of publicExamples) {
    const q = ex.toLowerCase().trim();
    if (!q) continue;
    if (joined.includes(q)) { exact = true; maxOverlap = 1; break; }
    const o = ngramOverlap(joined, q, 5);
    if (o > maxOverlap) maxOverlap = o;
  }

  return {
    ngramOverlapWithPublicExamples: maxOverlap,
    exactDocumentSeen: exact,
    policyMentionsBenchmarkArtifact: strings.some((s) => ARTIFACT_RE.test(s)),
    promptContainsDatasetSpecificHack: strings.some((s) => HACK_RE.test(s)),
  };
}

/** Fail-closed verdict: true if the candidate must be rejected. */
export function leaks(check: LeakageCheck, ngramThreshold = 0.5): boolean {
  return (
    check.exactDocumentSeen ||
    check.policyMentionsBenchmarkArtifact ||
    check.promptContainsDatasetSpecificHack ||
    check.ngramOverlapWithPublicExamples >= ngramThreshold
  );
}

function collectStrings(g: ExtractPolicyGenome): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(g);
  return out;
}

function ngramOverlap(haystack: string, needle: string, n: number): number {
  const grams = (s: string): Set<string> => {
    const toks = s.split(/\s+/).filter(Boolean);
    const set = new Set<string>();
    for (let i = 0; i + n <= toks.length; i++) set.add(toks.slice(i, i + n).join(' '));
    return set;
  };
  const ng = grams(needle);
  if (ng.size === 0) return 0;
  const hg = grams(haystack);
  let hits = 0;
  for (const g of ng) if (hg.has(g)) hits++;
  return hits / ng.size;
}
