#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// proxy-pin-drift.mjs — watch META_PROXY_VERSION against cognitum-one/meta-proxy-dist.
//
// The watcher used to live entirely in proxy-pin-drift.yml as inline shell. It compared two
// version strings and opened an issue on any inequality. That was too coarse in four ways, and
// #174 is the artifact of all four at once:
//
//   1. The issue title embedded both version numbers, so it doubled as the dedupe key. The moment
//      either side moved, the search stopped matching and the watcher opened a *second* issue
//      instead of updating the first.
//   2. Nothing ever closed a drift issue. #174 still asserts the pin is 0.7.2 long after #175
//      moved it to 0.7.4 — a permanently wrong open bug.
//   3. Any inequality was reported as "behind". A pin that runs *ahead* of the latest release is
//      the more dangerous state (`proxy install` 404s on assets that were never published), and it
//      got the exact opposite advice: "bump META_PROXY_VERSION".
//   4. `gh release list --limit 1` is newest-by-date, not "latest" — it happily returns a draft or
//      a prerelease, which would have us pinning every user onto an RC.
//
// It also never did the one check #174's own resolution text asks for: that
// META_PROXY_SIGNING_PUBKEY_PEM still verifies the release. A rotated key does not show up as
// drift, it shows up as every `metaharness proxy install --yes` failing signature verification.
// So we verify the pinned key against the pinned release every run, and against the *candidate*
// release before recommending a bump — otherwise the recommendation is "bump and break installs".
//
// Everything below the CLI boundary is pure and unit-tested in proxy-pin-drift.test.mjs; the `gh`
// and network calls are injected so the tests never touch either.
import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PIN_SOURCE = 'packages/create-agent-harness/src/meta-proxy.ts';
export const DIST_REPO = 'cognitum-one/meta-proxy-dist';

/**
 * Every drift issue this watcher has ever opened matches this search, including the pre-fix ones
 * whose titles still carry version numbers. That is deliberate: it is what lets the first run
 * after this lands find #174 and close it rather than orphaning it.
 */
export const DRIFT_SEARCH = 'meta-proxy pin drift in:title author:app/github-actions';

/** Stable titles — no version numbers, so the dedupe key survives a version change. */
export const DRIFT_TITLES = {
  behind: 'meta-proxy pin drift — META_PROXY_VERSION is behind meta-proxy-dist',
  ahead: 'meta-proxy pin drift — META_PROXY_VERSION is ahead of meta-proxy-dist',
  unsigned: 'meta-proxy pin drift — pinned signing key does not verify the pinned release',
};

// ───────────────────────────────── reading the pin ─────────────────────────────────

// We read the literals out of the TypeScript source rather than importing the built package: the
// scheduled job checks out the repo and runs, with no `npm ci` and no dist/. Reading the source
// also means we are checking the values that actually ship, not a stale build artifact.

export function readPinnedVersion(source) {
  const match = source.match(/META_PROXY_VERSION = '([^']+)'/);
  if (!match) throw new Error(`Could not find META_PROXY_VERSION in ${PIN_SOURCE}.`);
  return match[1];
}

