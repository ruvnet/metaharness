// SPDX-License-Identifier: MIT
//
// Keyless Wikipedia tool surface for the GAIA-class agentic solver (solve-gaia.mjs).
// Realizes the ADAPTER.md §3b tool surface (web_search / web_browse) using the
// MediaWiki API — NO search-API key required, fully reproducible, polite UA.
//
// Why Wikipedia: the open GAIA-class benchmark we run (Google FRAMES,
// google/frames-benchmark) is a multi-hop general-assistant QA set whose gold
// evidence is Wikipedia. A keyless wiki search+read tool is therefore both the
// honest tool surface for the task AND a $0-infra retrieval channel (matches the
// "everyday-agentic, tool-use" thesis without leaking gold answers).
//
// Two tools, both return a string OBSERVATION fed back to the model:
//   searchWiki(query)        -> top page titles + snippets (action=query&list=search)
//   openWiki(title, query?)  -> plaintext extract; if query given, the best ~window
//
// Pure HTTP, no deps. Each call retries with backoff and caps output length.

const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'darwin-frames-bench/1.0 (https://github.com/ruvnet/agent-harness-generator; research)';
const TIMEOUT_MS = 20000;

async function getJson(params, attempts = 4) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`;
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    if (a) await new Promise((r) => setTimeout(r, 800 * 2 ** (a - 1)));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) { if (res.status === 429 || res.status >= 500) { lastErr = new Error(`http ${res.status}`); continue; } throw new Error(`http ${res.status}`); }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('wiki fetch failed');
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
const cap = (s, n) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

/** Full-text search: returns up to `limit` "Title — snippet" lines. */
export async function searchWiki(query, { limit = 6 } = {}) {
  if (!query || !String(query).trim()) return 'search error: empty query';
  try {
    const j = await getJson({ action: 'query', list: 'search', srsearch: String(query), srlimit: String(limit), srprop: 'snippet' });
    const hits = j?.query?.search ?? [];
    if (!hits.length) return `(no results for "${query}")`;
    return hits.map((h, i) => `${i + 1}. ${h.title} — ${stripTags(h.snippet)}`).join('\n');
  } catch (e) { return `search error: ${String(e.message || e).slice(0, 160)}`; }
}

/**
 * Read a page as plaintext. If `query` is given and the article is long, return
 * the ~MAX_OUT window centered on the best keyword match (so the model can drill
 * into a long article without burning the whole context). Otherwise the intro+.
 */
export async function openWiki(title, query, { MAX_OUT = 6000 } = {}) {
  if (!title || !String(title).trim()) return 'open error: empty title';
  try {
    const j = await getJson({ action: 'query', prop: 'extracts', explaintext: '1', redirects: '1', titles: String(title) });
    const pages = j?.query?.pages ?? {};
    const page = Object.values(pages)[0];
    if (!page || page.missing !== undefined) {
      const alt = await searchWiki(title, { limit: 5 });
      return `open: no exact page "${title}". Closest matches (use the exact title with open):\n${alt}`;
    }
    const text = String(page.extract || '');
    if (!text.trim()) return `open: page "${page.title}" has no text extract.`;
    if (text.length <= MAX_OUT || !query) return `# ${page.title}\n${cap(text, MAX_OUT)}`;
    // Long article + a focusing query: find the best window around the query terms.
    const terms = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const lower = text.toLowerCase();
    let best = 0, bestScore = -1;
    for (let i = 0; i < text.length; i += 500) {
      const win = lower.slice(i, i + MAX_OUT);
      const score = terms.reduce((s, t) => s + (win.split(t).length - 1), 0);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    const start = Math.max(0, best - 200);
    return `# ${page.title} [windowed on query; ${text.length} chars total]\n${cap(text.slice(start, start + MAX_OUT), MAX_OUT)}`;
  } catch (e) { return `open error: ${String(e.message || e).slice(0, 160)}`; }
}
