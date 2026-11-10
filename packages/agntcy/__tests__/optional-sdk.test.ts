// SPDX-License-Identifier: MIT
//
// `agntcy-dir` pulls `@buf/agntcy_dir.bufbuild_es` from the Buf registry, so a
// plain `npm install @metaharness/agntcy` with no `@buf:registry` line in
// `.npmrc` cannot install it. The SDK is therefore an optional dependency, and
// only Directory publishing may need it: the package entry point, CASA, OASF
// projection, identity and observability must load and work without it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OasfRecord } from '../src/oasf/record.js';

const SDK_MODULES = [
  'agntcy-dir',
  '@bufbuild/protobuf',
  '@buf/agntcy_dir.bufbuild_es/agntcy/dir/routing/v1/routing_service_pb.js',
];

function mockSdkMissing(): void {
  for (const id of SDK_MODULES) {
    vi.doMock(id, () => {
      throw new Error(`Cannot find package '${id}'`);
    });
  }
}

afterEach(() => {
  for (const id of SDK_MODULES) vi.doUnmock(id);
  vi.resetModules();
});

describe('@metaharness/agntcy without the optional Directory SDK', () => {
  it('declares the Directory SDK as optional, not required', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    expect(pkg.dependencies?.['agntcy-dir']).toBeUndefined();
    expect(pkg.optionalDependencies?.['agntcy-dir']).toBe('^1.8.1');
    // publish.ts imports these directly, so they are declared, not borrowed through hoisting.
    expect(pkg.optionalDependencies?.['@bufbuild/protobuf']).toBeDefined();
    expect(pkg.optionalDependencies?.['@buf/agntcy_dir.bufbuild_es']).toBeDefined();
  });

  it('never names the optional modules in a form tsc resolves, so it builds and type-checks without them', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/oasf/publish.ts', import.meta.url)), 'utf8');
    for (const id of ['agntcy-dir', '@bufbuild/protobuf', '@buf/agntcy_dir.bufbuild_es']) {
      expect(src).not.toMatch(new RegExp(`from '${id}|import\\('${id}`));
    }
  });

  it('loads the entry point and runs the CASA quickstart', async () => {
    mockSdkMissing();
    const mod = await import('../src/index.js');
    const env = mod.casa.compileObjectiveToEnvelope('Review the open pull requests and post review comments');
    expect(env.allow).toEqual(['repository.read']);
    expect(mod.casa.isCasaEnvelope(env)).toBe(true);
  });

  it('fails closed with an install hint when publishing is attempted', async () => {
    mockSdkMissing();
    const { publishToDirectory } = await import('../src/oasf/publish.js');
    const record = {
      schema: 1,
      generatedAt: '2026-11-10T00:00:00.000Z',
      capabilities: [{ id: 'coder', kind: 'agent' }],
      supportedProtocols: [{ host: 'claude-code' }],
      deploymentOptions: [{ mode: 'CLI + MCP', hosts: ['claude-code'] }],
    } as unknown as OasfRecord;
    const res = await publishToDirectory(record, { name: 'my-bot', version: '0.1.0', serverAddress: '127.0.0.1:1' });
    expect(res.published).toBe(false);
    expect(res.reason).toMatch(/agntcy-dir/);
    expect(res.reason).toMatch(/@buf:registry=https:\/\/buf\.build\/gen\/npm\/v1\//);
  });
});
