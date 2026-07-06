// $0 node:test — the grader's harness-venv guard. The swebench venv is the ONLY gold-scorer; a missing
// venv (e.g. the ephemeral /tmp one wiped on reboot) must fail LOUDLY with setup instructions, never be
// mistaken for "0 resolved". Verifies the pre-flight throw (no Docker / no harness invoked).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeSwebenchGrader } from './swebench-grade.mjs';

test('makeSwebenchGrader throws an actionable error when the harness venv is missing', () => {
  assert.throws(
    () => makeSwebenchGrader({ venvPython: '/definitely/not/a/venv/bin/python' }),
    (e) => /swebench harness venv not found/.test(e.message) && /pip install swebench/.test(e.message),
  );
});

test('makeSwebenchGrader constructs when the venv python exists (uses this interpreter as a stand-in)', () => {
  const g = makeSwebenchGrader({ venvPython: process.execPath }); // node exists → passes the existence guard
  assert.strictEqual(typeof g, 'function');
});
