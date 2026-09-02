#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Pure-logic tests for proxy-pin-drift.mjs. NO network, NO `gh` — both are injected.
// Run: node scripts/proxy-pin-drift.test.mjs
import assert from 'node:assert';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DIST_REPO, DRIFT_SEARCH, DRIFT_TITLES, PIN_SOURCE,
  applyDriftAction, checkReleaseSignature, classifyPin, compareVersions, decideDriftAction,
  findOpenDriftIssue, readPinnedPublicKey, readPinnedVersion, readReleaseBase,
  resolveLatestRelease, run, verifyManifestSignature,
} from './proxy-pin-drift.mjs';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };
const at = async (name, fn) => { try { await fn(); pass++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}: ${e.message}`); process.exitCode = 1; } };

/** Records every `gh` invocation and replays canned output keyed by the subcommand pair. */
const fakeGh = (responses = {}) => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    return responses[key] ?? { status: 0, stdout: '', stderr: '' };
  };
  gh.calls = calls;
  gh.ran = (subcommand) => calls.filter((args) => `${args[0]} ${args[1]}` === subcommand);
  return gh;
};

console.log('proxy-pin-drift.mjs unit tests:');

// ── the pin is read out of the real shipped source, so a refactor there fails here ──

const REAL_SOURCE = readFileSync(PIN_SOURCE, 'utf8');

t('reads META_PROXY_VERSION out of the real meta-proxy.ts', () => {
  assert.match(readPinnedVersion(REAL_SOURCE), /^\d+\.\d+\.\d+/);
});

t('reads the pinned Ed25519 key out of the real meta-proxy.ts', () => {
  // \r?\n, not \n: meta-proxy.ts is not pinned to eol=lf in .gitattributes, so a
  // Windows checkout hands us a CRLF PEM. crypto.createPublicKey() accepts both
  // (verified), and the PEM only ever reaches createPublicKey -- it is never
  // string-compared or hashed -- so this is a test portability fix, not a
  // production one. Caught by CI on windows-latest after #178 merged.
  assert.match(readPinnedPublicKey(REAL_SOURCE), /^-----BEGIN PUBLIC KEY-----\r?\n/);
});

t('reads the release base out of the real meta-proxy.ts', () => {
  assert.equal(readReleaseBase(REAL_SOURCE), `https://github.com/${DIST_REPO}/releases/download`);
});

t('fails loudly rather than silently reporting no drift when the pin moves', () => {
  assert.throws(() => readPinnedVersion('const SOMETHING_ELSE = 1;'), /META_PROXY_VERSION/);
});

// ── version ordering: the fix for "any inequality is behind" ──

t('compareVersions orders release triples', () => {
  assert.equal(compareVersions('0.7.4', '0.7.4'), 0);
  assert.equal(compareVersions('0.7.2', '0.7.3'), -1);
  assert.equal(compareVersions('0.7.10', '0.7.9'), 1);
  assert.equal(compareVersions('0.8.0', '0.7.99'), 1);
  assert.equal(compareVersions('v0.7.4', '0.7.4'), 0);
});

t('compareVersions sorts a prerelease below the release it leads to', () => {
  assert.equal(compareVersions('0.8.0-rc.1', '0.8.0'), -1);
  assert.equal(compareVersions('0.8.0', '0.8.0-rc.1'), 1);
  assert.equal(compareVersions('0.8.0-rc.1', '0.8.0-rc.2'), -1);
});

t('classifyPin distinguishes behind from ahead instead of collapsing both', () => {
  assert.equal(classifyPin('0.7.4', '0.7.4'), 'current');
  assert.equal(classifyPin('0.7.2', '0.7.3'), 'behind');
  assert.equal(classifyPin('0.7.4', '0.7.3'), 'ahead');
});

// ── signature verification ──

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const SUMS = Buffer.from('3902fd304ea46a40a5e51f06b0b571a4  meta-proxy-0.7.4-aarch64-apple-darwin.tar.gz\n');
const SIG = edSign(null, SUMS, privateKey).toString('base64');

t('verifyManifestSignature accepts a genuine signature', () => {
  assert.equal(verifyManifestSignature(SUMS, SIG, PEM), true);
});

t('verifyManifestSignature rejects a tampered manifest', () => {
  assert.equal(verifyManifestSignature(Buffer.from(`${SUMS}tampered`), SIG, PEM), false);
});

t('verifyManifestSignature rejects a signature from a rotated key', () => {
  const other = generateKeyPairSync('ed25519');
  const otherSig = edSign(null, SUMS, other.privateKey).toString('base64');
  assert.equal(verifyManifestSignature(SUMS, otherSig, PEM), false);
});

