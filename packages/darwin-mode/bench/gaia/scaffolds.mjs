// SPDX-License-Identifier: MIT
//
// scaffolds.mjs — agent-scaffolding INTELLIGENCE upgrades for the GAIA-class
// ReAct solver (solve-gaia.mjs). The question this answers: does a better
// reasoning loop raise CHEAP-model resolve on multi-hop QA, and at what cost?
//
// Three well-established scaffolds, each a TOGGLE on the SAME base ReAct episode
// (search→open→submit over keyless Wikipedia). All are PROMPT-level / orchestration
// scaffolds — they do NOT enable the OpenRouter `reasoning` API param, so they stay
// consistent with the prior reasoning-OFF FRAMES runs (only the *loop* changes).
//
//   none          base ReAct (byte-identical to solve-gaia's original loop)
//   reflexion     Shinn et al. 2023 — on a low-confidence / empty answer, generate a
//                 verbal self-reflection on what went wrong, then retry (capped rounds).
//                 The retry trigger is GOLD-FREE: it uses the model's OWN confidence
//                 self-rating + empty/no-submit, never the gold answer.
//   plan          Wang et al. 2023 (Plan-and-Solve) — one explicit planning call
//                 decomposes the question into sub-goals BEFORE the ReAct loop; the
//                 plan is injected into the episode header.
//   verifier-bon  Verifier-gated self-consistency / Best-of-N — sample N independent
//                 episodes (temp>0 for diversity), then a VERIFIER call selects the
//                 best answer. We also compute the naive MAJORITY VOTE so the report
//                 can quantify the generation–verification gap (does the verifier beat
//                 the vote?). Both are gold-free (verifier sees candidates+notes only).
//
// PURE + dependency-injected: no fetch / no fs of its own. solve-gaia.mjs wires the
// real llm()/tools; mockDeps() below wires a deterministic offline LLM so the whole
// matrix can be wiring-tested at $0 (node solve-gaia.mjs --mock --scaffold ...).
//
// CONFORMANCE: the gold `answer` is NEVER read here. Every scaffold sees only
// task.question and tool observations. (Asserted by the absence of `.answer` below.)

// ── Base system prompts ────────────────────────────────────────────────────────
// The base SYSTEM is byte-identical to solve-gaia.mjs's original (so --scaffold none
// reproduces the published base run exactly). Exported so solve-gaia imports one copy.
export const BASE_SYSTEM =
    'You are a meticulous research assistant answering a hard, multi-step question by '
  + 'searching and reading Wikipedia. Each turn, output EXACTLY ONE JSON object on a single line — a '
  + 'tool call — and NOTHING else (no prose, no markdown). Tools:\n'
  + '{"tool":"search","query":"..."}                 full-text Wikipedia search → top titles + snippets\n'
  + '{"tool":"open","title":"Exact Page Title","query":"what you are looking for"}  read a page as plaintext (query focuses a long article)\n'
  + '{"tool":"submit","answer":"..."}                give your FINAL short answer and stop\n'
  + 'Strategy: decompose the question, search for each entity, open the relevant pages, chain the facts '
  + 'across pages (multi-hop), then submit. Keep the final answer SHORT and exact (a name, number, date, '
  + 'or short phrase) — no explanation, no units unless asked, no trailing punctuation. Output ONE JSON action per turn.';

const cap = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + `\n…[truncated]` : String(s ?? ''));

