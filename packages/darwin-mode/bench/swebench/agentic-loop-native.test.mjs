// Unit tests for the ADR-197 native tool-calling path (agenticSolveNative / parseNativeToolCall /
// buildAgenticToolsSchema) in agentic-loop.mjs — mock LLM, $0, no network/Docker/git.
// Mirrors fusion-loop.test.mjs's style (in-memory io + scripted LLM responses).
// Run: node --test agentic-loop-native.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  agenticSolve, agenticSolveNative, parseNativeToolCall, buildAgenticToolsSchema,
  buildAgenticNativeSystem, parseAction, AGENTIC_SYSTEM,
} from './agentic-loop.mjs';

// ── in-memory io implementing the makeTools contract (paths are '/repo/<rel>') ──────────────────
function makeFakeIo(files, opts = {}) {
  const store = { ...files };
  const changed = new Set();
  let testsPass = opts.testsPass ?? false;
  const norm = (p) => String(p).replace(/^\/repo\/?/, '').replace(/^\.?\//, '');
  return {
    work: '/repo', path: { join }, MAX_OUT: 4000,
    readFile: (p) => { const k = norm(p); if (!(k in store)) throw new Error(`ENOENT ${k}`); return store[k]; },
    listDir: () => [...new Set(Object.keys(store).map((k) => k.split('/')[0]))],
    writeFile: (p, c) => { const k = norm(p); store[k] = c; changed.add(k); },
    exists: (p) => norm(p) in store,
    gitDiff: () => [...changed].map((k) => `+++ b/${k}\n${store[k]}`).join('\n'),
    grepRepo: (pat) => Object.entries(store).filter(([, v]) => v.includes(pat)).map(([k]) => `${k}:1:${pat}`).join('\n'),
    applyEdit: (content, s, r) => (content.includes(s) ? content.replace(s, r) : null),
    isTestPath: (r) => /(^|\/)test/.test(r),
    runTests: () => (testsPass ? { resolved: true, logTail: '' } : { resolved: false, logTail: 'FAIL: boom' }),
    _setTestsPass: (v) => { testsPass = v; },
  };
}

// A scripted native LLM: pops queued { message, cost } responses; throws if it runs dry (test bug).
// `message` follows the OpenAI/OpenRouter shape: { content, tool_calls?: [{ id, function: { name, arguments } }] }.
function scriptedNative(responses, label = 'llm') {
  const q = [...responses];
  return async () => {
    if (!q.length) throw new Error(`${label} script exhausted`);
    const r = q.shift();
    return { message: r.message, cost: r.cost ?? 0 };
  };
}
// Helper: build one tool_call message for a given tool name + args.
const toolCallMsg = (name, args = {}, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({
  content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('parseNativeToolCall: maps a valid tool_call into the {tool,...args} action shape', () => {
  const a = parseNativeToolCall({ id: 'c1', function: { name: 'read', arguments: JSON.stringify({ path: 'f.py', start: 1, end: 10 }) } });
  assert.deepEqual(a, { tool: 'read', path: 'f.py', start: 1, end: 10 });
});

test('parseNativeToolCall: no-arg tools (submit/run_tests) with empty/omitted arguments', () => {
  assert.deepEqual(parseNativeToolCall({ id: 'c1', function: { name: 'submit', arguments: '' } }), { tool: 'submit' });
  assert.deepEqual(parseNativeToolCall({ id: 'c1', function: { name: 'run_tests' } }), { tool: 'run_tests' });
  assert.deepEqual(parseNativeToolCall({ id: 'c1', function: { name: 'submit', arguments: '{}' } }), { tool: 'submit' });
});

test('parseNativeToolCall: missing tool_call → noop (no crash on absent function)', () => {
  assert.equal(parseNativeToolCall(undefined).tool, 'noop');
  assert.equal(parseNativeToolCall({}).tool, 'noop');
  assert.equal(parseNativeToolCall({ function: {} }).tool, 'noop');
});

test('parseNativeToolCall: unparseable JSON arguments → noop with a descriptive error (not a throw)', () => {
  const a = parseNativeToolCall({ id: 'c1', function: { name: 'edit', arguments: '{not json' } });
  assert.equal(a.tool, 'noop');
  assert.match(a.error, /unparseable/i);
  assert.match(a.error, /edit/);
});

test('parseNativeToolCall: non-object arguments (e.g. a JSON array) degrade to {} rather than crashing the dispatcher', () => {
  const a = parseNativeToolCall({ id: 'c1', function: { name: 'ls', arguments: '[1,2,3]' } });
  assert.deepEqual(a, { tool: 'ls' });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('buildAgenticToolsSchema: exposes the full 7-tool surface as OpenAI/OpenRouter function schemas', () => {
  const schema = buildAgenticToolsSchema();
  const names = schema.map((t) => t.function.name);
  assert.deepEqual(names, ['ls', 'read', 'grep', 'edit', 'line_edit', 'run_tests', 'submit']);
  for (const t of schema) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.name, 'string');
    assert.equal(typeof t.function.description, 'string');
    assert.equal(t.function.parameters.type, 'object');
  }
  const edit = schema.find((t) => t.function.name === 'edit');
  assert.deepEqual(edit.function.parameters.required, ['path', 'search', 'replace']);
  const lineEdit = schema.find((t) => t.function.name === 'line_edit');
  assert.deepEqual(lineEdit.function.parameters.required, ['path', 'start', 'end', 'replace']);
});

test('buildAgenticToolsSchema: ext/glob flavor the description text only (ADR-192 polyglot parity), not tool semantics', () => {
  const py = buildAgenticToolsSchema('py', '*.py');
  const go = buildAgenticToolsSchema('go', '*.go');
  assert.notEqual(JSON.stringify(py), JSON.stringify(go));
  assert.equal(py.length, go.length);
  assert.match(go.find((t) => t.function.name === 'read').function.parameters.properties.path.description, /f\.go/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
test('agenticSolveNative: submit tool_call ends the loop with submitted=true', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([{ message: toolCallMsg('submit') }]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.submitted, true);
  assert.equal(res.steps, 1);
});

test('agenticSolveNative: line_edit tool_call actually mutates the file (patch reflects the edit)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\ny = 2\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('line_edit', { path: 'a.py', start: 1, end: 1, replace: 'x = 42' }) },
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.submitted, true);
  assert.match(res.patch, /x = 42/);
});

test('agenticSolveNative: edit tool_call whose search text mismatches reports a failure observation (no crash, no write)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('edit', { path: 'a.py', search: 'nope not present', replace: 'x = 2' }) },
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.patch, '');
  assert.match(res.transcript[0].obs, /edit failed/);
});

test('agenticSolveNative: run_tests reporting ALL TARGET TESTS PASS sets resolvedInLoop', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' }, { testsPass: true });
  const llm = scriptedNative([
    { message: toolCallMsg('line_edit', { path: 'a.py', start: 1, end: 1, replace: 'x = 42' }) },
    { message: toolCallMsg('run_tests') },
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.resolvedInLoop, true);
  assert.equal(res.submitted, true);
});

test('agenticSolveNative: a turn with NO tool_calls (plain-content reply) degrades to a recoverable noop, loop continues', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: { content: 'Let me think about this before I act.' } }, // no tool_calls at all
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.steps, 2);
  assert.equal(res.submitted, true);
  assert.match(res.transcript[0].obs, /no tool_call/);
});

