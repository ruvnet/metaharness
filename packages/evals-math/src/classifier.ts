// @metaharness/evals-math — the MATH-SUBTOPIC CLASSIFIER.
//
// Maps a word problem to one of the fixed SUBJECTS so the verifier stack + answer format can be chosen per
// subtopic. Default is a cheap deterministic keyword heuristic (no model, no cost). An LLM classifier can be
// injected for the live run; the heuristic is the $0 fallback + the reproducible default for replay.
import { SUBJECTS, type Subject } from './genome.js';

export type Classifier = (question: string, hintedCategory?: string) => Subject;

const KEYWORDS: Record<Exclude<Subject, 'other'>, RegExp> = {
  arithmetic: /\b(sum|total|difference|product|quotient|add|subtract|multipl|divide|percent|average|remainder)\b/i,
  algebra: /\b(equation|solve for|variable|unknown|linear|quadratic|coefficient|expression|inequalit|simplify)\b/i,
  geometry: /\b(triangle|circle|square|rectangle|area|perimeter|volume|angle|radius|diameter|polygon|hypotenuse)\b/i,
  numbertheory: /\b(prime|divisor|factor|multiple|gcd|lcm|modul|remainder|divisible|integer solution|digit)\b/i,
  combinatorics: /\b(how many ways|combination|permutation|arrange|choose|probabilit|distinct|ordering|subset)\b/i,
  wordproblem: /\b(each|per|how many|how much|apples|marbles|cost|price|hours|miles|faster|older|younger|shared)\b/i,
  calculus: /\b(derivative|integral|limit|rate of change|slope of|tangent|maxim|minim|differenti|area under)\b/i,
};

/** The default $0 heuristic classifier. Honors an explicit dataset category hint when present. */
export const heuristicClassifier: Classifier = (question, hintedCategory) => {
  if (hintedCategory) {
    const h = hintedCategory.toLowerCase();
    for (const s of SUBJECTS) if (s !== 'other' && h.includes(s)) return s;
    if (/count|combinator|probab/.test(h)) return 'combinatorics';
    if (/number[- ]?theor|divis|prime/.test(h)) return 'numbertheory';
    if (/geo|shape|area|volume/.test(h)) return 'geometry';
    if (/calc|deriv|integral/.test(h)) return 'calculus';
    if (/algebra|equation/.test(h)) return 'algebra';
    if (/arith|basic/.test(h)) return 'arithmetic';
  }
  for (const [subj, re] of Object.entries(KEYWORDS)) if (re.test(question)) return subj as Subject;
  return 'other';
};
