// SPDX-License-Identifier: MIT
//
// MetaHarness greenfield solver — the Retort adapter for the darwin-mode agentic
// harness. Where solve-agentic.mjs runs a bounded ReAct loop to REPAIR an existing
// SWE-bench repo, this runs the *same* loop primitives (agentic-loop.mjs:
// parseAction / makeTools / stateHash / the anti-thrash convo protocol) on a
// GREENFIELD task: an empty workspace + a TASK.md spec → the model writes the code,
// builds it, runs its own tests, and finishes. Retort then builds/tests/scores the
// workspace with its OWN scorers (we touch nothing in Retort's scoring path).
//
// What makes it "MetaHarness" and not a one-shot completion:
//   • bounded ReAct loop with read/grep/ls/edit/write/run tools (genuine reuse of
//     the darwin-mode loop primitives — imported, not reimplemented);
//   • model ROUTING — a cheap default model (deepseek-v4-pro) that ESCALATES to a
//     stronger model on an INTRINSIC task-difficulty signal (the orchestration lever):
//     legacy = repeated build/test failures; iteration-3 (--route-difficulty) adds
//     early token-burn / rewrite-churn signals gated by "no green run yet" so only a
//     genuinely-stuck hard cell routes up while easy cells stay on the cheap model;
//   • optional agenticow COW memory (--memory) — a copy-on-write vector store of
//     every step's observation; before each turn the most-relevant SCROLLED-OUT
//     observations are recalled and re-injected, fighting the transcript-window
//     truncation that makes a cheap model lose earlier context on long tasks.
//
// Phase-2.1 efficiency (the timeout/latency lever, ADR-201): the loop now accepts
// MULTI-ACTION turns — the model may emit a JSON ARRAY (or several JSON objects)
// in one response and they are executed in order, returning all observations.
// This collapses the slow per-call round-trips (write app + 3 tests + README +
// run in ONE deepseek call instead of six), which both CUTS wall-clock latency
// and lets the cheap-tier cells finish inside the cap instead of timing out.
//
// The OpenRouter key is read from env (OPENROUTER_API_KEY) or /tmp/.orkey and is
// passed only to the LLM HTTP call — never written into the workspace or the prompt.
//
// Usage (invoked by the Retort metaharness runner, cwd = the playpen workspace):
//   node --experimental-strip-types greenfield-solve.mjs \
//     --lang python --model deepseek/deepseek-v4-pro \
//     --escalate deepseek/deepseek-r1 --max-steps 40 --out result.json
//
// Emits ONE JSON line on stdout (the runner parses it for tokens/cost):
//   {"tokens":N,"cost":USD,"steps":S,"calls":C,"model":"...","escalated":bool,"done":bool}

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── genuine reuse of the darwin-mode agentic core ──
const HERE = dirname(fileURLToPath(import.meta.url));
const { parseAction, makeTools, stateHash } = await import(join(HERE, '..', 'swebench', 'agentic-loop.mjs'));

const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);

