// SPDX-License-Identifier: MIT
// Deterministic port of prediction_matching.py (fdebf9a8), retaining hard-rejection gates.
import { pyRound } from "./markets.js";
type Obj = Record<string, any>;
const DEFAULT_MIN_CONFIDENCE: any = 0.6;
const NEAR_MISS_FLOOR: any = 0.5;
const MAX_COMPARABLE_SPREAD: any = 0.1;
const MAX_TEXT_CHARS: any = 500;
const _DATE_TOLERANCE_FLOOR_DAYS: any = 3.0;
const _DATE_TOLERANCE_HORIZON_FRACTION: any = 0.15;
const _STOPWORDS = new Set<string>(["a", "an", "and", "any", "are", "as", "at", "be", "between", "by", "did", "do", "does", "during", "each", "end", "following", "for", "from", "had", "has", "have", "her", "his", "how", "in", "is", "it", "its", "next", "of", "on", "or", "than", "that", "the", "their", "then", "there", "these", "this", "those", "to", "until", "was", "were", "what", "when", "where", "which", "who", "will", "with"]);
const _SYNONYMS: any = { "jan": "january", "feb": "february", "mar": "march", "apr": "april", "jun": "june", "jul": "july", "aug": "august", "sep": "september", "sept": "september", "oct": "october", "nov": "november", "dec": "december", "cuts": "cut", "decrease": "cut", "decreases": "cut", "lower": "cut", "lowers": "cut", "hike": "raise", "hikes": "raise", "increase": "raise", "increases": "raise", "raises": "raise", "holds": "hold", "maintain": "hold", "maintains": "hold", "unchanged": "hold", "pause": "hold", "pauses": "hold", "over": "above", "more": "above", "exceed": "above", "exceeds": "above", "higher": "above", "greater": "above", "under": "below", "fewer": "below", "less": "below", "wins": "win", "won": "win", "winner": "win", "usa": "us", "u.s": "us", "u.s.a": "us", "bp": "bps", "basis": "bps", "cutting": "cut", "lowered": "cut", "lowering": "cut", "decreased": "cut", "decreasing": "cut", "reduce": "cut", "reduces": "cut", "reduced": "cut", "reducing": "cut", "trim": "cut", "trims": "cut", "trimmed": "cut", "trimming": "cut", "ease": "cut", "eases": "cut", "eased": "cut", "easing": "cut", "raised": "raise", "raising": "raise", "hiked": "raise", "hiking": "raise", "increased": "raise", "increasing": "raise", "boost": "raise", "boosts": "raise", "boosted": "raise", "boosting": "raise", "tighten": "raise", "tightens": "raise", "tightened": "raise", "tightening": "raise", "held": "hold", "holding": "hold", "paused": "hold", "maintained": "hold", "rises": "rise", "rising": "rise", "rose": "rise", "risen": "rise", "falls": "fall", "falling": "fall", "fell": "fall", "fallen": "fall", "drops": "drop", "dropped": "drop", "dropping": "drop", "loses": "lose", "losing": "lose", "lost": "lose", "loser": "lose", "approves": "approve", "approved": "approve", "approval": "approve", "rejects": "reject", "rejected": "reject", "rejection": "reject" };
const _MONTHS = new Set<string>(["april", "august", "december", "february", "january", "july", "june", "march", "may", "november", "october", "september"]);
const _MAY_BEFORE = new Set<string>(["after", "before", "by", "early", "end", "from", "in", "late", "mid", "of", "since", "through", "until"]);
const _NEGATIONS = new Set<string>(["arent", "cannot", "cant", "didnt", "doesnt", "dont", "fail", "failed", "fails", "isnt", "neither", "never", "no", "nobody", "none", "nor", "not", "wasnt", "without", "wont"]);
const _YES_NO = new Set<string>(["no", "yes"]);
const _ACTIONS = new Set<string>(["cut", "hold", "raise"]);
const _DIRECTIONS: any = { "above": "above", "below": "below", "atleast": "above", "atmost": "below", "ormore": "above" };
const _RATE_CONTEXT = new Set<string>(["boc", "boe", "boj", "bps", "ecb", "fed", "funds", "interest", "monetary", "pboc", "rate", "rates", "rba", "snb"]);
const _POLES: any = { "rise": ["move", "up"], "climb": ["move", "up"], "climbs": ["move", "up"], "reach": ["move", "up"], "reaches": ["move", "up"], "hit": ["move", "up"], "hits": ["move", "up"], "surpass": ["move", "up"], "surpasses": ["move", "up"], "fall": ["move", "down"], "drop": ["move", "down"], "dip": ["move", "down"], "dips": ["move", "down"], "decline": ["move", "down"], "declines": ["move", "down"], "sink": ["move", "down"], "sinks": ["move", "down"], "plunge": ["move", "down"], "positive": ["sign", "positive"], "negative": ["sign", "negative"], "before": ["time", "before"], "after": ["time", "after"], "win": ["result", "win"], "lose": ["result", "lose"], "approve": ["approval", "approve"], "reject": ["approval", "reject"] };
const _SCALE_WORDS: any = { "thousand": 1000.0, "million": 1000000.0, "billion": 1000000000.0, "trillion": 1000000000000.0 };
const _MULTIPLIERS: any = { "": 1.0, "k": 1000.0, "m": 1000000.0, "mn": 1000000.0, "b": 1000000000.0, "bn": 1000000000.0, "t": 1000000000000.0, "tn": 1000000000000.0 };
const _NUMBER_WORDS: any = { "once": 1, "twice": 2, "thrice": 3, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12 };
const _NUM_RE: any = new RegExp("^(-?)\\$?(\\d+(?:\\.\\d+)?)(k|mn|m|bn|b|tn|t)?$", "");
const _ORDINAL_RE: any = new RegExp("^(\\d+)(st|nd|rd|th)$", "");
const _TOKEN_RE: any = new RegExp("(?<![\\d.,])\\d+(?:st|nd|rd|th)(?![a-z0-9])|(?:(?<![a-z0-9.,])-)?\\$?(?<![\\d.,])\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?(?:(?:k|mn|m|bn|b|tn|t)(?![a-z]))?|[a-z][a-z.&']*|%", "");
const _QUANTITY_RE: any = new RegExp("^(>=|<=|>|<)?(.+)$", "");
const _DASH_RE: any = new RegExp("[\u2010-\u2015\ufe63\uff0d](?=\\s*\\d)", "");
const _TIME_ZONES: any = "(?:\\s*\\b(?:et|edt|est|ct|cdt|cst|mt|mdt|mst|pt|pdt|pst|utc|gmt)\\b)?";
const _CLOCK_12_RE: any = new RegExp("(?<![\\d.:])(\\d{1,2})(?::([0-5]\\d))?\\s*([ap])\\.?m\\.?(?![a-z])(?:\\s*\\b(?:et|edt|est|ct|cdt|cst|mt|mdt|mst|pt|pdt|pst|utc|gmt)\\b)?", "");
const _CLOCK_24_RE: any = new RegExp("(?<![\\d.:])([01]?\\d|2[0-3]):([0-5]\\d)(?![\\d:])(?:\\s*\\b(?:et|edt|est|ct|cdt|cst|mt|mdt|mst|pt|pdt|pst|utc|gmt)\\b)?", "");
const _BETWEEN_RE: any = new RegExp("\\bbetween\\s+(\\$?-?\\d[\\d.,]*\\s*%?)\\s*(?:and|to|-)\\s*(?=\\$?-?\\d)", "");
const _NAME_PHRASES: any = [[new RegExp("\\breserve bank of australia\\b", "i"), "RBA"], [new RegExp("\\bpeople'?s bank of china\\b", "i"), "PBoC"], [new RegExp("\\bfederal reserve\\b", "i"), "Fed"], [new RegExp("\\bbank of england\\b", "i"), "BoE"], [new RegExp("\\bbank of japan\\b", "i"), "BoJ"], [new RegExp("\\bbank of canada\\b", "i"), "BoC"], [new RegExp("\\beuropean central bank\\b", "i"), "ECB"], [new RegExp("\\bunited states\\b", "i"), "US"], [new RegExp("\\b(?:united kingdom|great britain)\\b", "i"), "UK"]];
const _NAME_ALIASES: any = { "fomc": "fed", "democratic": "democrat", "democrats": "democrat", "dem": "democrat", "dems": "democrat", "republicans": "republican", "gop": "republican", "btc": "bitcoin", "britain": "uk", "british": "uk", "american": "us", "americans": "us", "chinese": "china", "japanese": "japan", "german": "germany", "french": "france", "russian": "russia", "ukrainian": "ukraine", "israeli": "israel", "iranian": "iran", "canadian": "canada", "mexican": "mexico", "brazilian": "brazil", "indian": "india", "korean": "korea", "taiwanese": "taiwan", "european": "europe", "eurozone": "europe", "turkish": "turkey" };
const _COUNTRIES = new Set<string>(["argentina", "australia", "austria", "belarus", "belgium", "brazil", "canada", "chile", "china", "colombia", "cuba", "denmark", "egypt", "england", "eu", "europe", "finland", "france", "gaza", "germany", "greece", "hungary", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy", "japan", "korea", "lebanon", "mexico", "netherlands", "nigeria", "norway", "pakistan", "peru", "philippines", "poland", "portugal", "qatar", "romania", "russia", "saudi", "scotland", "spain", "sweden", "switzerland", "syria", "taiwan", "turkey", "uae", "uk", "ukraine", "venezuela", "vietnam", "yemen"]);
const _LISTED_NAMES = new Set<string>(["argentina", "australia", "austria", "belarus", "belgium", "brazil", "canada", "cash", "chile", "china", "classic", "colombia", "conservative", "core", "cuba", "democrat", "denmark", "east", "egypt", "england", "eu", "europe", "finland", "france", "gaza", "germany", "greece", "headline", "house", "hungary", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy", "japan", "korea", "labour", "lebanon", "mexico", "netherlands", "nigeria", "north", "norway", "pakistan", "peru", "philippines", "poland", "portugal", "primary", "qatar", "republican", "romania", "runoff", "russia", "saudi", "scotland", "senate", "south", "spain", "sweden", "switzerland", "syria", "taiwan", "tory", "turkey", "uae", "uk", "ukraine", "venezuela", "vietnam", "west", "yemen"]);
const _NOT_NAMES = new Set<string>(["can", "could", "friday", "how", "may", "might", "monday", "must", "no", "saturday", "should", "sunday", "thursday", "today", "tomorrow", "tonight", "tuesday", "versus", "vs", "wednesday", "what", "when", "where", "which", "who", "why", "would", "yes"]);
const _COMPARATOR_WORDS = new Set<string>(["above", "atleast", "atmost", "below", "ormore"]);
const inter = <T>(a: Set<T>, b: Set<T>) => new Set([...a].filter(x => b.has(x)));
const diff = <T>(a: Set<T>, b: Set<T>) => new Set([...a].filter(x => !b.has(x)));
const equal = <T>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every(x => b.has(x));
const subset = <T>(a: Set<T>, b: Set<T>) => [...a].every(x => b.has(x));
const sorted = (s: Set<string> | string[]) => [...s].sort();
const repr = (s: unknown): string => Array.isArray(s) ? `[${s.map(repr).join(', ')}]` : typeof s === 'string' ? `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(s);
const list = (s: Set<string> | string[]) => repr(sorted(s));
const reg = (r: RegExp) => new RegExp(r.source, [...new Set(r.flags + 'g')].join(''));
function canonicalNumber(raw: string, scale = 1): string | null { const m = raw.replace(/,/g, '').match(_NUM_RE); if (!m)
    return null; let value = Number(m[2]) * _MULTIPLIERS[m[3] || ''] * scale; if (m[1])
    value = -value; if (!Number.isFinite(value))
    return null; if (Number.isInteger(value))
    return BigInt(value).toString(); const exponent = Math.floor(Math.log10(Math.abs(value))); if (exponent < -4 || exponent >= 12) {
    const [s, e] = value.toExponential(11).split('e');
    return s.replace(/0+$/, '').replace(/\.$/, '') + 'e' + (Number(e) < 0 ? '-' : '+') + String(Math.abs(Number(e))).padStart(2, '0');
} return value.toPrecision(12).replace(/0+$/, '').replace(/\.$/, ''); }
function ascii(text: string): string { return (text || '').replace(/’/g, "'").replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/−/g, '-').replace(reg(_DASH_RE), '-').normalize('NFKD').replace(/[^\x00-\x7F]/g, ''); }
function clockMinutes(hs: string, ms: string | undefined, mer?: string): string | null { let h = Number(hs); const m = Number(ms || 0); if (mer) {
    if (h < 1 || h > 12)
        return null;
    h = h % 12 + (mer === 'p' ? 12 : 0);
} return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }
export function clockTimes(text: string): Set<string> { const low = ascii(text).toLowerCase(), s = new Set<string>(); for (const m of low.matchAll(reg(_CLOCK_12_RE))) {
    const t = clockMinutes(m[1], m[2], m[3]);
    if (t)
        s.add(t);
} for (const m of low.matchAll(reg(_CLOCK_24_RE))) {
    const t = clockMinutes(m[1], m[2]);
    if (t)
        s.add(t);
} return s; }
function prepare(text: string): string { return ascii(text).toLowerCase().replace(reg(_CLOCK_12_RE), ' ').replace(reg(_CLOCK_24_RE), ' ').replace(reg(_BETWEEN_RE), ' atleast $1 and atmost ').replace(new RegExp('\\b(' + Object.keys(_NUMBER_WORDS).join('|') + ')\\b', 'g'), (_m, w) => String(_NUMBER_WORDS[w])).replace(/(\d)\s*%/g, '$1 %').replace(/\b(?:negative|minus)\s+(?=\d)/g, ' -').replace(/>=/g, ' atleast ').replace(/<=/g, ' atmost ').replace(/>/g, ' above ').replace(/</g, ' below ').replace(/(\d)\s*\+/g, '$1 ormore ').replace(/\bat least\b/g, ' atleast ').replace(/\bat most\b/g, ' atmost ').replace(/\blower\s+than\b/g, ' below ').replace(/\bor\s+lower\b/g, ' or below ').replace(/\bno\s+changes?\b/g, ' hold ').replace(/(\d)(bps|bp)\b/g, '$1 $2'); }
function foldWord(raw: string): string { let w = raw.replace(/^[.'&]+|[.'&]+$/g, ''); if (w.endsWith("'s"))
    w = w.slice(0, -2); w = w.replace(/'/g, ''); return _SYNONYMS[w] ?? w; }
function scan(text: string): [
    string,
    string
][] { const raws = [...prepare(text).matchAll(reg(_TOKEN_RE))].map(m => m[0]), out: [
    string,
    string
][] = []; for (let i = 0; i < raws.length;) {
    const raw = raws[i++], last = out.at(-1);
    if (raw === '%' || ['percent', 'pct'].includes(raw) && last && ['number', 'year'].includes(last[1])) {
        if (last && ['number', 'year'].includes(last[1]))
            last[1] = 'percent';
        continue;
    }
    const ordinal = raw.match(_ORDINAL_RE);
    if (ordinal) {
        out.push([`${Number(ordinal[1])}${ordinal[2]}`, 'ordinal']);
        continue;
    }
    if (/^[\d$-]/.test(raw)) {
        let scale = 1;
        if (i < raws.length && raws[i] in _SCALE_WORDS && /\d$/.test(raw))
            scale = _SCALE_WORDS[raws[i++]];
        const n = canonicalNumber(raw, scale);
        if (n === null)
            continue;
        const kind = raw.includes('$') ? 'money' : scale === 1 && /^\d{4}$/.test(raw) && +raw >= 1900 && +raw <= 2100 ? 'year' : 'number';
        out.push([n, kind]);
        continue;
    }
    const w = foldWord(raw);
    if (w)
        out.push([w, 'word']);
} return out; }
export const tokenizePrediction = (text: string) => scan(text).map(([t]) => t);
function comparator(t: string[], i: number): string { let j = i - 1; while (j >= 0 && ['than', 'by', 'the', '$'].includes(t[j]))
    j--; const before = j >= 0 ? t[j] : '', after = t[i + 1] ?? '', after2 = t[i + 2] ?? ''; if (after === 'ormore' || after === 'or' && after2 === 'above')
    return '>='; if (after === 'or' && after2 === 'below')
    return '<='; return ({ above: '>', below: '<', atleast: '>=', atmost: '<=' } as Obj)[before] ?? ''; }
function isMonth(t: string[], k: string[], i: number): boolean { return t[i] !== 'may' ? _MONTHS.has(t[i]) : ['number', 'year', 'ordinal'].includes(k[i + 1] ?? '') || i > 0 && _MAY_BEFORE.has(t[i - 1]); }
function typedQuantity(t: string[], k: string[], i: number, c: string): Obj { const tok = t[i], kind = k[i]; let unit = ({ money: '$', percent: '%' } as Obj)[kind] ?? null, unitRaw = unit, value = tok; if (t[i + 1] === 'bps' && kind === 'number') {
    unit = '%';
    unitRaw = 'bps';
    value = canonicalNumber(String(Number(tok) / 100)) || tok;
} let j = i - 1; while (j >= 0 && ['than', 'the', '$', 'above', 'below', 'atleast', 'atmost'].includes(t[j]))
    j--; return { raw: c + tok, key: c + value, unit, unit_raw: unitRaw, mode: j >= 0 && ['to', 'by'].includes(t[j]) ? t[j] : null, whole: kind !== 'ordinal' && !tok.includes('.') }; }
export function predictionTextFeatures(text: string): Obj { const scanned = scan(text), t = scanned.map(x => x[0]), k = scanned.map(x => x[1]), words = new Set<string>(), quantities = new Set<string>(), typed: Obj[] = [], years = new Set<string>(), days = new Set<string>(), months = new Set<string>(), dated: Record<string, Set<string>> = {}, actions = new Set<string>(), directions = new Set<string>(), poles: Record<string, Set<string>> = {}; let negated = false; scanned.forEach(([tok, kind], i) => { if (kind === 'word') {
    if (_ACTIONS.has(tok))
        actions.add(tok);
    if (tok in _DIRECTIONS)
        directions.add(_DIRECTIONS[tok]);
    if (tok in _POLES) {
        const [axis, pole] = _POLES[tok];
        (poles[axis] ??= new Set()).add(pole);
    }
    if (_MONTHS.has(tok) && isMonth(t, k, i))
        months.add(tok);
    if (_NEGATIONS.has(tok))
        negated = true;
    else if (_COMPARATOR_WORDS.has(tok)) {
        if (['above', 'below'].includes(tok))
            words.add(tok);
    }
    else if (!_STOPWORDS.has(tok))
        words.add(tok);
    return;
} const c = comparator(t, i), digits = kind === 'ordinal' ? tok.slice(0, -2) : tok, day = ['number', 'ordinal'].includes(kind) && /^\d+$/.test(digits) && +digits >= 1 && +digits <= 31 ? String(Number(digits)) : null; if (kind === 'year' && !c)
    years.add(tok);
else if (i > 0 && _MONTHS.has(t[i - 1]) && isMonth(t, k, i - 1) && day !== null) {
    days.add(day);
    (dated[t[i - 1]] ??= new Set()).add(day);
}
else {
    quantities.add(c + tok);
    typed.push(typedQuantity(t, k, i, c));
} }); return { words, quantities, typed, years, days, months, dated, actions, directions, poles, negated, order: [...new Set(typed.map(q => q.key))], times: clockTimes(text) }; }
const text = (m: Obj, ...keys: string[]) => keys.map(k => m[k]).filter(s => typeof s === 'string' && s).join(' ');
function aliasPhrases(s: string): string { for (const [p, a] of _NAME_PHRASES)
    s = s.replace(reg(p), ` ${a} `); return s; }
function names(...texts: string[]): Set<string> { const out = new Set<string>(); for (const t of texts)
    for (const m of aliasPhrases(ascii(t)).matchAll(/[A-Za-z][A-Za-z.&']*/g)) {
        const raw = m[0], fold = foldWord(raw.toLowerCase()), w = _NAME_ALIASES[fold] ?? fold;
        if (w.length < 2 || _STOPWORDS.has(w) || _NOT_NAMES.has(w) || _MONTHS.has(w) || _ACTIONS.has(w) || w in _DIRECTIONS || _COMPARATOR_WORDS.has(w) || w in _POLES || _NEGATIONS.has(w) || w in _NUMBER_WORDS)
            continue;
        if (_LISTED_NAMES.has(w) || /^[A-Z]/.test(raw))
            out.add(w);
    } return out; }
function marketFeatures(m: Obj, venue: string): Obj { const bagText = venue === 'kalshi' ? text(m, 'question', 'context', 'yes_side') : text(m, 'question', 'context'), gateTexts = venue === 'kalshi' ? [m.question || '', m.yes_side || ''] : [m.question || ''], bag = predictionTextFeatures(bagText), gate = predictionTextFeatures(gateTexts.filter(t => typeof t === 'string').join(' ')), present = new Set(scan(aliasPhrases(ascii(bagText))).filter(([, k]) => k === 'word').map(([t]) => _NAME_ALIASES[t] ?? t)), actions = new Set<string>(gate.actions); if (actions.has('hold') && !inter(present, _RATE_CONTEXT).size)
    actions.delete('hold'); const outcomes = (m.outcomes || []).map(String), question = predictionTextFeatures(text(m, 'question')), end = m.end_time ? Date.parse(String(m.end_time).replace(' ', 'T')) : NaN; return { bag, actions, directions: gate.directions, poles: gate.poles, names: names(...gateTexts.filter(t => typeof t === 'string')), present, order: question.order, question_words: question.words, side_words: diff(questionSide(m), new Set(['bps'])), outcomes, labels: outcomes.map((o: string) => new Set(tokenizePrediction(o))), end: Number.isFinite(end) ? end : null }; }
const questionSide = (m: Obj): Set<string> => predictionTextFeatures(text(m, 'yes_side')).words;
function sideAlignment(k: Obj, p: Obj): [
    string | null,
    string
] { const side: Set<string> = k.side_words, outcomes: string[] = p.outcomes, labels: Set<string>[] = p.labels, question: Set<string> = p.question_words; if (outcomes.length === 2 && equal(new Set(outcomes.map(o => o.toLowerCase())), _YES_NO)) {
    if (side.size && !subset(side, question))
        return [null, `Kalshi YES side ${list(side)} not named in Polymarket question (missing ${list(diff(side, question))})`];
    return side.size ? ['aligned', `Kalshi YES side ${list(side)} named in Polymarket question`] : ['aligned', 'both venues price YES on the question as worded'];
} if (outcomes.length !== 2)
    return [null, `Polymarket market has ${outcomes.length} outcomes, not a binary pair`]; const s = side.size ? side : k.question_words, hits = labels.map(l => !!inter(s, diff(l, _STOPWORDS)).size); if (hits[0] && !hits[1])
    return ['aligned', `Kalshi YES side matches Polymarket outcome ${repr(outcomes[0])}`]; if (!hits[0] && hits[1])
    return ['inverted', `Kalshi YES side matches Polymarket outcome ${repr(outcomes[1])} (second outcome; price flipped)`]; if (hits[0] && hits[1])
    return [null, `Kalshi YES side matches both Polymarket outcomes ${repr(outcomes)}`]; return [null, `Kalshi YES side ${list(s)} matches neither Polymarket outcome ${repr(outcomes)}`]; }
function thresholdClass(q: string): string { const m = q.match(_QUANTITY_RE)!; return m[1] && m[2].includes('.') ? (m[1][0] === '>' ? 'above' : 'below') + m[2] : q; }
function quantitiesGate(k: Obj, p: Obj): [
    string,
    string
] { const kr = sorted(k.quantities), pr = sorted(p.quantities), kk = new Set<string>(k.typed.map((q: Obj) => q.key)), pk = new Set<string>(p.typed.map((q: Obj) => q.key)); if (JSON.stringify(kr) === JSON.stringify(pr))
    return ['agree', kr.length ? `quantities agree ${repr(kr)}` : '']; if (equal(kk, pk))
    return ['agree', `quantities agree once bps are read as percent: Kalshi ${repr(kr)} vs Polymarket ${repr(pr)}`]; if (kr.length === pr.length && equal(new Set(kr.map(thresholdClass)), new Set(pr.map(thresholdClass))) || kk.size === pk.size && equal(new Set(k.typed.map((q: Obj) => q.whole ? q.key : thresholdClass(q.key))), new Set(p.typed.map((q: Obj) => q.whole ? q.key : thresholdClass(q.key)))))
    return ['boundary', `quantities agree except at the boundary: Kalshi ${repr(kr)} vs Polymarket ${repr(pr)} (the same unless the outcome lands exactly on the threshold)`]; return ['differ', `quantities differ: Kalshi ${repr(kr)} vs Polymarket ${repr(pr)}`]; }
function byKey(typed: Obj[], field: string, key: string): Record<string, Set<string>> { const out: Record<string, Set<string>> = {}; for (const q of typed)
    if (q[field] !== null)
        (out[thresholdClass(q[key])] ??= new Set()).add(q[field]); return out; }
function lateGates(k: Obj, p: Obj): string | null { const kb = k.bag, pb = p.bag; if (kb.times.size && pb.times.size && !equal(kb.times, pb.times))
    return `clock times differ: Kalshi ${list(kb.times)} vs Polymarket ${list(pb.times)}`; if (kb.months.size && pb.months.size && !inter(kb.months, pb.months).size)
    return `months differ: Kalshi ${list(kb.months)} vs Polymarket ${list(pb.months)}`; for (const month of Object.keys(kb.dated).filter(m => m in pb.dated).sort())
    if (!equal(kb.dated[month], pb.dated[month]))
        return `days differ in ${month}: Kalshi ${repr([...kb.dated[month]].sort((a, b) => +a - +b))} vs Polymarket ${repr([...pb.dated[month]].sort((a, b) => +a - +b))}`; for (const [field, key, what] of [['unit', 'key', 'units'], ['unit_raw', 'raw', 'units'], ['mode', 'key', "kinds ('to' a level vs 'by' a change)"]]) {
    const a = byKey(kb.typed, field, key), b = byKey(pb.typed, field, key);
    for (const q of Object.keys(a).filter(q => q in b).sort())
        if (!inter(a[q], b[q]).size)
            return `quantity ${what} differ for ${q}: Kalshi ${list(a[q])} vs Polymarket ${list(b[q])}`;
} if (k.order.length >= 2 && equal(new Set(k.order), new Set(p.order)) && JSON.stringify(k.order) !== JSON.stringify(p.order))
    return `quantities in a different order: Kalshi ${repr(k.order)} vs Polymarket ${repr(p.order)}`; for (const axis of Object.keys(k.poles).filter(x => x in p.poles).sort())
    if (!equal(k.poles[axis], p.poles[axis]))
        return `opposite wording: Kalshi ${list(k.poles[axis])} vs Polymarket ${list(p.poles[axis])}`; const ke = diff<string>(k.names, p.present), pe = diff<string>(p.names, k.present), kl = inter(ke, _LISTED_NAMES), pl = inter(pe, _LISTED_NAMES); if (kl.size || pl.size)
    return `a listed name on one venue only: Kalshi ${list(kl)} vs Polymarket ${list(pl)}`; if (ke.size && pe.size)
    return `distinguishing names differ: Kalshi ${list(ke)} vs Polymarket ${list(pe)}`; return null; }
function score(k: Obj, p: Obj, now: number): Obj { const kb = k.bag, pb = p.bag, reasons: string[] = [], reject = (reason: string) => { reasons.push(reason); return { confidence: 0, rejected: true, reasons, side: null, boundary_differs: false }; }, shared = inter(kb.words, pb.words), union = kb.words.size + pb.words.size, dice = union ? 2 * shared.size / union : 0; reasons.push(`title word overlap ${dice.toFixed(2)} (dice; ${shared.size} shared of ${kb.words.size} Kalshi / ${pb.words.size} Polymarket words)`); const [verdict, why] = quantitiesGate(kb, pb); if (verdict === 'differ')
    return reject(why); if (why)
    reasons.push(why); if (kb.years.size && pb.years.size && !inter(kb.years, pb.years).size)
    return reject(`years differ: Kalshi ${list(kb.years)} vs Polymarket ${list(pb.years)}`); if (kb.negated !== pb.negated)
    return reject('negation differs (one title says not/no/never/without, the other does not)'); if (!equal(k.actions, p.actions))
    return reject(`actions differ: Kalshi ${list(k.actions)} vs Polymarket ${list(p.actions)}`); if (k.actions.size)
    reasons.push(`actions agree ${list(k.actions)}`); if (!equal(k.directions, p.directions))
    return reject(`directions differ: Kalshi ${list(k.directions)} vs Polymarket ${list(p.directions)}`); if (k.directions.size)
    reasons.push(`directions agree ${list(k.directions)}`); if (k.end === null || p.end === null)
    return reject('end date missing on one venue; cannot confirm the same event window'); const gap = Math.abs(k.end - p.end) / 86400000, horizon = Math.max(0, (Math.max(k.end, p.end) - now) / 86400000), tolerance = Math.max(3, .15 * horizon); if (gap > tolerance)
    return reject(`end dates ${gap.toFixed(1)} days apart (tolerance ${tolerance.toFixed(1)} days)`); const factor = 1 - .5 * gap / tolerance; reasons.push(`end dates ${gap.toFixed(1)} days apart (tolerance ${tolerance.toFixed(1)} days)`); const [side, reason] = sideAlignment(k, p); if (side === null)
    return reject(reason); reasons.push(reason); const late = lateGates(k, p); if (late)
    return reject(late); return { confidence: pyRound(dice * factor, 3), rejected: false, reasons, side, boundary_differs: verdict === 'boundary' }; }
export const scorePredictionPair = (k: Obj, p: Obj, now = Date.now()) => score(marketFeatures(k, 'kalshi'), marketFeatures(p, 'polymarket'), now);
function candidatePairs(ks: Obj[], ps: Obj[], minDice: number): [
    number,
    number
][] { const t = Math.min(1, Math.max(0, minDice)), df: Record<string, number> = {}; for (const f of [...ks, ...ps])
    for (const w of f.bag.words)
        df[w] = (df[w] ?? 0) + 1; const prefix = (words: Set<string>) => { const a = [...words].sort((a, b) => df[a] - df[b] || (a < b ? -1 : a > b ? 1 : 0)), need = Math.ceil(t * a.length / (2 - t) - 1e-9); return a.slice(0, a.length - Math.max(need, 1) + 1); }, index = new Map<string, number[]>(); ps.forEach((f, i) => { for (const w of prefix(f.bag.words)) {
    if (!index.has(w))
        index.set(w, []);
    index.get(w)!.push(i);
} }); const pairs = new Set<string>(); ks.forEach((f, ki) => { for (const w of prefix(f.bag.words))
    for (const pi of index.get(w) ?? [])
        pairs.add(`${ki}:${pi}`); }); return [...pairs].map(s => s.split(':').map(Number) as [
    number,
    number
]).sort((a, b) => a[0] - b[0] || a[1] - b[1]); }
export function predictionBrief(m: Obj): Obj { return { ...Object.fromEntries(['id', 'question', 'outcomes', 'end_time', 'probability', 'price_basis', 'yes_bid', 'yes_ask', 'spread', 'last_price', 'last_trade_time', 'url'].map(k => [k, m[k] ?? null])), yes_side: m.yes_side || null, stale: !!m.stale, stale_age_seconds: m.stale ? m.stale_age_seconds ?? null : null }; }
const flip = (v: unknown) => typeof v === 'number' ? pyRound(1 - v, 4) : null;
function alignedBrief(m: Obj, side: string): Obj { const b = predictionBrief(m), outcomes = b.outcomes || []; if (side === 'inverted' && outcomes.length === 2)
    Object.assign(b, { probability: flip(m.probability), yes_bid: flip(m.yes_ask), yes_ask: flip(m.yes_bid), last_price: flip(m.last_price), quoted_outcome: outcomes[1] });
else
    b.quoted_outcome = outcomes[0] ?? null; return b; }
function quoteFlags(venue: string, m: Obj): string[] { if (m.probability == null)
    return [`${venue} price unavailable (basis: ${m.price_basis || 'not stated'})`]; const flags: string[] = []; if (m.stale) {
    const age = typeof m.stale_age_seconds === 'number' ? `${(m.stale_age_seconds / 3600).toFixed(1)} h old` : 'of unknown age';
    flags.push(`${venue} price from a copy ${age}, served from expired cache after a failed live fetch`);
} if (m.price_basis !== 'bid_ask_midpoint')
    flags.push(`${venue} price is not a two-sided quote midpoint (basis: ${m.price_basis || 'not stated'})`); if (typeof m.spread === 'number' && m.spread > .1)
    flags.push(`${venue} bid/ask spread ${m.spread.toFixed(2)} is wider than 0.10`); return flags; }
function pairRecord(k: Obj, p: Obj, r: Obj): Obj { const kp = k.probability ?? null, pr = p.probability ?? null, pa = pr === null ? null : r.side === 'inverted' ? pyRound(1 - pr, 4) : pr, gap = kp !== null && pa !== null ? pyRound(kp - pa, 4) : null, flags = [...quoteFlags('kalshi', k), ...quoteFlags('polymarket', p)]; if (r.boundary_differs)
    flags.push('thresholds differ at the boundary (strict on one venue, inclusive on the other)'); return { match_confidence: r.confidence, reasons: r.reasons, side: r.side, kalshi: predictionBrief(k), polymarket: alignedBrief(p, r.side), kalshi_yes_probability: kp, polymarket_yes_probability: pa, price_gap: gap, flags, comparable: gap !== null && !flags.length }; }
export function matchPredictionMarkets(kalshi: Obj[], polymarket: Obj[], minConfidence = .6, now = Date.now(), nearMissLimit = 10): Obj { const kf = kalshi.map(m => marketFeatures(m, 'kalshi')), pf = polymarket.map(m => marketFeatures(m, 'polymarket')), candidates = candidatePairs(kf, pf, Math.min(minConfidence, .5) - .001), scored: [
    number,
    number,
    number,
    Obj
][] = [], near: [
    number,
    number,
    number,
    Obj
][] = []; for (const [ki, pi] of candidates) {
    const r = score(kf[ki], pf[pi], now);
    if (!r.rejected && r.confidence >= minConfidence)
        scored.push([r.confidence, ki, pi, r]);
    else {
        const ov = Number(r.reasons[0].match(/^title word overlap ([0-9.]+)/)?.[1] ?? 0);
        if (!r.rejected)
            r.reasons.push(`confidence ${r.confidence.toFixed(3)} below threshold ${minConfidence}`);
        near.push([ov, ki, pi, r]);
    }
} scored.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]); const uk = new Set<number>(), up = new Set<number>(), matched: Obj[] = []; for (const [, ki, pi, r] of scored) {
    if (uk.has(ki) || up.has(pi))
        continue;
    uk.add(ki);
    up.add(pi);
    matched.push(pairRecord(kalshi[ki], polymarket[pi], r));
} near.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]); return { matched, near_misses: near.slice(0, nearMissLimit).map(([ov, ki, pi, r]) => ({ kalshi: predictionBrief(kalshi[ki]), polymarket: predictionBrief(polymarket[pi]), title_overlap: pyRound(ov, 3), reasons: r.reasons })), pairs_scored: candidates.length, unmatched_kalshi: kalshi.length - uk.size, unmatched_polymarket: polymarket.length - up.size, min_confidence: minConfidence }; }
