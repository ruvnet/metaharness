// SPDX-License-Identifier: MIT
//
// ADR-153 — the AGENTIC execution loop (`--sandbox agentic`). A bounded ReAct loop where the model
// drives a restricted, read-mostly tool surface inside the existing safety envelope, instead of the
// single-shot localize→patch→repair of solve-repair.mjs. This targets the *measured* residual failure
// mode (the model can't DISCOVER the context a one-shot localizer can't surface — call sites, the real
// stack from a failing test, a helper's location) rather than the can't-EMIT mode repair already
// climbed.
//
// This module is pure + dependency-injected (no fetch/Docker/git of its own) so it is unit-testable
// offline: `solve-agentic.mjs` wires the real fetchRepo/llm/evalOne; the test wires a scripted model
// + a temp git repo + a stub test-runner. Keeping the loop here, the I/O there.
//
// Tool surface (ADR-153 §"Proposal"): read · grep · ls (read-only navigation) · run_tests (the real
// Docker oracle) · edit (the validated search/replace primitive) · submit (finalize). Bounded by
// maxSteps + the same edit safety gate. Darwin's mutation surfaces become the loop's *policy*
// (planner = step strategy, toolPolicy = ordering/budget, contextBuilder = what to read next).

/**
 * Build the system prompt that defines the tool protocol. One JSON action per turn, nothing else.
 * ADR-192 (polyglot): the tool-call EXAMPLES embed a file extension + grep glob. Those are now
 * templated to the instance's language (`ext`/`glob`) so the model is shown its real extension
 * (e.g. `f.go` / `*.go` for a Go instance). Nothing in the loop logic is language-specific — only
 * the example strings. `ext`/`glob` default to Python, so the exported AGENTIC_SYSTEM constant is
 * byte-identical to before for Python instances and all existing tests.
 */
export function buildAgenticSystem(ext = 'py', glob = '*.py') {
  return 'You are an autonomous bug-fixing agent working inside a real repository. Each turn, output EXACTLY '
    + 'ONE JSON object on a single line — a tool call — and NOTHING else (no prose, no markdown, no XML). '
    + 'Do NOT use <invoke> XML syntax. Do NOT prefix with >>>. Just the raw JSON object. Tools:\n'
    + '{"tool":"ls","dir":"path/"}            list a directory\n'
    + `{"tool":"read","path":"f.${ext}","start":1,"end":80}  read a file (range optional; omit for whole file)\n`
    + `{"tool":"grep","pattern":"reg","glob":"${glob}"}     search the repo (glob optional)\n`
    + `{"tool":"edit","path":"f.${ext}","search":"<exact lines incl. indentation>","replace":"<new lines>"}  apply a search/replace edit\n`
    + `{"tool":"line_edit","path":"f.${ext}","start":12,"end":15,"replace":"<new text for lines 12-15>"}  replace an inclusive LINE RANGE (robust — line numbers come from \`read\`)\n`
    + '{"tool":"run_tests"}                   run the failing tests against your current edits; returns the trace\n'
    + '{"tool":"submit"}                      finalize your patch and stop\n'
    + 'Strategy: explore (read/grep/ls) to locate the fix, make minimal edit(s), run_tests, iterate on '
    + 'the trace, then submit once tests pass. PREFER line_edit (use the line numbers from `read`) — it is far '
    + 'more reliable than search/replace, which must match the file character-for-character. If an `edit` fails '
    + 'to match, switch to line_edit. Never edit test files. Output ONE JSON action per turn.';
}

/** The default (Python) system prompt — kept as a stable export for backward compatibility. */
export const AGENTIC_SYSTEM = buildAgenticSystem();

/** Parse the model's turn into a single action object, tolerating stray prose/fences around the JSON. */
export function parseAction(raw) {
  if (!raw || typeof raw !== 'string') return { tool: 'noop', error: 'empty model output' };
  // Strip transcript-echo prefixes that thinking models sometimes reproduce (e.g. ">>> {..}").
  const stripped = raw.replace(/^>>>\s*/gm, '');
  // Prefer a fenced block, else the first {...} that parses.
  const fence = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(stripped);
  // Depth-aware extraction: collect ALL top-level {...} objects so multi-action outputs don't
  // prevent the first (correct) action from being found (the old greedy regex merged them all).
  let depth = 0, start = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === '{') { if (!depth) start = i; depth++; }
    else if (stripped[i] === '}' && depth) { depth--; if (!depth && start >= 0) candidates.push(stripped.slice(start, i + 1)); }
  }
  for (const c of candidates) {
    const t = c.trim();
    try { const o = JSON.parse(t); if (o && typeof o.tool === 'string') return o; } catch { /* try next */ }
  }
  return { tool: 'noop', error: 'no parseable JSON action' };
}

