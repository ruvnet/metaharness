// report.mjs: short summary + Slack text from flywheel-report.mjs status JSON. Print-only, deterministic.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DECISION_KEYS } from '../decide.mjs';
import { main, policyView, POLICY_GROUPS, redact, renderMarkdown, renderSlack, safeUrl, SLACK_MAX } from '../report.mjs';

const REPORT = join(dirname(fileURLToPath(import.meta.url)), '..', 'report.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'arena-fw-report-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const HEX = '0123456789abcdef'.repeat(4);
function status(over = {}) {
  return {
    date: '2026-10-09', outcome: 'skipped', mode: 'dry-run', wouldSubmitInAuto: false,
    decision: { submit: false, reasons: ['modeAuto', 'gatePromote'] },
    incumbent: { source: 'v2-defaults', genomeDigest: HEX, day1: true },
    candidate: { variantId: 'g2c1', genomeDigest: HEX.replace('0', '1'), changedFamilies: ['sql'] },
    darwin: { evidence: 'evaluator_scorecards', improvedOverBaseline: true },
    confirmation: { incumbentScore: { primary: 1.25, noopRate: 0.5, costPerWin: 900 }, candidateScore: { primary: 1.5 } },
    gate: { promote: false, verified: true, publicKeyPinned: true, reasons: ['noop_rate_not_improved'] },
    request: { requestPath: '/s/req.json', requestSha256: HEX, submissionId: 'metaharness-darwin-x', image: 'ghcr.io/a/b@sha256:' + HEX,
      tasks: [{ task_id: 't1' }], checks: { requestSha256: HEX, checks: { anonymousPull: { ok: true }, openenvValidate: { ok: false, detail: 'timeout' } } } },
    slot: { preflight: { free: true }, decision: { free: true } }, gpu: { instanceId: 7, destroyed: true }, submission: null,
    ...over,
  };
}
const run = (args, env = {}) => spawnSync(process.execPath, [REPORT, ...args],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, ...env } });

describe('policy view over decide.mjs flags', () => {
  test('every DECISION_KEY is placed in exactly one group, so no flag is silently dropped', () => {
    const grouped = POLICY_GROUPS.flatMap(([, k]) => k);
    assert.equal(new Set(grouped).size, grouped.length);
    for (const k of grouped) assert.ok(DECISION_KEYS.includes(k), `${k} is not a decide.mjs key`);
    assert.deepEqual([...grouped].sort(), [...DECISION_KEYS].sort());
  });
  test('rows follow decideSubmit reasons; a missing decision is UNKNOWN, never PASS', () => {
    const p = policyView(status());
    assert.deepEqual(p.rows.map(r => r.result), ['FAIL', 'PASS', 'PASS', 'FAIL']);
    assert.equal(p.allPass, false);
    const none = policyView(status({ decision: undefined }));
    assert.ok(none.rows.every(r => r.result === 'UNKNOWN'));
    assert.equal(none.allPass, false);
  });
  test('all four PASS only with submit=true and no reasons; unknown reasons block', () => {
    assert.equal(policyView(status({ decision: { submit: true, reasons: [] }, mode: 'auto' })).allPass, true);
    const odd = policyView(status({ decision: { submit: true, reasons: ['unexpected_flag:x'] } }));
    assert.equal(odd.allPass, false);
    assert.deepEqual(odd.extra, ['unexpected_flag:x']);
  });
  test('a posted submission without mode=auto and all conditions is flagged INCONSISTENT', () => {
    const md = renderMarkdown(status({ submission: { posted: true, submissionId: 's', state: 'validating', httpStatus: 202 } }));
    assert.match(md, /\*\*INCONSISTENT/);
    const ok = renderMarkdown(status({ mode: 'auto', decision: { submit: true, reasons: [] }, submission: { posted: true } }));
    assert.doesNotMatch(ok, /INCONSISTENT/);
  });
});

