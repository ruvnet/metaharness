// $0 unit test for the D1 endpoint/auth resolver. No network, no process.env, no fs — pure logic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocalNoAuth, resolveEndpointAuth } from './swebench-endpoint.mjs';

test('localhost base URL ⇒ no-auth (key ignored even if present in env)', () => {
  const r = resolveEndpointAuth({ baseUrl: 'http://localhost:11434/v1', env: { OPENROUTER_API_KEY: 'sk-should-be-ignored' } });
  assert.equal(r.noAuth, true);
  assert.equal(r.key, ''); // a local endpoint never carries a key — honest $0/keyless
});

test('127.0.0.1 with a port ⇒ no-auth', () => {
  assert.equal(isLocalNoAuth('OPENROUTER_API_KEY', 'http://127.0.0.1:8080/v1'), true);
  assert.equal(resolveEndpointAuth({ baseUrl: 'http://127.0.0.1:8080/v1' }).noAuth, true);
});

test('explicit --api-key-env NONE ⇒ no-auth even for a hosted URL', () => {
  const r = resolveEndpointAuth({ apiKeyEnv: 'NONE', baseUrl: 'https://openrouter.ai/api/v1', env: { NONE: 'x' } });
  assert.equal(r.noAuth, true);
  assert.equal(r.key, '');
});

test('hosted default + env key ⇒ auth, key from env (trimmed)', () => {
  const r = resolveEndpointAuth({ baseUrl: 'https://openrouter.ai/api/v1', env: { OPENROUTER_API_KEY: '  sk-or-v1-abc  ' } });
  assert.equal(r.noAuth, false);
  assert.equal(r.key, 'sk-or-v1-abc');
});

test('hosted + no env key ⇒ falls back to orkey', () => {
  const r = resolveEndpointAuth({ baseUrl: 'https://openrouter.ai/api/v1', env: {}, orkey: 'sk-from-orkey' });
  assert.equal(r.noAuth, false);
  assert.equal(r.key, 'sk-from-orkey');
});

test('a hosted https endpoint is NOT treated as local', () => {
  assert.equal(isLocalNoAuth('OPENROUTER_API_KEY', 'https://api.example.com/v1'), false);
  // "localhost" appearing mid-host (not as the actual host) must not false-positive
  assert.equal(isLocalNoAuth('OPENROUTER_API_KEY', 'https://localhost.evil.com/v1'), false);
});