test('agenticSolveNative: malformed tool_call arguments recover the same way parseAction would (informative error, no throw)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'edit', arguments: '{not json' } }] } },
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.submitted, true);
  assert.match(res.transcript[0].obs, /unparseable/i);
});

test('agenticSolveNative: unknown tool name reports a clear error listing the valid surface', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('delete_repo', {}) },
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.match(res.transcript[0].obs, /unknown tool "delete_repo"/);
  assert.match(res.transcript[0].obs, /line_edit/); // valid-tools list mentions the full surface
});

test('agenticSolveNative: only the FIRST tool_call of a multi-call turn is dispatched (one action per turn, like parseAction)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const msg = {
    content: null,
    tool_calls: [
      { id: 'c1', function: { name: 'ls', arguments: '{}' } },
      { id: 'c2', function: { name: 'submit', arguments: '{}' } },
    ],
  };
  const llm = scriptedNative([{ message: msg }]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 1 });
  // submit was the SECOND call in the turn and must be ignored — only `ls` (the first) was dispatched.
  assert.equal(res.submitted, false);
  assert.equal(res.steps, 1);
  assert.match(res.transcript[0].actionRaw, /"ls"/);
});

test('agenticSolveNative: anti-thrash warns on an exact repeat of a read-only navigation state (parity with agenticSolve)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('read', { path: 'a.py' }) },
    { message: toolCallMsg('read', { path: 'a.py' }) }, // exact repeat
    { message: toolCallMsg('submit') },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.thrash, 1);
  assert.match(res.transcript[1].obs, /already ran this exact action/);
});

test('agenticSolveNative: budget exhaustion without submit returns submitted=false and whatever diff was made', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('ls', {}) },
    { message: toolCallMsg('grep', { pattern: 'x' }) },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 2 });
  assert.equal(res.submitted, false);
  assert.equal(res.steps, 2);
  assert.equal(res.patch, '');
});

test('agenticSolveNative: llm() throwing (network error) ends the loop gracefully instead of propagating', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = async () => { throw new Error('http 500'); };
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.submitted, false);
  assert.equal(res.steps, 1);
  assert.match(res.transcript[0].obs, /http 500/);
});

test('agenticSolveNative: cost accumulates across turns from each llm() response', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('ls', {}), cost: 0.01 },
    { message: toolCallMsg('submit'), cost: 0.02 },
  ]);
  const res = await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.ok(Math.abs(res.cost - 0.03) < 1e-9);
});

test('agenticSolveNative: onStep callback fires once per turn with (n, action, observation)', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = scriptedNative([
    { message: toolCallMsg('ls', {}) },
    { message: toolCallMsg('submit') },
  ]);
  const seen = [];
  await agenticSolveNative({ problem: 'fix it', io, llm, maxSteps: 5, onStep: (n, action, obs) => seen.push([n, action.tool, typeof obs]) });
  assert.deepEqual(seen, [[1, 'ls', 'string'], [2, 'submit', 'string']]);
});

test('buildAgenticNativeSystem: instructs exactly-one-tool-per-turn without JSON-emission instructions (distinct prompt from the text protocol)', () => {
  const native = buildAgenticNativeSystem();
  assert.match(native, /exactly ONE tool per turn/i);
  assert.doesNotMatch(native, /JSON object/i);
  assert.notEqual(native, AGENTIC_SYSTEM);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Parity check: the default text-JSON path (agenticSolve/parseAction) is untouched by these additions.
test('regression guard: the pre-existing text-JSON agenticSolve path is unaffected by the native additions', async () => {
  const io = makeFakeIo({ 'a.py': 'x = 1\n' });
  const llm = async () => ({ raw: JSON.stringify({ tool: 'submit' }), cost: 0 });
  const res = await agenticSolve({ problem: 'fix it', io, llm, maxSteps: 5 });
  assert.equal(res.submitted, true);
  assert.equal(res.steps, 1);
  assert.equal(parseAction('not json at all').tool, 'noop');
});