const WORK = process.cwd();
const LANG = argv('--lang', 'python');
const MODEL = argv('--model', 'deepseek/deepseek-v4-pro');   // cheap tier-1 default
const ESCALATE = argv('--escalate', '');                      // frontier tier-2 (empty = single-tier)
const ESCALATE_AFTER = +argv('--escalate-after', 2);          // consecutive run-failures before escalating
const MAX_STEPS = +argv('--max-steps', 40);
const TASK_FILE = argv('--task', 'TASK.md');
const OUT = (() => { const o = argv('--out', 'metaharness-result.json'); return isAbsolute(o) ? o : join(WORK, o); })();
const BASE_URL = argv('--base-url', 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const KEY_ENV = argv('--api-key-env', 'OPENROUTER_API_KEY');
const USE_MEMORY = has('--memory');
const RUN_TIMEOUT_MS = +argv('--run-timeout', 120) * 1000;
const MAX_TOKENS = +argv('--max-tokens', 12000);   // headroom for batched multi-file writes in one turn
const MAX_ACTIONS_PER_TURN = +argv('--max-actions', 6);  // cap a multi-action turn so a runaway can't explode

// ── iteration-3: task-difficulty-aware routing (the orchestration lever) ──────
// Opt-in (--route-difficulty). When OFF, behaviour is byte-identical to i2: the
// only escalation path is the legacy runFailures>=ESCALATE_AFTER trigger (which is
// itself inert when --escalate is empty). When ON, we escalate a *hard* cell to the
// stronger --escalate model EARLY, using only INTRINSIC signals the harness itself
// observes — never the gold REQUIREMENTS.json or any reference solution:
//   • a-priori: language∈{ts,go,rust} (compiled/strict-typed greenfield is harder)
//     + the spec's requirement count → a lower per-cell token threshold;
//   • dynamic: cumulative TOKENS burned, cumulative BYTES written (large multi-file
//     rewrite churn), and consecutive build/test FAILURES — each gated by
//     `everRanOk` (has any build/test gone green yet) for PRECISION: a cell that
//     already gets something running cheap is NOT escalated just for being slow;
//     only a cell that is burning tokens / churning rewrites WITHOUT ever getting a
//     green run (the i2 ts+cli timeout signature: deepseek looping on 100–160k-token
//     rewrites it can't converge) is routed up.
const ROUTE_DIFFICULTY = has('--route-difficulty');
const TOKEN_ESCALATE_AT = +argv('--token-escalate', 55000);  // burn-without-green → escalate
const BYTES_ESCALATE_AT = +argv('--bytes-escalate', 50000);  // rewrite churn → escalate

const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
if (!key) { console.error('metaharness: no API key (set OPENROUTER_API_KEY or /tmp/.orkey)'); process.exit(2); }

const taskPath = isAbsolute(TASK_FILE) ? TASK_FILE : join(WORK, TASK_FILE);
const problem = existsSync(taskPath) ? readFileSync(taskPath, 'utf8') : '';
if (!problem.trim()) { console.error(`metaharness: empty/missing task spec at ${taskPath}`); process.exit(2); }

// ── a-priori difficulty estimate (INTRINSIC: from the spec text + language only;
//    never the gold REQUIREMENTS.json). Hard language + a requirement-dense spec
//    lowers the token threshold at which we route up, so a struggling hard cell
//    escalates sooner while an easy cell keeps the high threshold and rarely does. ──
const HARD_LANG = ['typescript', 'go', 'rust'].includes(LANG.toLowerCase());
const specReqs = (problem.match(/^\s*(?:[-*]|\d+[.)])\s+|.*\b(?:must|should|require|implement|support|endpoint|command)\b/gim) || []).length;
const aprioriHard = HARD_LANG && specReqs >= 6;   // strict-typed + many requirements
const tokenEscalateAt = Math.round(TOKEN_ESCALATE_AT * (aprioriHard ? 0.7 : 1.0));
const bytesEscalateAt = Math.round(BYTES_ESCALATE_AT * (aprioriHard ? 0.7 : 1.0));
if (ROUTE_DIFFICULTY) {
  console.error(`[router] difficulty prior: lang=${LANG} hardLang=${HARD_LANG} specReqs=${specReqs} aprioriHard=${aprioriHard} → tokenEscalateAt=${tokenEscalateAt} bytesEscalateAt=${bytesEscalateAt} escalateTo=${ESCALATE || '(none)'}`);
}