t('verifyManifestSignature returns false rather than throwing on garbage input', () => {
  assert.equal(verifyManifestSignature(SUMS, '', PEM), false);
  assert.equal(verifyManifestSignature(SUMS, SIG, 'not a pem'), false);
});

await at('checkReleaseSignature reports null when the assets are unreachable', async () => {
  const result = await checkReleaseSignature(async () => null, 'https://example.test', '0.7.4', PEM);
  assert.equal(result, null, 'an unreachable release must not be reported as a rotated key');
});

await at('checkReleaseSignature fetches the pinned version tag', async () => {
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    return url.endsWith('.sig') ? Buffer.from(SIG) : SUMS;
  };
  assert.equal(await checkReleaseSignature(fetcher, 'https://example.test/', '0.7.4', PEM), true);
  assert.deepEqual(seen.sort(), [
    'https://example.test/v0.7.4/SHA256SUMS',
    'https://example.test/v0.7.4/SHA256SUMS.sig',
  ]);
});

// ── the decision table ──

t('a current pin closes the open drift issue instead of leaving it asserting a stale version', () => {
  const decision = decideDriftAction({ pinned: '0.7.4', latest: '0.7.4', state: 'current', pinnedKeyOk: true, latestKeyOk: true });
  assert.equal(decision.action, 'close');
  assert.match(decision.comment, /Resolved/);
});

t('a behind pin whose key still verifies says a plain bump is enough', () => {
  const decision = decideDriftAction({ pinned: '0.7.2', latest: '0.7.3', state: 'behind', pinnedKeyOk: true, latestKeyOk: true });
  assert.equal(decision.action, 'open');
  assert.equal(decision.title, DRIFT_TITLES.behind);
  assert.match(decision.body, /bump on its own is sufficient/);
});

t('a behind pin whose key rotated warns before the bump breaks every install', () => {
  const decision = decideDriftAction({ pinned: '0.7.2', latest: '0.7.3', state: 'behind', pinnedKeyOk: true, latestKeyOk: false });
  assert.match(decision.body, /signing key rotated/);
  assert.match(decision.body, /Re-pin the key/);
});

t('a behind pin with unreachable assets asks for a manual key check, not a false rotation claim', () => {
  const decision = decideDriftAction({ pinned: '0.7.2', latest: '0.7.3', state: 'behind', pinnedKeyOk: true, latestKeyOk: null });
  assert.match(decision.body, /could not be fetched/);
  assert.doesNotMatch(decision.body, /signing key rotated/, 'unreachable assets are not evidence of rotation');
});

t('an ahead pin is reported as ahead, with re-pin-down advice rather than "bump"', () => {
  const decision = decideDriftAction({ pinned: '0.7.4', latest: '0.7.3', state: 'ahead', pinnedKeyOk: true, latestKeyOk: true });
  assert.equal(decision.title, DRIFT_TITLES.ahead);
  assert.match(decision.body, /404/);
  assert.match(decision.body, /down to `0\.7\.3`/);
});

t('a pinned release the pinned key cannot verify outranks version drift', () => {
  const decision = decideDriftAction({ pinned: '0.7.2', latest: '0.7.3', state: 'behind', pinnedKeyOk: false, latestKeyOk: true });
  assert.equal(decision.title, DRIFT_TITLES.unsigned);
  assert.match(decision.body, /fails closed/);
});

t('#174 regression — no title carries a version number, so it stays a stable dedupe key', () => {
  for (const [state, title] of Object.entries(DRIFT_TITLES)) {
    assert.doesNotMatch(title, /\d+\.\d+\.\d+/, `${state} title embeds a version`);
  }
  assert.doesNotMatch(DRIFT_SEARCH, /\d+\.\d+\.\d+/);
  // The phrase every pre-fix issue title also opens with, so #174 is still findable.
  assert.match(DRIFT_SEARCH, /meta-proxy pin drift in:title/);
});

// ── the gh surface ──

t('resolveLatestRelease uses `release view`, which excludes drafts and prereleases', () => {
  const gh = fakeGh({ 'release view': { status: 0, stdout: 'v0.7.4\n', stderr: '' } });
  assert.equal(resolveLatestRelease(gh), '0.7.4');
  assert.equal(gh.ran('release list').length, 0, '`release list --limit 1` is newest-by-date, not latest');
});

t('resolveLatestRelease returns null when gh fails, so a blip is not read as drift', () => {
  assert.equal(resolveLatestRelease(fakeGh({ 'release view': { status: 1, stdout: '', stderr: 'boom' } })), null);
});

t('findOpenDriftIssue survives malformed gh output', () => {
  assert.equal(findOpenDriftIssue(fakeGh({ 'issue list': { status: 0, stdout: 'not json', stderr: '' } }), 'o/r'), null);
  assert.equal(findOpenDriftIssue(fakeGh({ 'issue list': { status: 0, stdout: '[]', stderr: '' } }), 'o/r'), null);
});

