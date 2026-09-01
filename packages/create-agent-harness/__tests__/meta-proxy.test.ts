// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  META_PROXY_VERSION,
  acquireMetaProxyInstallLock,
  createMetaProxyPolicyToken,
  isValidReleaseVersion,
  metaProxyClientEnvironment,
  metaProxyCmd,
  metaProxyEndpoint,
  metaProxyLogLines,
  parseSha256Sums,
  probeEffectiveMetaProxy,
  resolveMetaProxyAsset,
  sha256Hex,
  verifyMetaProxyChecksum,
  verifyMetaProxyManifest,
  uninstallMetaProxy,
  worktreeFingerprint,
} from '../src/meta-proxy.js';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('optional Meta-Proxy integration', () => {
  it('pins the daemon release required by the signed extension', () => {
    expect(META_PROXY_VERSION).toBe('0.7.5');
  });

  it('maps each supported platform to the signed v0.3.0 asset name', () => {
    expect(resolveMetaProxyAsset('win32', 'x64')).toMatchObject({
      target: 'x86_64-pc-windows-msvc',
      archive: 'zip',
      assetName: `meta-proxy-${META_PROXY_VERSION}-x86_64-pc-windows-msvc.zip`,
    });
    expect(resolveMetaProxyAsset('darwin', 'arm64').assetName).toContain('aarch64-apple-darwin.tar.gz');
    expect(resolveMetaProxyAsset('linux', 'x64').assetName).toContain('x86_64-unknown-linux-gnu.tar.gz');
    expect(() => resolveMetaProxyAsset('freebsd', 'x64')).toThrow(/No signed Meta-Proxy release/);
  });

  it('only accepts release version values, never arbitrary path-like input', () => {
    expect(isValidReleaseVersion('0.3.0')).toBe(true);
    expect(isValidReleaseVersion('1.2.3-rc.1')).toBe(true);
    expect(isValidReleaseVersion('../0.3.0')).toBe(false);
    expect(isValidReleaseVersion('v0.3.0')).toBe(false);
    expect(isValidReleaseVersion('0.3.0/../../other')).toBe(false);
  });

  it('checks both the named archive checksum and the signature gate', () => {
    const archive = Buffer.from('trusted-release-bytes');
    const asset = 'meta-proxy-0.3.0-x86_64-pc-windows-msvc.zip';
    const sums = Buffer.from(`${sha256Hex(archive)}  ${asset}\n`);

    expect(parseSha256Sums(sums.toString())).toEqual(new Map([[asset, sha256Hex(archive)]]));
    expect(verifyMetaProxyChecksum(archive, asset, sums)).toBe(true);
    expect(verifyMetaProxyChecksum(Buffer.from('tampered'), asset, sums)).toBe(false);
    expect(verifyMetaProxyManifest(sums, 'not-a-valid-ed25519-signature')).toBe(false);
  });

  it('requires explicit consent before a binary download and documents the optional surface', async () => {
    const refused = await metaProxyCmd(['install']);
    expect(refused.code).toBe(2);
    expect(refused.lines.join('\n')).toMatch(/explicit consent/i);

    const help = await metaProxyCmd(['help']);
    expect(help.code).toBe(0);
    expect(help.lines.join('\n')).toMatch(/install.*status.*start.*stop.*login.*logout.*run/i);
  });

  it('passes the local proxy token only to a literal loopback endpoint', () => {
    const home = mkdtempSync(join(tmpdir(), 'metaharness-proxy-env-'));
    const priorState = process.env.RUFLO_STATE_DIR;
    try {
      const state = join(home, '.ruflo');
      mkdirSync(state, { recursive: true });
      process.env.RUFLO_STATE_DIR = state;
      writeFileSync(join(state, 'proxy-token'), 'local-token\n');
      writeFileSync(join(state, 'proxy-config.toml'), 'bind = "127.0.0.1:22435"\n');

      expect(metaProxyEndpoint(home)).toBe('http://127.0.0.1:22435');
      expect(metaProxyClientEnvironment(home)).toEqual({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:22435',
        ANTHROPIC_AUTH_TOKEN: 'local-token',
      });

      writeFileSync(join(state, 'proxy-config.toml'), 'bind = "0.0.0.0:11435"\n');
      expect(() => metaProxyEndpoint(home)).toThrow(/non-loopback/i);
    } finally {
      if (priorState === undefined) delete process.env.RUFLO_STATE_DIR;
      else process.env.RUFLO_STATE_DIR = priorState;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('validates the effective daemon version response instead of trusting the install sidecar', async () => {
    const good = await probeEffectiveMetaProxy('/tmp', async () => new Response(
      JSON.stringify({ version: '0.7.5', pid: 1234 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    expect(good).toEqual({ version: '0.7.5', pid: 1234 });

    const malformed = await probeEffectiveMetaProxy('/tmp', async () => new Response(
      JSON.stringify({ version: '../bad', pid: -1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    expect(malformed).toBeNull();
  });

  it('serializes competing installers through the shared Ruflo lease', async () => {
    const home = mkdtempSync(join(tmpdir(), 'metaharness-proxy-lock-'));
    const priorState = process.env.RUFLO_STATE_DIR;
    delete process.env.RUFLO_STATE_DIR;
    try {
      const releaseFirst = await acquireMetaProxyInstallLock(home);
      let waited = false;
      const releaseSecond = await acquireMetaProxyInstallLock(home, async () => {
        waited = true;
        releaseFirst();
      });
      expect(waited).toBe(true);
      expect(existsSync(join(home, '.ruflo', 'meta-proxy-install.lock'))).toBe(true);
      releaseSecond();
    } finally {
      if (priorState === undefined) delete process.env.RUFLO_STATE_DIR;
      else process.env.RUFLO_STATE_DIR = priorState;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('mints a scoped, signed worktree policy capability without exposing a path', () => {
    const token = createMetaProxyPolicyToken('local-proxy-secret', 'economy', worktreeFingerprint('C:/tmp/herd/agent-a'), 0);
    const [prefix, encoded, signature] = token.split('.');
    expect(prefix).toBe('mh1');
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const claim = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    expect(claim).toMatchObject({ policy: 'economy', exp: 28_800 });
    expect(claim.worktree).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(claim)).not.toContain('C:/tmp/herd/agent-a');
  });

  it('tails logs without returning the whole file', () => {
    const home = mkdtempSync(join(tmpdir(), 'proxy-logs-'));
    try {
      const root = join(home, '.metaharness', 'meta-proxy');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'meta-proxy.log'), 'one\ntwo\nthree\n');
      expect(metaProxyLogLines(home, 2)).toEqual(['two', 'three']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('uninstalls only owned files and preserves user routing state', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proxy-uninstall-'));
    try {
      const root = join(home, '.metaharness', 'meta-proxy');
      const bin = join(root, 'bin', 'meta-proxy');
      const userState = join(home, '.ruflo');
      mkdirSync(join(root, 'bin'), { recursive: true });
      mkdirSync(userState, { recursive: true });
      writeFileSync(bin, 'binary');
      writeFileSync(`${bin}.version`, '0.7.3\n');
      writeFileSync(join(root, 'meta-proxy.log'), 'log');
      writeFileSync(join(root, 'unrelated-user-note'), 'keep');
      writeFileSync(join(userState, 'proxy-token'), 'keep');
      writeFileSync(join(userState, 'proxy-config.toml'), 'keep');

      const result = await uninstallMetaProxy({
        home,
        platform: 'darwin',
        run: () => ({ ok: false, output: 'Could not find service' }),
      });

      expect(result.ok).toBe(true);
      expect(existsSync(bin)).toBe(false);
      expect(existsSync(`${bin}.version`)).toBe(false);
      expect(existsSync(join(root, 'meta-proxy.log'))).toBe(false);
      expect(existsSync(join(root, 'unrelated-user-note'))).toBe(true);
      expect(existsSync(join(userState, 'proxy-token'))).toBe(true);
      expect(existsSync(join(userState, 'proxy-config.toml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to remove the binary when service-manager state is unknown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proxy-uninstall-failure-'));
    try {
      const bin = join(home, '.metaharness', 'meta-proxy', 'bin', 'meta-proxy');
      mkdirSync(join(home, '.metaharness', 'meta-proxy', 'bin'), { recursive: true });
      writeFileSync(bin, 'binary');

      const result = await uninstallMetaProxy({
        home,
        platform: 'darwin',
        run: () => ({ ok: false, output: 'launchctl unavailable', error: 'ENOENT' }),
      });

      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/refusing to uninstall/i);
      expect(existsSync(bin)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports files it could not remove instead of throwing mid-uninstall', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proxy-uninstall-locked-'));
    try {
      const root = join(home, '.metaharness', 'meta-proxy');
      const bin = join(root, 'bin', 'meta-proxy');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(bin, 'binary');
      // A non-empty directory where the log file lives makes
      // `rmSync(path, { force: true })` throw, standing in for the Windows
      // EBUSY on a still-locked executable.
      mkdirSync(join(root, 'meta-proxy.log', 'held'), { recursive: true });

      const result = await uninstallMetaProxy({
        home,
        platform: 'darwin',
        run: () => ({ ok: false, output: 'Could not find service' }),
        wait: async () => {},
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('meta-proxy.log');
      expect(result.message).toContain('re-run: metaharness proxy uninstall --yes');
      // The failure is reported, not thrown, and the other owned files were
      // still removed.
      expect(existsSync(bin)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
