// @metaharness/evals-extract — the DOC-TYPE CLASSIFIER.
//
// Maps a document to one of the fixed DOC_TYPES so the verifier stack + schema strictness can be chosen per
// doc type. Default is a cheap deterministic keyword heuristic (no model, no cost). An LLM classifier can be
// injected for the live run; the heuristic is the $0 fallback + the reproducible default for replay.
import { DOC_TYPES, type DocType } from './genome.js';

export type Classifier = (text: string, hintedCategory?: string) => DocType;

const KEYWORDS: Record<Exclude<DocType, 'other'>, RegExp> = {
  invoice: /\b(invoice|bill to|amount due|net 30|purchase order|po number|tax id|subtotal|remit)\b/i,
  receipt: /\b(receipt|total paid|change due|cashier|transaction id|card ending|merchant|refund)\b/i,
  resume: /\b(curriculum vitae|work experience|education|skills|references|objective|employment history)\b/i,
  contract: /\b(agreement|whereas|party of the|hereby|governing law|indemnif|termination clause|effective date)\b/i,
  email: /\b(from:|to:|subject:|cc:|forwarded message|reply-to|dear|regards|sent from my)\b/i,
  form: /\b(please fill|checkbox|field required|application form|date of birth|signature|section [0-9]|applicant)\b/i,
  article: /\b(abstract|introduction|conclusion|byline|published|headline|paragraph|editor|column)\b/i,
};

/** The default $0 heuristic classifier. Honors an explicit dataset category hint when present. */
export const heuristicClassifier: Classifier = (text, hintedCategory) => {
  if (hintedCategory) {
    const h = hintedCategory.toLowerCase();
    for (const s of DOC_TYPES) if (s !== 'other' && h.includes(s)) return s;
    if (/bill|purchase/.test(h)) return 'invoice';
    if (/cv|candidate/.test(h)) return 'resume';
    if (/agreement|legal/.test(h)) return 'contract';
    if (/mail|message/.test(h)) return 'email';
  }
  for (const [dt, re] of Object.entries(KEYWORDS)) if (re.test(text)) return dt as DocType;
  return 'other';
};