t('#174 regression — an existing issue is retitled and commented, never duplicated', () => {
  const gh = fakeGh();
  const existing = { number: 174, title: 'meta-proxy pin drift — META_PROXY_VERSION (0.7.2) is behind meta-proxy-dist v0.7.3' };
  const outcome = applyDriftAction(gh, 'o/r', { action: 'open', title: DRIFT_TITLES.ahead, body: 'b' }, existing);

  assert.equal(outcome, 'updated #174');
  assert.equal(gh.ran('issue create').length, 0, 'a second issue must not be opened');
  assert.deepEqual(gh.ran('issue edit')[0], ['issue', 'edit', '174', '--repo', 'o/r', '--title', DRIFT_TITLES.ahead]);
  assert.equal(gh.ran('issue comment').length, 1);
});

t('an accurate existing title is left alone, not churned with a no-op edit', () => {
  const gh = fakeGh();
  applyDriftAction(gh, 'o/r', { action: 'open', title: DRIFT_TITLES.behind, body: 'b' }, { number: 9, title: DRIFT_TITLES.behind });
  assert.equal(gh.ran('issue edit').length, 0);
});

t('the first drift opens a labelled issue', () => {
  const gh = fakeGh();
  assert.equal(applyDriftAction(gh, 'o/r', { action: 'open', title: DRIFT_TITLES.behind, body: 'b' }, null), 'opened a new drift issue');
  assert.deepEqual(gh.ran('issue create')[0].slice(0, 6), ['issue', 'create', '--repo', 'o/r', '--title', DRIFT_TITLES.behind]);
});

t('#174 regression — a resolved drift comments and closes the open issue', () => {
  const gh = fakeGh();
  const outcome = applyDriftAction(gh, 'o/r', { action: 'close', comment: 'resolved' }, { number: 174, title: 'old' });
  assert.equal(outcome, 'closed #174');
  assert.equal(gh.ran('issue comment').length, 1, 'closing silently leaves no trail of why');
  assert.deepEqual(gh.ran('issue close')[0], ['issue', 'close', '174', '--repo', 'o/r']);
});

t('a resolved drift with nothing open is a no-op', () => {
  const gh = fakeGh();
  assert.equal(applyDriftAction(gh, 'o/r', { action: 'close', comment: 'resolved' }, null), 'nothing to close');
  assert.equal(gh.calls.length, 0);
});

// ── end to end, still with no network and no gh ──

const SYNTHETIC_SOURCE = `
export const META_PROXY_VERSION = '0.7.2';
export const META_PROXY_RELEASE_BASE = 'https://example.test/releases/download';
export const META_PROXY_SIGNING_PUBKEY_PEM = \`${PEM}\`;
`;

await at('run() drives a behind pin to a single updated issue', async () => {
  const gh = fakeGh({
    'release view': { status: 0, stdout: 'v0.7.3\n', stderr: '' },
    'issue list': { status: 0, stdout: JSON.stringify([{ number: 174, title: 'old title' }]), stderr: '' },
  });
  const fetcher = async (url) => (url.endsWith('.sig') ? Buffer.from(SIG) : SUMS);
  const result = await run({ repo: 'o/r', gh, fetcher, source: SYNTHETIC_SOURCE });

  assert.match(result.summary, /pinned=0\.7\.2 latest=0\.7\.3 state=behind/);
  assert.match(result.summary, /updated #174/);
  assert.equal(gh.ran('issue create').length, 0);
});

await at('run() stays quiet when gh cannot reach the release API', async () => {
  const gh = fakeGh({ 'release view': { status: 1, stdout: '', stderr: 'rate limited' } });
  const result = await run({ repo: 'o/r', gh, fetcher: async () => null, source: SYNTHETIC_SOURCE });

  assert.match(result.summary, /skipping \(not a drift\)/);
  assert.equal(gh.ran('issue create').length, 0);
  assert.equal(gh.ran('issue comment').length, 0);
});

await at('run() closes the stale issue once the pin catches up — the #174 end state', async () => {
  const gh = fakeGh({
    'release view': { status: 0, stdout: 'v0.7.2\n', stderr: '' },
    'issue list': { status: 0, stdout: JSON.stringify([{ number: 174, title: 'old title' }]), stderr: '' },
  });
  const fetcher = async (url) => (url.endsWith('.sig') ? Buffer.from(SIG) : SUMS);
  const result = await run({ repo: 'o/r', gh, fetcher, source: SYNTHETIC_SOURCE });

  assert.match(result.summary, /state=current/);
  assert.match(result.summary, /closed #174/);
});

console.log(`\n${pass} assertions passed.`);