/**
 * Build the tool dispatcher over a working tree. All handlers return a string OBSERVATION fed back to
 * the model. Injected primitives keep this offline-testable:
 *   work        absolute path to the checked-out repo
 *   readFile    (absPath) => string                     (node:fs readFileSync utf8)
 *   listDir     (absPath) => string[]                    (node:fs readdirSync)
 *   gitDiff     () => string                             (current working-tree diff)
 *   grepRepo    (pattern, glob) => string                (ripgrep/git-grep; returns matches text)
 *   applyEdit   (content, search, replace) => string|null  (the validated primitive from solve-repair)
 *   writeFile   (absPath, content) => void
 *   exists      (absPath) => boolean
 *   isTestPath  (relPath) => boolean                     (guard: never edit tests)
 *   runTests    () => { resolved, logTail }              (the real Docker oracle on the current diff)
 *   MAX_OUT     observation char cap (default 4000)
 */
export function makeTools(io) {
  const { join } = io.path;
  const cap = (s, n = io.MAX_OUT ?? 4000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);
  const rel = (p) => String(p || '').replace(/^\.?\//, '');
  const guardInside = (p) => {
    // prevent path traversal outside the work tree
    const abs = join(io.work, rel(p));
    if (!abs.startsWith(io.work)) throw new Error('path escapes repository');
    return abs;
  };
  return {
    ls(a) {
      try { const abs = guardInside(a.dir ?? '.'); const items = io.listDir(abs); return cap(items.join('\n') || '(empty)'); }
      catch (e) { return `ls error: ${String(e.message || e)}`; }
    },
    read(a) {
      try {
        const abs = guardInside(a.path); if (!io.exists(abs)) return `read error: no such file ${rel(a.path)}`;
        const lines = io.readFile(abs).split('\n');
        const start = Math.max(1, a.start | 0 || 1); const end = a.end ? Math.min(lines.length, a.end | 0) : lines.length;
        const body = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
        return cap(`${rel(a.path)} [${start}-${end}/${lines.length}]\n${body}`);
      } catch (e) { return `read error: ${String(e.message || e)}`; }
    },
    grep(a) {
      try { if (!a.pattern) return 'grep error: pattern required'; return cap(io.grepRepo(a.pattern, a.glob) || '(no matches)'); }
      catch (e) { return `grep error: ${String(e.message || e)}`; }
    },
    edit(a) {
      try {
        const r = rel(a.path);
        if (io.isTestPath(r)) return `edit rejected: ${r} is a test file (never edit tests)`;
        const abs = guardInside(a.path); if (!io.exists(abs)) return `edit error: no such file ${r}`;
        if (typeof a.search !== 'string' || typeof a.replace !== 'string') return 'edit error: search and replace must be strings';
        const cur = io.readFile(abs); const next = io.applyEdit(cur, a.search, a.replace);
        if (next == null || next === cur) return `edit failed: SEARCH text did not match ${r} (copy it character-for-character, indentation included)`;
        io.writeFile(abs, next); return `edited ${r} (${next.length - cur.length >= 0 ? '+' : ''}${next.length - cur.length} chars)`;
      } catch (e) { return `edit error: ${String(e.message || e)}`; }
    },
    line_edit(a) {
      try {
        const r = rel(a.path);
        if (io.isTestPath(r)) return `line_edit rejected: ${r} is a test file (never edit tests)`;
        const abs = guardInside(a.path); if (!io.exists(abs)) return `line_edit error: no such file ${r}`;
        const s = a.start | 0, e = a.end | 0;
        if (!s || !e || e < s) return 'line_edit error: need 1-based inclusive start,end with end>=start (line numbers from `read`)';
        if (typeof a.replace !== 'string') return 'line_edit error: replace must be a string';
        const cur = io.readFile(abs); const lines = cur.split('\n');
        if (s > lines.length) return `line_edit error: start ${s} is past EOF (file has ${lines.length} lines)`;
        const next = [...lines.slice(0, s - 1), ...a.replace.split('\n'), ...lines.slice(Math.min(lines.length, e))].join('\n');
        if (next === cur) return 'line_edit: no change (replacement identical)';
        io.writeFile(abs, next);
        return `line_edit ${r}: replaced lines ${s}-${e} (${next.length - cur.length >= 0 ? '+' : ''}${next.length - cur.length} chars)`;
      } catch (e) { return `line_edit error: ${String(e.message || e)}`; }
    },
    run_tests() {
      try {
        const diff = io.gitDiff();
        if (!diff.trim()) return 'run_tests: no edits applied yet — make an edit first';
        const { resolved, logTail } = io.runTests();
        return resolved ? 'run_tests: ALL TARGET TESTS PASS ✓ — call submit to finalize'
          : cap(`run_tests: tests still failing:\n${logTail || '(no trace captured)'}`);
      } catch (e) { return `run_tests error: ${String(e.message || e)}`; }
    },
  };
}

/**
 * Run the bounded ReAct loop. Returns { patch, steps, submitted, resolvedInLoop, transcript }.
 *   problem    the SWE-bench problem statement
 *   io         dispatcher I/O (see makeTools) + gitDiff
 *   llm        async (prompt, system) => { raw, cost }
 *   maxSteps   step budget (default 20)
 *   onStep     optional (n, action, observation) => void   (logging)
 * The loop tracks the last diff that made tests pass (resolvedInLoop) and always returns the final
 * working-tree diff as `patch` (submit finalizes; budget-exhaustion returns whatever was edited).
 */
/** Cheap stable 32-bit string hash (FNV-1a) — for the anti-thrash state check. */
export function stateHash(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

// Chebyshev step-depth temperature schedule (PR #49 / ADR-188): hot for exploration early (cluster high temp via a
// raised half-cosine, the Chebyshev-node spacing), then collapse to greedy precision at the edit/submit steps.
// x∈[0,1] over loop depth; w=((1+cos πx)/2)^gamma holds high early + sharp late collapse. gamma>1 = longer hot burst.
export function chebTemp(step, maxSteps, tHi = 0.8, tLo = 0.0, gamma = 2) {
  const x = maxSteps > 1 ? (step - 1) / (maxSteps - 1) : 0;
  const w = Math.pow((1 + Math.cos(Math.PI * x)) / 2, gamma);
  return +(tLo + (tHi - tLo) * w).toFixed(3);
}

export async function agenticSolve({ problem, io, llm, maxSteps = 20, onStep, tempSchedule, system = AGENTIC_SYSTEM }) {
  const tools = makeTools(io);
  const transcript = [];
  let submitted = false; let resolvedInLoop = false; let cost = 0; let thrash = 0;
  // ADR-169 E4 (peer-review mitigation) — anti-thrash: a max-30 ReAct loop's
  // primary failure mode is repeating the same read/grep/ls and burning budget.
  // Hash each (action → observation) state; on an exact repeat, append a system
  // warning so the model must change strategy or terminate. Keeps the per-instance
  // cost projection realistic on extended step budgets.
  const seenStates = new Set();
  const header = `--- problem statement ---\n${String(problem || '').slice(0, 6000)}\n--- begin. Output ONE JSON action. ---`;
  for (let step = 1; step <= maxSteps && !submitted; step++) {
    const convo = header + '\n' + transcript.map((t) => `>>> ${t.actionRaw}\n${t.obs}`).join('\n').slice(-12000);
    let raw = '';
    try { const r = await llm(convo, system, tempSchedule ? tempSchedule(step, maxSteps) : undefined); raw = r.raw; cost += r.cost || 0; }
    catch (e) { transcript.push({ actionRaw: '(model error)', obs: String(e.message || e) }); break; }
    const action = parseAction(raw);
    let obs;
    if (action.tool === 'submit') { submitted = true; obs = 'submitted.'; }
    else if (action.tool === 'noop') obs = `error: ${action.error}. Output ONE valid JSON tool action.`;
    else if (tools[action.tool]) { obs = tools[action.tool](action); if (action.tool === 'run_tests' && /ALL TARGET TESTS PASS/.test(obs)) resolvedInLoop = true; }
    else obs = `error: unknown tool "${action.tool}". Valid: ls, read, grep, edit, run_tests, submit.`;
    // Anti-thrash: detect an exact repeat of a read-only navigation state.
    if (['read', 'grep', 'ls'].includes(action.tool)) {
      const h = stateHash(action.tool + '|' + JSON.stringify(action) + '|' + obs);
      if (seenStates.has(h)) { thrash++; obs += '\n⚠️ SYSTEM: You already ran this exact action and got this exact result. Stop repeating — change your strategy (read a different file / edit / run_tests) or submit.'; }
      else seenStates.add(h);
    }
    const actionRaw = JSON.stringify(action.tool === 'noop' ? { raw: raw.slice(0, 200) } : action).slice(0, 400);
    transcript.push({ actionRaw, obs });
    if (onStep) onStep(step, action, obs);
  }
  return { patch: io.gitDiff(), steps: transcript.length, submitted, resolvedInLoop, cost, thrash, transcript };
}