// ── multi-action parsing (the latency lever): one turn may carry several tool
//    calls — a JSON array OR several top-level {...} objects — executed in order.
//    Backward compatible: a single {...} still yields a one-element list. Falls
//    back to parseAction()'s error object so noop/error messaging is preserved. ──
function parseActions(raw) {
  if (!raw || typeof raw !== 'string') return [parseAction(raw)];
  const stripped = raw.replace(/^>>>\s*/gm, '');
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fence ? fence[1] : stripped).trim();
  const out = [];
  // 1) explicit JSON array of actions.
  if (body.startsWith('[')) {
    try {
      const arr = JSON.parse(body);
      if (Array.isArray(arr)) for (const o of arr) if (o && typeof o.tool === 'string') out.push(o);
      if (out.length) return out.slice(0, MAX_ACTIONS_PER_TURN);
    } catch { /* fall through to object scan */ }
  }
  // 2) one-or-more top-level {...} objects (depth-aware), in document order.
  let depth = 0, start = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') { if (!depth) start = i; depth++; }
    else if (stripped[i] === '}' && depth) {
      depth--;
      if (!depth && start >= 0) {
        try { const o = JSON.parse(stripped.slice(start, i + 1)); if (o && typeof o.tool === 'string') out.push(o); }
        catch { /* skip unparseable fragment */ }
      }
    }
  }
  return out.length ? out.slice(0, MAX_ACTIONS_PER_TURN) : [parseAction(raw)];
}

// ── the validated search/replace primitive (shared shape with solve-repair.mjs) ──
function applyEdit(content, search, replace) {
  if (search.length && content.includes(search)) return content.replace(search, replace);
  const cl = content.split('\n'); const sl = search.split('\n');
  while (sl.length && sl[sl.length - 1].trim() === '') sl.pop();
  while (sl.length && sl[0].trim() === '') sl.shift();
  if (!sl.length) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + sl.length <= cl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) { if (norm(cl[i + j]) !== norm(sl[j])) { ok = false; break; } }
    if (!ok) continue;
    const indOf = (s) => (s.match(/^[ \t]*/) || [''])[0];
    const delta = indOf(cl[i]).length - indOf(sl[0]).length;
    const rl = replace.split('\n').map((line) => { if (!line.trim()) return line; if (delta >= 0) return ' '.repeat(delta) + line; const lead = indOf(line).length; return line.slice(Math.min(-delta, lead)); });
    return [...cl.slice(0, i), ...rl, ...cl.slice(i + sl.length)].join('\n');
  }
  return null;
}

