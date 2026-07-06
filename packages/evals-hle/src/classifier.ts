// @metaharness/evals-hle — the SUBJECT CLASSIFIER.
//
// Maps a question to one of the fixed SUBJECTS so the verifier stack + answer format can be chosen per
// subject. Default is a cheap deterministic keyword heuristic (no model, no cost). An LLM classifier can be
// injected for the live run; the heuristic is the $0 fallback + the reproducible default for replay.
import { SUBJECTS, type Subject } from './genome.js';

export type Classifier = (question: string, hintedCategory?: string) => Subject;

const KEYWORDS: Record<Exclude<Subject, 'other'>, RegExp> = {
  math: /\b(integral|theorem|prime|matrix|topolog|manifold|algebra|derivative|equation|proof|modulo|polynomial|geometr)\b/i,
  physics: /\b(quantum|momentum|velocity|voltage|entropy|relativ|photon|electron|thermodynam|joule|newton|wavelength)\b/i,
  chemistry: /\b(molecul|reaction|stoichiome|enthalpy|reagent|catalyst|isotope|oxidation|pH\b|compound|valence)\b/i,
  biology: /\b(protein|enzyme|genome|cell\b|mitochond|allele|neuron|organism|species|metabolic|chromosome|ribosome)\b/i,
  cs: /\b(algorithm|complexity|compiler|runtime|pointer|hashmap|big-?o|regex|automat|turing|NP-|data structure)\b/i,
  law: /\b(statute|jurisdic|plaintiff|defendant|tort|constitution|precedent|liabilit|contract law|amendment)\b/i,
  history: /\b(century|dynasty|empire|treaty|revolution|ancient|medieval|BCE\b|monarch|colonial|world war)\b/i,
};

/** The default $0 heuristic classifier. Honors an explicit dataset category hint when present. */
export const heuristicClassifier: Classifier = (question, hintedCategory) => {
  if (hintedCategory) {
    const h = hintedCategory.toLowerCase();
    for (const s of SUBJECTS) if (s !== 'other' && h.includes(s)) return s;
    if (/comput/.test(h)) return 'cs';
    if (/bio/.test(h)) return 'biology';
    if (/chem/.test(h)) return 'chemistry';
    if (/phys/.test(h)) return 'physics';
    if (/math|logic/.test(h)) return 'math';
  }
  for (const [subj, re] of Object.entries(KEYWORDS)) if (re.test(question)) return subj as Subject;
  return 'other';
};