describe('rendering', () => {
  test('missing numbers render as unknown, never 0', () => {
    const md = renderMarkdown(status({ confirmation: {} }));
    assert.match(md, /\| incumbent \| unknown \| unknown \| unknown \|/);
    assert.doesNotMatch(md, /\| incumbent \| 0 /);
    assert.match(renderMarkdown(status({ slot: undefined })), /free at preflight unknown, at decision unknown/);
  });
  test('needs-human, GPU destroy failure and failed checks are surfaced', () => {
    const md = renderMarkdown(status({ needsHuman: { requestPath: '/s/needs-human.json', requestSha256: HEX },
      gpu: { instanceId: 9, destroyed: false, downError: 'destroy unconfirmed' } }));
    assert.match(md, /NEEDS HUMAN: a v2-defaults request was rendered for review: \/s\/needs-human\.json/);
    assert.match(md, /GPU DESTROY NOT CONFIRMED for instance 9/);
    assert.match(md, /checks 1\/5 passed \(failed: openenvValidate \(timeout\)\)/);
  });
  test('Slack text escapes mrkdwn control characters and neutralises broadcast mentions', () => {
    const sl = renderSlack(status({ error: '<!channel> @here <https://evil.example|click> & more' }));
    assert.doesNotMatch(sl, /<!channel>|@here|<https:\/\/evil/);
    assert.match(sl, /&lt;!channel&gt; \(at\)here &lt;https:\/\/evil\.example\|click&gt; &amp; more/);
    assert.ok(renderSlack(status({ error: 'x'.repeat(20000) })).length <= SLACK_MAX);
  });
  test('only https arena/HF dashboard links become Slack links', () => {
    assert.equal(safeUrl('https://openenvarena-training.hf.space/?project=ruv&runs=r1'), 'https://openenvarena-training.hf.space/?project=ruv&runs=r1');
    assert.equal(safeUrl('http://openenvarena-training.hf.space/'), null);
    assert.equal(safeUrl('https://evil.example/hf.space'), null);
    const sl = renderSlack(status({ submission: { posted: true, dashboard: 'https://openenvarena-training.hf.space/?runs=r1' } }));
    assert.match(sl, /<https:\/\/openenvarena-training\.hf\.space\/\?runs=r1\|Run dashboard>/);
  });
  test('identical input renders identical output (no clock)', () => {
    assert.equal(renderMarkdown(status()), renderMarkdown(status()));
    assert.equal(renderSlack(status()), renderSlack(status()));
  });
});

describe('redaction', () => {
  test('secret keys, token shapes and bare long hex are removed; digests under digest keys are kept', () => {
    const { value, count } = redact({ token: 'abc', nested: { instance_api_key: 'k', jupyterToken: 'j', onstart: 'vllm serve' },
      completion_tokens: 4096, note: 'Authorization: Bearer hf_abcdefghijklmnop and xoxb-1234-abcd-efgh',
      vast: `key ${'a'.repeat(64)}`, requestSha256: HEX, image: `x@sha256:${HEX}` });
    assert.equal(value.token, '[REDACTED]');
    assert.equal(value.nested.instance_api_key, '[REDACTED]');
    assert.equal(value.nested.jupyterToken, '[REDACTED]');
    assert.equal(value.nested.onstart, '[REDACTED]');
    assert.equal(value.completion_tokens, 4096);
    assert.doesNotMatch(value.note, /hf_abcdef|xoxb-1234/);
    assert.equal(value.vast, 'key [hex redacted]');
    assert.equal(value.requestSha256, HEX);
    assert.equal(value.image, `x@sha256:${HEX}`);
    assert.ok(count >= 7);
  });
});

