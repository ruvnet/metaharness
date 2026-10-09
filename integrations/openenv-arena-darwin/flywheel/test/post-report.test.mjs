// post-report.sh: off by default, posts only report.mjs's text, never touches real Slack here. The "Slack MCP
// server" is a local fake that speaks the same stdio JSON-RPC and records what it was asked to send.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const FLY = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'arena-fw-post-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const state = join(tmp, 'state');
const day = spawnSync('date', ['+%F'], { env: { TZ: 'America/Toronto' }, encoding: 'utf8' }).stdout.trim();
mkdirSync(join(state, 'reports', day), { recursive: true });
const statusFile = join(state, 'reports', day, 'status.json');
const goodStatus = { date: day, outcome: 'skipped', mode: 'dry-run', decision: { submit: false, reasons: ['modeAuto'] }, submission: null };
const fakeDir = join(tmp, 'fake');
mkdirSync(fakeDir);
const fake = join(fakeDir, 'fake-slack-mcp');
const calls = join(fakeDir, 'calls.jsonl');
const behaviour = join(fakeDir, 'behaviour.txt');
writeFileSync(fake, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const dir = path.dirname(process.argv[1]);
const mode = fs.existsSync(path.join(dir, 'behaviour.txt')) ? fs.readFileSync(path.join(dir, 'behaviour.txt'), 'utf8').trim() : 'ok';
if (mode === 'exit') { process.stderr.write('mcp server error: no Slack token\\n'); process.exit(1); }
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } }) + '\\n');
    if (m.method === 'tools/call') {
      fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ argv: process.argv.slice(2), params: m.params, envKeys: Object.keys(process.env).sort(), tokenFile: process.env.SLACK_MCP_TOKEN_FILE }) + '\\n');
      const isError = mode === 'error';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { isError, content: [{ type: 'text', text: isError ? 'channel_not_found' : 'ok' }] } }) + '\\n');
    }
  }
});
`, { mode: 0o755 });
const tokenFile = join(tmp, 'slack-token-placeholder');
writeFileSync(tokenFile, 'never-read-by-post-report');
const conf = join(tmp, 'config.json');
const config = notify => writeFileSync(conf, JSON.stringify({ mode: 'dry-run', notify }));
const enabled = { postEnabled: true, slackChannel: 'C0TESTCHAN1', slackMcpCommand: fake, slackTokenFile: tokenFile };

const post = (args = [], over = {}) => spawnSync(join(FLY, 'post-report.sh'), args, { encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: tmp, ARENA_FLYWHEEL_STATE_DIR: state, ARENA_FLYWHEEL_CONFIG: conf, ...over } });
const recorded = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
const expectedText = () => spawnSync(process.execPath, [join(FLY, 'report.mjs'), '--format', 'slack', '--strict', '--today', day,
  '--now', '2026-01-01T00:00:00Z'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, ARENA_FLYWHEEL_STATE_DIR: state,
  ARENA_FLYWHEEL_CONFIG: conf } }).stdout.replace(/\n$/, '');

describe('post-report.sh', () => {
  beforeEach(() => {
    rmSync(calls, { force: true });
    rmSync(behaviour, { force: true });
    writeFileSync(statusFile, JSON.stringify(goodStatus));
  });
  test('default (no --post) prints the exact message and sends nothing, even when posting is enabled', () => {
    config(enabled);
    const r = post();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^post-report: DRY RUN \(no --post\)\. Would send to channel C0TESTCHAN1 \(notify\.postEnabled=true\):/);
    assert.ok(r.stdout.includes(expectedText()));
    assert.deepEqual(recorded(), []);
  });
  test('--post with no config, or postEnabled not exactly true, sends nothing', () => {
    rmSync(conf, { force: true });
    assert.match(post(['--post']).stdout, /posting is disabled/);
    config({ ...enabled, postEnabled: 'true' });
    assert.match(post(['--post']).stdout, /posting is disabled/);
    assert.deepEqual(recorded(), []);
  });
  test('--post when enabled sends report.mjs text byte for byte, to the configured channel, with a scrubbed env', () => {
    config(enabled);
    const r = post(['--post'], { SLACK_BOT_TOKEN: 'xoxb-must-not-leak', SLACK_MCP_TOKEN: 'xoxb-nor-this' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /posted \d+ chars to C0TESTCHAN1/);
    const got = recorded();
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].argv, ['mcp']);
    assert.equal(got[0].params.name, 'slack_send_message');
    assert.deepEqual(Object.keys(got[0].params.arguments).sort(), ['channel', 'text']);
    assert.equal(got[0].params.arguments.channel, 'C0TESTCHAN1');
    assert.equal(got[0].params.arguments.text, expectedText());
    assert.equal(got[0].tokenFile, tokenFile);
    assert.ok(!got[0].envKeys.some(k => /^SLACK_(BOT_TOKEN|MCP_TOKEN)$/.test(k)), got[0].envKeys.join(','));
  });
  test('a status that needed redaction is refused (exit 4) and nothing is sent', () => {
    config(enabled);
    writeFileSync(statusFile, JSON.stringify({ ...goodStatus, error: 'Bearer hf_abcdefghijklmnopqrstuv leaked' }));
    const r = post(['--post']);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /refused/);
    assert.deepEqual(recorded(), []);
  });
  test('server errors and early exits fail the post (exit 1) with a scrubbed message', () => {
    config(enabled);
    writeFileSync(behaviour, 'error');
    const e = post(['--post']);
    assert.equal(e.status, 1);
    assert.match(e.stderr, /slack_send_message failed: channel_not_found/);
    writeFileSync(behaviour, 'exit');
    const x = post(['--post']);
    assert.equal(x.status, 1);
    assert.match(x.stderr, /MCP server exited \(code 1\).*no Slack token/);
  });
  test('bad channel, missing MCP binary or missing token file -> exit 2 before anything is spawned', () => {
    config({ ...enabled, slackChannel: '#general' });
    assert.equal(post(['--post']).status, 2);
    config({ ...enabled, slackMcpCommand: join(tmp, 'nope') });
    assert.equal(post(['--post']).status, 2);
    config({ ...enabled, slackTokenFile: join(tmp, 'no-token') });
    assert.equal(post(['--post']).status, 2);
    assert.deepEqual(recorded(), []);
    assert.equal(post(['--date', 'yesterday']).status, 2);
    assert.equal(post(['--yes']).status, 2);
  });
  test('the script never opens the Slack token file and has no path to the arena or the flywheel', () => {
    const src = readFileSync(join(FLY, 'post-report.sh'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('#') && !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /(cat|<|readFileSync\()\s*"?\$?\{?TOKEN_FILE/);
    assert.doesNotMatch(code, /openenvarena|arena-api|flywheel\.mjs|decide\.mjs|claude\s+-p/);
  });
});