export function readPinnedPublicKey(source) {
  const match = source.match(/META_PROXY_SIGNING_PUBKEY_PEM = `([^`]+)`/);
  if (!match) throw new Error(`Could not find META_PROXY_SIGNING_PUBKEY_PEM in ${PIN_SOURCE}.`);
  return match[1];
}

export function readReleaseBase(source) {
  const match = source.match(/META_PROXY_RELEASE_BASE = '([^']+)'/);
  if (!match) throw new Error(`Could not find META_PROXY_RELEASE_BASE in ${PIN_SOURCE}.`);
  return match[1];
}

// ───────────────────────────────── version ordering ─────────────────────────────────

/** -1 / 0 / 1. A prerelease sorts below the release it leads to (0.8.0-rc.1 < 0.8.0). */
export function compareVersions(a, b) {
  const split = (value) => {
    const [core, pre = ''] = value.replace(/^v/, '').split('-');
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const delta = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return left.pre > right.pre ? 1 : -1;
}

export function classifyPin(pinned, latest) {
  const order = compareVersions(pinned, latest);
  if (order === 0) return 'current';
  return order < 0 ? 'behind' : 'ahead';
}

// ───────────────────────────────── signature verification ─────────────────────────────────

/** The same check `installMetaProxy` performs, run against a release we have not shipped yet. */
export function verifyManifestSignature(sums, signatureBase64, publicKeyPem) {
  try {
    const signature = Buffer.from(String(signatureBase64).trim(), 'base64');
    return signature.length > 0
      && verifyEd25519(null, sums, createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

/**
 * Fetch a release's signed manifest and check it against the pinned key. `null` means we could not
 * reach the assets at all — an unreachable release is not evidence of a rotated key, and reporting
 * it as one would be its own false alarm.
 */
export async function checkReleaseSignature(fetcher, releaseBase, version, publicKeyPem) {
  const base = `${releaseBase.replace(/\/$/, '')}/v${version}`;
  const [sums, signature] = await Promise.all([
    fetcher(`${base}/SHA256SUMS`),
    fetcher(`${base}/SHA256SUMS.sig`),
  ]);
  if (!sums || !signature) return null;
  return verifyManifestSignature(sums, signature.toString('utf8'), publicKeyPem);
}

// ───────────────────────────────── the decision ─────────────────────────────────

/**
 * Reduce the observed state to exactly one action. Returning a single object — rather than
 * branching inside the workflow's shell — is what makes the interesting cases testable.
 *
 * `pinnedKeyOk` / `latestKeyOk` are tri-state: true, false, or null for "could not check".
 */
export function decideDriftAction({ pinned, latest, state, pinnedKeyOk, latestKeyOk }) {
  // A pinned release the pinned key no longer verifies outranks version drift: every install is
  // already failing closed, and bumping the version would not fix it.
  if (pinnedKeyOk === false) {
    return {
      action: 'open',
      title: DRIFT_TITLES.unsigned,
      body: [
        `\`META_PROXY_SIGNING_PUBKEY_PEM\` no longer verifies the \`SHA256SUMS\` signature for the`,
        `pinned release \`v${pinned}\`. \`metaharness proxy install --yes\` fails closed for every`,
        `user on this CLI — it refuses to install rather than trusting an unverified binary.`,
        ``,
        `**To resolve:** re-pin \`META_PROXY_SIGNING_PUBKEY_PEM\` in \`${PIN_SOURCE}\` from`,
        `meta-proxy's current \`signing-key.pub.pem\`, confirm it verifies \`v${pinned}\`, and`,
        `publish the CLI. Treat an unexplained key change as a security event before assuming a`,
        `routine rotation.`,
      ].join('\n'),
    };
  }

  if (state === 'current') {
    return {
      action: 'close',
      comment: [
        `Resolved — \`META_PROXY_VERSION\` is \`${pinned}\`, which matches \`${DIST_REPO}\` latest`,
        `\`v${latest}\`, and the pinned signing key verifies that release.`,
        ``,
        `Closed automatically by \`proxy-pin-drift\`.`,
      ].join('\n'),
    };
  }

  if (state === 'ahead') {
    return {
      action: 'open',
      title: DRIFT_TITLES.ahead,
      body: [
        `\`META_PROXY_VERSION\` is pinned at \`${pinned}\`, but the latest \`${DIST_REPO}\` release`,
        `is \`v${latest}\` — the pin is **ahead** of anything published. \`metaharness proxy install\``,
        `downloads \`v${pinned}\`, so the release assets 404 and the install fails outright.`,
        ``,
        `This usually means a release was retracted after we pinned it, or the pin was hand-edited.`,
        ``,
        `**To resolve:** re-pin \`META_PROXY_VERSION\` in \`${PIN_SOURCE}\` down to \`${latest}\`,`,
        `confirm \`META_PROXY_SIGNING_PUBKEY_PEM\` verifies that release, and publish the CLI.`,
      ].join('\n'),
    };
  }

  // Behind. The bump advice is only safe if the key still verifies the release we are recommending.
  const keyNote = latestKeyOk === true
    ? `The pinned \`META_PROXY_SIGNING_PUBKEY_PEM\` still verifies \`v${latest}\`, so a version bump on its own is sufficient.`
    : latestKeyOk === false
      ? `⚠️ The pinned \`META_PROXY_SIGNING_PUBKEY_PEM\` does **not** verify \`v${latest}\` — the signing key rotated. Re-pin the key from meta-proxy's \`signing-key.pub.pem\` in the same change, or the bump will break every install.`
      : `The \`v${latest}\` signing assets could not be fetched, so the key was not confirmed. Verify \`META_PROXY_SIGNING_PUBKEY_PEM\` against \`v${latest}\` by hand before bumping.`;

  return {
    action: 'open',
    title: DRIFT_TITLES.behind,
    body: [
      `\`META_PROXY_VERSION\` is pinned at \`${pinned}\` but \`${DIST_REPO}\` latest release is`,
      `\`v${latest}\`. \`metaharness proxy install\` downloads the pinned version, so users are`,
      `getting a stale proxy and being told it succeeded.`,
      ``,
      keyNote,
      ``,
      `**To resolve:** bump \`META_PROXY_VERSION\` in \`${PIN_SOURCE}\` to \`${latest}\` (re-pinning`,
      `the signing key in the same change if the note above says it rotated) and publish the CLI.`,
    ].join('\n'),
  };
}