// ── tool I/O injected into the reused makeTools(); greenfield: tests are editable ──
function listDirRec(abs) {
  // shallow list with a dir marker — enough for the model to navigate.
  return readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
}
function grepRepo(pattern, glob) {
  try {
    const a = ['-rIn', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.venv'];
    if (glob) a.push(`--include=${glob}`);
    a.push(pattern, '.');
    return execFileSync('grep', a, { cwd: WORK, encoding: 'utf8', maxBuffer: 1 << 24 });
  } catch { return ''; }
}
const io = {
  work: WORK, path: { join }, MAX_OUT: 4000,
  readFile: (p) => readFileSync(p, 'utf8'),
  listDir: listDirRec,
  writeFile: (p, c) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
  exists: existsSync,
  grepRepo,
  applyEdit,
  isTestPath: () => false,        // greenfield: the agent writes the tests too
  gitDiff: () => '',              // unused (scoring is Retort's job)
  runTests: () => ({ resolved: false, logTail: 'use the {"tool":"run"} tool to run builds/tests' }),
};
const baseTools = makeTools(io);

// ── greenfield-only tools layered on top of the reused read/grep/ls/edit set ──
// Difficulty-router state — all INTRINSIC (observed by the harness, never gold):
//   runFailures  consecutive build/test failures (build-fail-without-progress)
//   bytesWritten cumulative bytes the agent wrote (large multi-file rewrite churn)
//   everRanOk    has ANY build/test gone green yet (the precision gate)
let runFailures = 0, bytesWritten = 0, everRanOk = false;
const tools = {
  ls: baseTools.ls, read: baseTools.read, grep: baseTools.grep,
  edit: baseTools.edit, line_edit: baseTools.line_edit,
  write(a) {
    try {
      const rel = String(a.path || '').replace(/^\.?\//, '');
      const abs = join(WORK, rel);
      if (!abs.startsWith(WORK)) return 'write error: path escapes workspace';
      if (typeof a.content !== 'string') return 'write error: content must be a string';
      io.writeFile(abs, a.content);
      bytesWritten += a.content.length;
      return `wrote ${rel} (${a.content.length} bytes)`;
    } catch (e) { return `write error: ${String(e.message || e)}`; }
  },
  run(a) {
    if (!a.cmd || typeof a.cmd !== 'string') return 'run error: cmd (string) required';
    try {
      const out = execSync(a.cmd, { cwd: WORK, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });
      runFailures = 0; everRanOk = true;
      const t = (out || '').slice(-3500);
      return `run ok (exit 0):\n${t || '(no output)'}`;
    } catch (e) {
      runFailures++;
      const tail = ((e.stdout || '') + '\n' + (e.stderr || '')).slice(-3500);
      return `run FAILED (exit ${e.status ?? '?'}):\n${tail || String(e.message || e)}`;
    }
  },
};

// ── the difficulty-routing decision: escalate the cheap model to the stronger
//    --escalate model when an INTRINSIC signal says this cell is hard. Returns a
//    short reason string when it fires, else ''. Legacy runFailures trigger is kept
//    (active whenever --escalate is set); the token/bytes triggers are gated behind
//    --route-difficulty AND `!everRanOk` (only route up a cell that has NOT yet got
//    anything to build/test green — the i2 ts/cli looping signature). ──
function difficultyReason(tokensSoFar) {
  if (runFailures >= ESCALATE_AFTER) return `${runFailures} consecutive build/test failures`;
  if (!ROUTE_DIFFICULTY) return '';
  if (!everRanOk && tokensSoFar >= tokenEscalateAt) return `${tokensSoFar} tokens burned with no green build/test (threshold ${tokenEscalateAt})`;
  if (!everRanOk && bytesWritten >= bytesEscalateAt) return `${bytesWritten} bytes of rewrite churn with no green build/test (threshold ${bytesEscalateAt})`;
  return '';
}

const SYSTEM =
  'You are an autonomous software engineer working in an EMPTY project workspace. '
  + 'Your job: read the spec in TASK.md and implement everything it asks for, in '
  + `the ${LANG} language, writing real files into the current directory. Each turn, output `
  + 'EXACTLY ONE JSON object on a single line — a tool call — and NOTHING else (no prose, '
  + 'no markdown). Tools:\n'
  + '{"tool":"ls","dir":"."}                         list a directory\n'
  + '{"tool":"read","path":"f","start":1,"end":80}    read a file (range optional)\n'
  + '{"tool":"write","path":"app/main.py","content":"<full file text>"}  create/overwrite a file\n'
  + '{"tool":"edit","path":"f","search":"<exact lines>","replace":"<new lines>"}  search/replace edit\n'
  + '{"tool":"line_edit","path":"f","start":12,"end":15,"replace":"<new text>"}  replace a line range\n'
  + '{"tool":"grep","pattern":"reg","glob":"*.py"}    search the workspace\n'
  + '{"tool":"run","cmd":"python -m pytest -q"}        run a shell command (build / install deps / tests)\n'
  + '{"tool":"done"}                                  finish (only after tests pass)\n'
  + 'EFFICIENCY: you MAY batch several independent actions in ONE turn by emitting a JSON ARRAY '
  + 'of action objects, e.g. [{"tool":"write",...},{"tool":"write",...},{"tool":"run",...}]. They '
  + 'run in order and you get all observations back. Batch all your file writes (app + README + '
  + 'the >=3 tests) into ONE array, then `run` — this is far faster than one file per turn. Do NOT '
  + 'batch a `run` you need the output of before deciding the next edit; inspect, then fix.\n'
  + 'Strategy: implement the code with `write` (batched), add a README.md and AT LEAST 3 tests, install '
  + 'any deps and RUN the build + tests with `run`, fix failures from the output, and only then '
  + 'call done. Prefer the standard/embedded options the spec names (e.g. SQLite). Keep the '
  + 'project runnable from the current directory. Output ONE JSON action OR a JSON array per turn.';

// ── OpenRouter chat call with usage/cost; returns {raw, cost, tokens} ──
async function llmCall(model, convo) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: convo }];
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'retort-metaharness' },
        body: JSON.stringify({ model, messages, max_tokens: MAX_TOKENS, temperature: 0, usage: { include: true } }),
      });
      if (!res.ok && (res.status === 429 || res.status >= 500)) { lastErr = new Error(`http ${res.status}`); continue; }
      const j = await res.json();
      if (j.error) { lastErr = new Error(j.error.message || 'api error'); continue; }
      const u = j.usage || {};
      const tokens = (u.total_tokens ?? ((u.prompt_tokens || 0) + (u.completion_tokens || 0))) || 0;
      return { raw: j.choices?.[0]?.message?.content ?? '', cost: u.cost ?? 0, tokens };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('llm failed');
}