// ── The shared base ReAct episode ──────────────────────────────────────────────
// One bounded search→open→submit episode for a single question. `memo` (optional)
// is injected verbatim into the header (used by reflexion to carry a self-reflection,
// and by plan to carry the decomposition). Returns the full telemetry one episode
// produced, including its salvage answer if it never submitted.
//
// deps: { llm, searchWiki, openWiki, parseAction, stateHash }
//   llm(messages, temp) -> { raw, cost }
export async function runEpisode(task, deps, { system = BASE_SYSTEM, maxSteps = 12, maxOut = 6000, temp = 0, memo = '' } = {}) {
  const { llm, searchWiki, openWiki, parseAction, stateHash } = deps;
  const transcript = [];
  let submitted = false, answer = '', cost = 0;
  const seen = new Set();
  const header = (memo ? memo + '\n\n' : '') + `QUESTION:\n${task.question}\n\nBegin. Output ONE JSON action.`;
  for (let step = 1; step <= maxSteps && !submitted; step++) {
    const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-14000);
    const messages = [{ role: 'system', content: system }, { role: 'user', content: convo }];
    let raw = '';
    try { const r = await llm(messages, temp); raw = r.raw; cost += r.cost || 0; }
    catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
    const action = parseAction(raw);
    let obs;
    if (action.tool === 'submit') { submitted = true; answer = String(action.answer ?? '').trim(); obs = 'submitted.'; }
    else if (action.tool === 'search') obs = await searchWiki(action.query, { limit: 6 });
    else if (action.tool === 'open') obs = await openWiki(action.title, action.query, { MAX_OUT: maxOut });
    else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
    else obs = `error: unknown tool "${action.tool}". Valid: search, open, submit.`;
    if (action.tool === 'search' || action.tool === 'open') {
      const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
      if (seen.has(h)) obs += '\n⚠️ You already ran this exact action with this result. Change strategy or submit.';
      else seen.add(h);
    }
    transcript.push({ actionRaw: JSON.stringify(action).slice(0, 300), obs });
  }
  // Salvage: if it never submitted, ask once for a final answer from its notes.
  if (!submitted) {
    try {
      const r = await llm([{ role: 'system', content: 'Give ONLY the final short answer to the question, no explanation.' },
        { role: 'user', content: `QUESTION:\n${task.question}\n\nYour research notes:\n${transcript.map((t) => t.obs).join('\n').slice(-8000)}\n\nFinal short answer:` }], 0);
      cost += r.cost || 0; answer = (r.raw || '').trim().split('\n')[0].slice(0, 300);
    } catch { /* leave empty */ }
  }
  return { answer, steps: transcript.length, cost, submitted, transcript };
}

const notesOf = (ep) => ep.transcript.map((t) => t.obs).join('\n').slice(-3500);

// ── Plan-and-Solve ──────────────────────────────────────────────────────────────
// One planning call decomposes the question into ordered sub-goals; the plan is
// injected into the episode header so the ReAct loop follows it.
export async function planAndSolve(task, deps, opts = {}) {
  const { llm } = deps;
  let cost = 0, plan = '';
  try {
    const r = await llm([
      { role: 'system', content: 'You are a planner. Given a hard multi-hop question, write a SHORT numbered plan (3-6 steps) that decomposes it into sub-questions / entities to look up on Wikipedia and the order to chain them. Output ONLY the plan, no answer.' },
      { role: 'user', content: `QUESTION:\n${task.question}\n\nPlan:` }], 0.3);
    cost += r.cost || 0; plan = (r.raw || '').trim().slice(0, 1200);
  } catch { /* fall through to plain episode */ }
  const memo = plan ? `PLAN (decomposition to follow; revise if a step proves wrong):\n${plan}` : '';
  const ep = await runEpisode(task, deps, { ...opts, memo });
  return { answer: ep.answer, steps: ep.steps, cost: cost + ep.cost, submitted: ep.submitted, episodes: 1, plan, extra: { plan_chars: plan.length } };
}

// ── Reflexion ────────────────────────────────────────────────────────────────────
// Run an episode; self-rate confidence (GOLD-FREE); if low/empty and rounds remain,
// generate a verbal reflection and retry with it injected. Keep the highest-confidence
// non-empty answer.
export async function reflexion(task, deps, { rounds = 2, tau = 0.7, ...opts } = {}) {
  const { llm } = deps;
  let cost = 0, memo = '', episodes = 0;
  const attempts = [];
  for (let round = 0; round <= rounds; round++) {
    const ep = await runEpisode(task, deps, { ...opts, memo });
    cost += ep.cost; episodes++;
    // Self-confidence (gold-free): the model rates its OWN answer + names a failure mode.
    let conf = ep.answer ? 0.5 : 0.0, reflection = '';
    try {
      const r = await llm([
        { role: 'system', content: 'You are a strict self-evaluator. Given a question, a proposed short answer, and the research notes, output a single JSON object: {"confidence":0.0-1.0,"reflection":"<one sentence: what is most likely wrong or missing, and what to search/verify next>"}. Be skeptical: only give high confidence if the notes clearly support the answer.' },
        { role: 'user', content: `QUESTION:\n${task.question}\n\nPROPOSED ANSWER: ${ep.answer || '(none)'}\n\nNOTES:\n${notesOf(ep)}\n\nJSON:` }], 0);
      cost += r.cost || 0;
      const m = (r.raw || '').match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); const c = Number(j.confidence); if (Number.isFinite(c)) conf = Math.max(0, Math.min(1, c)); reflection = String(j.reflection || '').slice(0, 400); }
    } catch { /* keep heuristic conf */ }
    attempts.push({ answer: ep.answer, conf, steps: ep.steps, submitted: ep.submitted });
    if (ep.answer && conf >= tau) break;            // confident enough → stop early
    if (round === rounds) break;                     // out of retries
    memo = `PRIOR ATTEMPT (was wrong or unverified — DO NOT repeat it):\nanswer="${ep.answer || '(none)'}"\nSELF-REFLECTION: ${reflection || 'the answer was empty or unsupported; search more specifically and verify the chain.'}\nUse this to change your strategy this time.`;
  }
  // Pick the highest-confidence NON-EMPTY answer; tie-break to the latest.
  let best = attempts.filter((a) => a.answer).sort((a, b) => b.conf - a.conf)[0] || attempts[attempts.length - 1];
  const totalSteps = attempts.reduce((s, a) => s + a.steps, 0);
  return { answer: best.answer || '', steps: totalSteps, cost, submitted: best.submitted, episodes,
    extra: { rounds_used: episodes, confidences: attempts.map((a) => Math.round(a.conf * 100) / 100) } };
}