// ───────────────────────────────── side effects ─────────────────────────────────

const defaultGh = (args) => {
  const result = spawnSync('gh', args, { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

const defaultFetcher = async (url) => {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
};

/** The repo's "Latest" release — excludes drafts and prereleases, unlike `gh release list`. */
export function resolveLatestRelease(gh) {
  const result = gh(['release', 'view', '--repo', DIST_REPO, '--json', 'tagName', '--jq', '.tagName']);
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^v/, '') || null;
}

export function findOpenDriftIssue(gh, repo) {
  const result = gh([
    'issue', 'list', '--repo', repo, '--search', DRIFT_SEARCH,
    '--state', 'open', '--json', 'number,title', '--limit', '1',
  ]);
  if (result.status !== 0) return null;
  try {
    const [issue] = JSON.parse(result.stdout || '[]');
    return issue ?? null;
  } catch {
    return null;
  }
}

/**
 * One open issue at a time, always accurate. An existing issue is retitled and commented rather
 * than duplicated — that is the #174 failure mode, and it is why the title carries no versions.
 */
export function applyDriftAction(gh, repo, decision, existing) {
  if (decision.action === 'close') {
    if (!existing) return 'nothing to close';
    gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', decision.comment]);
    gh(['issue', 'close', String(existing.number), '--repo', repo]);
    return `closed #${existing.number}`;
  }

  if (!existing) {
    gh(['issue', 'create', '--repo', repo, '--title', decision.title, '--label', 'bug', '--body', decision.body]);
    return 'opened a new drift issue';
  }

  if (existing.title !== decision.title) {
    gh(['issue', 'edit', String(existing.number), '--repo', repo, '--title', decision.title]);
  }
  gh(['issue', 'comment', String(existing.number), '--repo', repo, '--body', decision.body]);
  return `updated #${existing.number}`;
}

export async function run({ repo, gh = defaultGh, fetcher = defaultFetcher, source } = {}) {
  const text = source ?? readFileSync(PIN_SOURCE, 'utf8');
  const pinned = readPinnedVersion(text);
  const publicKeyPem = readPinnedPublicKey(text);
  const releaseBase = readReleaseBase(text);

  const latest = resolveLatestRelease(gh);
  if (!latest) {
    // A GitHub API blip is not drift. Staying quiet beats crying wolf on a weekly cron.
    return { ok: true, summary: `could not read ${DIST_REPO} latest release — skipping (not a drift)` };
  }

  const state = classifyPin(pinned, latest);
  const pinnedKeyOk = await checkReleaseSignature(fetcher, releaseBase, pinned, publicKeyPem);
  const latestKeyOk = state === 'behind'
    ? await checkReleaseSignature(fetcher, releaseBase, latest, publicKeyPem)
    : pinnedKeyOk;

  const decision = decideDriftAction({ pinned, latest, state, pinnedKeyOk, latestKeyOk });
  const outcome = applyDriftAction(gh, repo, decision, findOpenDriftIssue(gh, repo));
  return {
    ok: true,
    summary: `pinned=${pinned} latest=${latest} state=${state} pinnedKey=${pinnedKeyOk} → ${outcome}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('GITHUB_REPOSITORY must be set.');
    process.exit(1);
  }
  run({ repo })
    .then((result) => console.log(result.summary))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