// ── optional agenticow COW memory (best-effort; absent/broken => no-op) ──
// A genuine integration of agenticow's copy-on-write vector store: every step's
// observation is embedded (cheap deterministic char-trigram hash → fixed dim) and
// ingested; before each turn we QUERY for the observations most relevant to the
// current state and re-inject the ones that have SCROLLED OUT of the truncated
// transcript window. This directly tests whether recalling lost context helps the
// cheap model finish. Fully guarded — any failure degrades to no-op, never fatal.
const MEM_DIM = 64;
function embedText(s) {
  const v = new Float32Array(MEM_DIM);
  const str = (' ' + String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' ');
  for (let i = 0; i < str.length - 2; i++) {
    let h = 0x811c9dc5;
    for (let j = 0; j < 3; j++) { h ^= str.charCodeAt(i + j); h = Math.imul(h, 0x01000193); }
    v[(h >>> 0) % MEM_DIM] += 1;
  }
  let n = 0; for (let i = 0; i < MEM_DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < MEM_DIM; i++) v[i] /= n;
  return v;
}
let mem = null;             // agenticow store
const memText = new Map();  // id -> full observation text (the store holds vectors only)
let memCalls = 0;
if (USE_MEMORY) {
  try {
    const m = await import('agenticow');
    const open = m.open || (m.default && m.default.open);
    if (typeof open === 'function') {
      // Store OUTSIDE the scored workspace so the .rvf artifact never confounds
      // Retort's code-quality / spec-gate scoring of the produced source tree.
      const os = await import('node:os');
      const memPath = join(os.tmpdir(), `mh-mem-${process.pid}-${Date.now()}.rvf`);
      mem = open(memPath, { dimension: MEM_DIM, metric: 'l2', track: false });
    } else { console.error('metaharness: agenticow has no open(); continuing without COW memory'); }
  } catch (e) { console.error(`metaharness: agenticow unavailable (${String(e.message || e).split('\n')[0]}); continuing without COW memory`); }
}
function memStore(step, text) {
  if (!mem) return;
  try { const id = step; memText.set(id, text); mem.ingest(embedText(text), [id]); }
  catch { /* non-fatal */ }
}
function memRecall(queryText, excludeIds, k = 3) {
  if (!mem) return '';
  try {
    memCalls++;
    const res = mem.query(embedText(queryText), Math.min(k + excludeIds.size, 8));
    const ids = (res && (res.ids || res)) || [];
    const picks = [];
    for (const id of ids) {
      const n = typeof id === 'number' ? id : (id && id.id);
      if (n == null || excludeIds.has(n) || !memText.has(n)) continue;
      picks.push(`[recalled step ${n}] ${memText.get(n).slice(0, 600)}`);
      if (picks.length >= k) break;
    }
    return picks.length ? `--- RELEVANT EARLIER CONTEXT (recalled from memory) ---\n${picks.join('\n')}\n--- end recalled context ---\n` : '';
  } catch { return ''; }
}