describe('CLI', () => {
  const state = join(tmp, 'state');
  mkdirSync(join(state, 'reports', '2026-10-08'), { recursive: true });
  mkdirSync(join(state, 'reports', '2026-10-09'), { recursive: true });
  mkdirSync(join(state, 'reports', 'not-a-date'), { recursive: true });
  writeFileSync(join(state, 'reports', '2026-10-08', 'status.json'), JSON.stringify(status({ date: '2026-10-08' })));
  writeFileSync(join(state, 'reports', '2026-10-09', 'status.json'), JSON.stringify(status()));
  writeFileSync(join(state, 'spend.jsonl'), [
    { v: 1, type: 'seed', ts: '2026-10-01T00:00:00Z', usd: 5 },
    { v: 1, type: 'planned', ts: '2026-10-09T15:00:00Z', runId: 'r1', usd: 7.5, dphTotal: 2.5, hours: 3, offerId: 1 },
    { v: 1, type: 'settled', ts: '2026-10-09T17:00:00Z', runId: 'r1', usd: 4.2, hours: 1.7, instanceId: 7 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const conf = join(tmp, 'config.json');
  writeFileSync(conf, JSON.stringify({ caps: { dailyUsd: 12, totalUsd: 200 } }));

  test('latest = newest dated reports dir; spend comes from the ledger; caps from config', () => {
    const r = run(['--state-dir', state, '--today', '2026-10-09', '--now', '2026-10-09T20:00:00Z', '--config', conf]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^## Arena flywheel 2026-10-09: SKIPPED \(mode dry-run\)/);
    assert.match(r.stdout, /Spend: 24h \$4\.20 of \$12\.00, total \$9\.20 of \$200\.00/);
    assert.doesNotMatch(r.stdout, /STALE/);
  });
  test('a status from another day is marked STALE; --date selects a day', () => {
    assert.match(run(['--state-dir', state, '--today', '2026-10-10', '--config', conf]).stdout, /STALE: this is the status for 2026-10-09/);
    assert.match(run(['--state-dir', state, '--date', '2026-10-08', '--config', conf]).stdout, /Arena flywheel 2026-10-08/);
  });
  test('without --now the 24h spend is unknown, not 0', () => {
    assert.match(run(['--state-dir', state, '--config', conf]).stdout, /Spend: 24h unknown of \$12\.00, total \$9\.20/);
  });
  test('a corrupt ledger is reported as invalid, never as $0', () => {
    const s2 = join(tmp, 'state2');
    mkdirSync(join(s2, 'reports', '2026-10-09'), { recursive: true });
    writeFileSync(join(s2, 'reports', '2026-10-09', 'status.json'), JSON.stringify(status()));
    writeFileSync(join(s2, 'spend.jsonl'), '{"v":1,"type":"seed","ts":"2026-10-01T00:00:00Z","usd":-1}\n');
    assert.match(run(['--state-dir', s2]).stdout, /Spend: ledger INVALID \(.*\): renting is refused/);
  });
  test('no status -> exit 3 with a NO STATUS note; bad input -> exit 2', () => {
    const r = run(['--state-dir', join(tmp, 'nothing'), '--today', '2026-10-09', '--format', 'slack']);
    assert.equal(r.status, 3);
    assert.match(r.stdout, /NO STATUS/);
    assert.equal(run(['--date', '10/09/2026']).status, 2);
    assert.equal(run(['--format', 'html']).status, 2);
    assert.equal(run(['--bogus']).status, 2);
    writeFileSync(join(tmp, 'bad.json'), '{not json');
    assert.equal(run(['--status', join(tmp, 'bad.json')]).status, 2);
  });
  test('--strict refuses (exit 4, empty stdout) when the status held a secret; default mode warns and redacts', () => {
    const f = join(tmp, 'leaky.json');
    writeFileSync(f, JSON.stringify(status({ error: 'curl -H "Authorization: Bearer hf_abcdefghijklmnopqrst" failed' })));
    const strict = run(['--status', f, '--format', 'slack', '--strict']);
    assert.equal(strict.status, 4);
    assert.equal(strict.stdout, '');
    const loose = run(['--status', f]);
    assert.equal(loose.status, 0);
    assert.doesNotMatch(loose.stdout, /hf_abcdefghij/);
    assert.match(loose.stderr, /redacted/);
    const pre = join(tmp, 'pre-redacted.json');
    writeFileSync(pre, JSON.stringify(status({ error: 'token=[REDACTED] upstream' })));
    assert.equal(run(['--status', pre, '--strict']).status, 4);
  });
  test('systemd ExecStopPost variables are shown when present', () => {
    const r = run(['--state-dir', state], { SERVICE_RESULT: 'timeout', EXIT_CODE: 'killed', EXIT_STATUS: 'TERM' });
    assert.match(r.stdout, /systemd: result=timeout exit=killed\/TERM/);
  });
  test('main() is importable and returns the exit code', () => {
    const lines = [];
    assert.equal(main(['--status', join(state, 'reports', '2026-10-09', 'status.json'), '--format', 'both'], {}, s => lines.push(s), () => {}), 0);
    assert.match(lines.join('\n'), /\n---\n\*Arena flywheel 2026-10-09/);
  });
});