// ── Verifier-gated self-consistency (Best-of-N) ──────────────────────────────────
// N independent episodes (temp>0 for diversity) → a VERIFIER call selects the best.
// Also computes the naive majority vote so we can measure the generation-verification
// gap. Verifier + vote are both gold-free.
const normForVote = (s) => String(s ?? '').toLowerCase().replace(/[$%,]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

export async function verifierBoN(task, deps, { samples = 3, sampleTemp = 0.7, ...opts } = {}) {
  const { llm } = deps;
  const eps = [];
  let cost = 0;
  for (let i = 0; i < samples; i++) {
    const ep = await runEpisode(task, deps, { ...opts, temp: sampleTemp });
    cost += ep.cost; eps.push(ep);
  }
  const cands = eps.map((ep, i) => ({ i, answer: ep.answer, notes: notesOf(ep), submitted: ep.submitted }));
  // Majority vote over normalized non-empty answers.
  const tally = new Map();
  for (const c of cands) { const k = normForVote(c.answer); if (!k) continue; tally.set(k, (tally.get(k) || 0) + 1); }
  let voteKey = '', voteN = 0; for (const [k, n] of tally) if (n > voteN) { voteN = n; voteKey = k; }
  const majorityAnswer = (cands.find((c) => normForVote(c.answer) === voteKey) || cands.find((c) => c.answer) || cands[0]).answer || '';
  // Verifier: pick the best candidate index given question + each candidate's answer & notes.
  let verifierAnswer = majorityAnswer, pickedIdx = -1;
  const nonEmpty = cands.filter((c) => c.answer);
  if (nonEmpty.length <= 1) { verifierAnswer = nonEmpty[0]?.answer || ''; pickedIdx = nonEmpty[0]?.i ?? -1; }
  else {
    try {
      const list = cands.map((c) => `[#${c.i}] answer="${c.answer || '(none)'}"\n notes: ${cap(c.notes, 900)}`).join('\n\n');
      const r = await llm([
        { role: 'system', content: 'You are a verifier. Given a question and several candidate answers each with the research notes that produced them, choose the candidate whose answer is BEST SUPPORTED by its notes (most likely correct). Output ONLY a JSON object {"best":<index>,"answer":"<that candidate\'s short answer, cleaned>"}.' },
        { role: 'user', content: `QUESTION:\n${task.question}\n\nCANDIDATES:\n${list}\n\nJSON:` }], 0);
      cost += r.cost || 0;
      const m = (r.raw || '').match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); pickedIdx = Number(j.best); const picked = cands.find((c) => c.i === pickedIdx); verifierAnswer = (j.answer && String(j.answer).trim()) || picked?.answer || majorityAnswer; }
    } catch { /* fall back to majority */ }
  }
  const totalSteps = eps.reduce((s, e) => s + e.steps, 0);
  return { answer: verifierAnswer, steps: totalSteps, cost, submitted: eps.some((e) => e.submitted), episodes: samples,
    extra: { samples, majority_answer: majorityAnswer, majority_votes: voteN, verifier_pick: pickedIdx, candidate_answers: cands.map((c) => c.answer) } };
}

// ── Fail-fast: short 2-turn episode, drop + respawn on empty ─────────────────────
// A deliberately CHEAP, SHALLOW arm: cap each episode at `shortSteps` turns, then
// (via runEpisode's salvage) force a final answer. If the answer is empty, DROP the
// episode and RESPAWN a fresh one (new temp>0 sample) up to `respawns` times; keep the
// first non-empty answer. Trades depth for cost: great on easy lookups, expected to
// FAIL on deep multi-hop chains (which is the signal the router should learn to avoid).
// GOLD-FREE: the respawn trigger is the empty-answer heuristic only, never correctness.
export async function failFast(task, deps, { respawns = 2, shortSteps = 2, sampleTemp = 0.7, ...opts } = {}) {
  let cost = 0, episodes = 0, answer = '', submitted = false, steps = 0;
  for (let attempt = 0; attempt <= respawns; attempt++) {
    const ep = await runEpisode(task, deps, { ...opts, maxSteps: shortSteps, temp: attempt === 0 ? (opts.temp ?? 0) : sampleTemp });
    cost += ep.cost; episodes++; steps += ep.steps;
    if (ep.answer && ep.answer.trim()) { answer = ep.answer.trim(); submitted = ep.submitted; break; } // first non-empty wins
  }
  return { answer, steps, cost, submitted, episodes, extra: { respawns_used: episodes - 1, short_steps: shortSteps } };
}