// ── the bounded ReAct loop (greenfield variant of agenticSolve) ──
const transcript = [];
const seen = new Set();
let cost = 0, tokens = 0, calls = 0, done = false, escalated = false;
let model = MODEL;
const header = `--- TASK.md ---\n${problem.slice(0, 7000)}\n--- begin. Output ONE JSON action. ---`;

const recalledIds = new Set();
let escalationReason = '';
for (let step = 1; step <= MAX_STEPS && !done; step++) {
  // task-difficulty-aware routing: escalate the cheap model to the stronger
  // --escalate model when an intrinsic difficulty signal fires (see difficultyReason).
  if (ESCALATE && !escalated) {
    const reason = difficultyReason(tokens);
    if (reason) {
      model = ESCALATE; escalated = true; escalationReason = reason;
      transcript.push({ actionRaw: '(router)', obs: `⚙️ SYSTEM: difficulty router escalated to ${ESCALATE} — ${reason}.` });
      console.error(`[router] ESCALATE → ${ESCALATE} at step ${step}: ${reason}`);
    }
  }
  let convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-14000);
  // memory: recall scrolled-out observations relevant to the most recent state.
  if (mem) {
    const recent = transcript.slice(-3).map((t) => t.obs).join('\n') || problem;
    const inWindow = new Set(transcript.slice(-12).map((_, i) => transcript.length - 12 + i + 1).filter((n) => n > 0));
    const block = memRecall(recent, inWindow);
    if (block) convo = header + '\n' + block + convo.slice(header.length + 1);
  }
  let r;
  try { r = await llmCall(model, convo); }
  catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
  calls++; cost += r.cost || 0; tokens += r.tokens || 0;

  // multi-action: execute every tool call the model emitted this turn, in order.
  const actions = parseActions(r.raw);
  let firstTool = actions[0] ? actions[0].tool : 'noop';
  for (let ai = 0; ai < actions.length && !done; ai++) {
    const action = actions[ai];
    let obs;
    if (action.tool === 'done' || action.tool === 'submit') { done = true; obs = 'done.'; }
    else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action (or a JSON array of actions).`;
    else if (tools[action.tool]) obs = tools[action.tool](action);
    else obs = `error: unknown tool "${action.tool}". Valid: ls, read, write, edit, line_edit, grep, run, done.`;
    if (['read', 'grep', 'ls'].includes(action.tool)) {
      const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
      if (seen.has(h)) obs += '\n⚠️ SYSTEM: you already ran this exact action with this result — change strategy (write/run/edit) or call done.';
      else seen.add(h);
    }
    const actionRaw = JSON.stringify(action.tool === 'noop' ? { raw: (r.raw || '').slice(0, 160) } : action).slice(0, 400);
    transcript.push({ actionRaw, obs });
    memStore(transcript.length, `${action.tool}: ${obs}`);
    console.error(`[step ${step}/${MAX_STEPS}${actions.length > 1 ? `.${ai + 1}/${actions.length}` : ''}] ${action.tool}${escalated ? ' (esc)' : ''} — ${obs.split('\n')[0].slice(0, 100)}`);
  }
  void firstTool; void recalledIds;
}
if (mem) { try { mem.close && mem.close(); } catch { /**/ } }

const summary = { tokens, cost: +cost.toFixed(6), steps: transcript.length, calls, model, escalated, escalation_reason: escalationReason, route_difficulty: ROUTE_DIFFICULTY, apriori_hard: aprioriHard, bytes_written: bytesWritten, ever_ran_ok: everRanOk, done, memory_used: !!mem, memory_recalls: memCalls };
try { writeFileSync(OUT, JSON.stringify({ ...summary, lang: LANG }, null, 2)); } catch { /**/ }
console.log(JSON.stringify(summary));
