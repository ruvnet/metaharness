// SPDX-License-Identifier: MIT
//
// synthetic.mjs — $0, offline, deterministic test fixtures for the ADR-201 ablation.
//   • makeSyntheticManifest(n, seed) — n RAG-QA tasks, each with a corpus of distractors + one
//     gold passage carrying an "ANSWER=<token>" marker and question keywords. No network, no gold
//     ever leaks into a prompt (the answer lives in the CORPUS, which is what RAG is allowed to see;
//     the SEPARATE task.answer field is for the offline scorer only).
//   • mockLlm({tier}) — a deterministic LLM stand-in that "reads" the CONTEXT and extracts the
//     ANSWER marker if retrieval surfaced the gold passage. Lets us prove A/B wiring + telemetry
//     math end-to-end at $0. `escalate` tier just costs more (models the Opus-bail cost without $).
//   • normalizeAnswer — GAIA/FRAMES-style normalization for the offline scorer.

/** Mulberry32 — tiny deterministic PRNG. */
export function mkRng(seed = 42) {
  let s = seed >>> 0;
  return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const TOPICS = ['photosynthesis', 'tectonics', 'monsoon', 'glycolysis', 'supernova', 'inflation',
  'mitochondria', 'aqueduct', 'cartography', 'thermocline', 'capacitor', 'meridian', 'isotope',
  'tributary', 'pollination', 'sediment', 'refraction', 'antibody', 'turbine', 'pendulum'];
const FILLER = ['the system involves several interacting components', 'historically this was first described',
  'researchers note that conditions vary by region', 'a common misconception is often repeated',
  'the process unfolds over multiple stages', 'measurements depend on the instrument used',
  'context matters when interpreting the result', 'edge cases complicate the general rule'];

/** Build n tasks. Each task: { id, question, answer, corpus:[{id,text}] }. */
export function makeSyntheticManifest(n, seed = 42) {
  const rng = mkRng(seed);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const answer = `${topic}-${(Math.floor(rng() * 9000) + 1000)}`;             // distinctive answer token
    const corpus = [];
    const nDocs = 6 + Math.floor(rng() * 6);                                    // 6–11 passages
    const goldIdx = Math.floor(rng() * nDocs);
    for (let d = 0; d < nDocs; d++) {
      if (d === goldIdx) {
        // GOLD passage: topic keywords + the ANSWER marker (this is legitimate RAG corpus content).
        corpus.push({ id: `t${i}-d${d}`, text: `Regarding ${topic}: the definitive ${topic} value is recorded as ANSWER=${answer}. ${pick(FILLER)}.` });
      } else {
        const other = pick(TOPICS);
        corpus.push({ id: `t${i}-d${d}`, text: `Notes on ${other} and ${topic}: ${pick(FILLER)}; ${pick(FILLER)}.` });
      }
    }
    tasks.push({ id: `synth-${i}`, question: `What is the definitive recorded value for ${topic}?`, answer, corpus });
  }
  return tasks;
}

/** Deterministic mock LLM. Reads CONTEXT, extracts ANSWER=<...> if present. */
export function mockLlm({ tier = 'base' } = {}) {
  const cost = tier === 'escalate' ? 0.004 : 0.0004;                            // models cheap vs Opus $
  return async function (messages) {
    const ctx = messages.map((m) => m.content).join('\n');
    const m = ctx.match(/ANSWER=([^\s.]+)/);                                    // present iff gold passage retrieved
    const raw = m ? `FINAL_ANSWER: ${m[1]}` : 'FINAL_ANSWER: unknown';
    return { raw, cost };
  };
}

/** GAIA/FRAMES-style answer normalization. */
export function normalizeAnswer(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