// ── Compound: Plan-and-Solve prefix + Verifier-gated Best-of-N ───────────────────
// Hypothesis (SOTA shortlist): a plan prefix that fixes missing-step errors, AND a
// verifier that closes the generation-verification gap, stack. One plan call, then N
// planned episodes verifier-selected. Returns SC(majority) + BoN(verifier) like verifierBoN.
export async function planBoN(task, deps, { samples = 5, sampleTemp = 0.7, ...opts } = {}) {
  const { llm } = deps;
  let cost = 0, plan = '';
  try {
    const r = await llm([
      { role: 'system', content: 'You are a planner. Given a hard multi-hop question, write a SHORT numbered plan (3-6 steps) that decomposes it into sub-questions / entities to look up on Wikipedia and the order to chain them. Output ONLY the plan, no answer.' },
      { role: 'user', content: `QUESTION:\n${task.question}\n\nPlan:` }], 0.3);
    cost += r.cost || 0; plan = (r.raw || '').trim().slice(0, 1200);
  } catch { /* fall through */ }
  const memo = plan ? `PLAN (decomposition to follow; revise if a step proves wrong):\n${plan}` : '';
  const bon = await verifierBoN(task, deps, { samples, sampleTemp, memo, ...opts });
  return { ...bon, cost: cost + bon.cost, plan, extra: { ...bon.extra, plan_chars: plan.length } };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────────
export async function solveWithScaffold(task, deps, { scaffold = 'none', samples = 3, sampleTemp = 0.7, reflexionRounds = 2, tau = 0.7, respawns = 2, shortSteps = 2, ...opts } = {}) {
  if (scaffold === 'plan') return planAndSolve(task, deps, opts);
  if (scaffold === 'reflexion') return reflexion(task, deps, { rounds: reflexionRounds, tau, ...opts });
  if (scaffold === 'verifier-bon') return verifierBoN(task, deps, { samples, sampleTemp, ...opts });
  if (scaffold === 'ps-bon') return planBoN(task, deps, { samples, sampleTemp, ...opts });
  if (scaffold === 'failfast') return failFast(task, deps, { respawns, shortSteps, sampleTemp, ...opts });
  // none — the plain base episode.
  const ep = await runEpisode(task, deps, opts);
  return { answer: ep.answer, steps: ep.steps, cost: ep.cost, submitted: ep.submitted, episodes: 1, extra: {} };
}

// ── Deterministic offline mock LLM (for $0 wiring tests) ─────────────────────────
// Inspects the message intent and returns a plausible canned response so every
// scaffold branch can be exercised with no network and no spend.
export function mockDeps() {
  let stepCounter = 0;
  const llm = async (messages, _temp) => {
    const sys = messages[0]?.content || '';
    const user = messages[messages.length - 1]?.content || '';
    if (/planner/i.test(sys)) return { raw: '1. Look up entity A.\n2. Look up entity B.\n3. Chain A→B and answer.', cost: 0.0001 };
    if (/self-evaluator/i.test(sys)) return { raw: '{"confidence":0.9,"reflection":"answer looks supported"}', cost: 0.0001 };
    if (/verifier/i.test(sys)) return { raw: '{"best":0,"answer":"Mock Answer"}', cost: 0.0001 };
    if (/final short answer/i.test(sys)) return { raw: 'Mock Answer', cost: 0.0001 };
    // ReAct turn: search → open → submit.
    stepCounter++;
    if (stepCounter % 3 === 1) return { raw: '{"tool":"search","query":"mock entity"}', cost: 0.0002 };
    if (stepCounter % 3 === 2) return { raw: '{"tool":"open","title":"Mock Page","query":"fact"}', cost: 0.0002 };
    return { raw: '{"tool":"submit","answer":"Mock Answer"}', cost: 0.0002 };
  };
  const searchWiki = async () => '1. Mock Page — a mock snippet.';
  const openWiki = async () => '# Mock Page\nMock plaintext body with the fact.';
  return { llm, searchWiki, openWiki };
}
