// SPDX-License-Identifier: MIT
//
// .github/workflows/*.yml structural validation.
//
// Catches the silent-CI-drift bugs that actionlint would catch but
// without bringing actionlint into the toolchain. Pins:
//   - every `run: node scripts/<X>.mjs` references a real file
//   - every workflow has unique job names
//   - publish.yml's gate steps run BEFORE any `npm publish`
//   - ci.yml's matrix covers all 3 OS

import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');
const SCRIPTS = join(process.cwd(), 'scripts');

async function listWorkflowFiles(): Promise<string[]> {
  const entries = await readdir(WORKFLOWS, { withFileTypes: true });
  return entries.filter(e => e.isFile() && /\.ya?ml$/.test(e.name)).map(e => join(WORKFLOWS, e.name));
}

describe('.github/workflows/*.yml', () => {
  it('every workflow file parses as YAML at the line level (no tab indent)', async () => {
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const tabs = text.split('\n').filter(l => /^\t/.test(l));
      expect(tabs, `${f} has ${tabs.length} tab-indented lines (use spaces)`).toEqual([]);
    }
  });

  it('every "node scripts/<X>.mjs" reference points at a real file', async () => {
    const missing: string[] = [];
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const re = /node scripts\/([\w.-]+\.m?js)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const target = join(SCRIPTS, m[1]);
        if (!existsSync(target)) missing.push(`${f}: scripts/${m[1]}`);
      }
    }
    expect(missing, missing.length ? `missing script refs: ${missing.join(', ')}` : '').toEqual([]);
  });

  it('every job name within a single workflow is unique', async () => {
    for (const f of await listWorkflowFiles()) {
      const text = await readFile(f, 'utf-8');
      const jobs = [...text.matchAll(/^\s{2}([\w-]+):\s*$/gm)]
        .map(m => m[1])
        .filter(n => !['on', 'env', 'permissions', 'jobs', 'inputs', 'concurrency', 'group'].includes(n));
      const dup = jobs.filter((n, i) => jobs.indexOf(n) !== i);
      expect(dup, `${f} has duplicate job-like keys: ${dup.join(', ')}`).toEqual([]);
    }
  });

  it('ci.yml matrix runs every gate on all 3 OS (ubuntu, macos, windows)', async () => {
    const ci = await readFile(join(WORKFLOWS, 'ci.yml'), 'utf-8');
    expect(ci).toMatch(/os:\s*\[ubuntu-latest,\s*macos-latest,\s*windows-latest\]/);
    // Pin that we actually have OS-fanned-out jobs (not just the matrix def)
    expect(ci.match(/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('publish.yml runs validate-gcp-secrets + publish-dryrun BEFORE any npm publish', async () => {
    const pub = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf-8');
    const gate1Idx = pub.indexOf('validate-gcp-secrets.mjs');
    const gate2Idx = pub.indexOf('publish-dryrun.mjs');
    // Look for the actual `run: npm publish --provenance` invocation, not
    // the literal string "npm publish" that appears in gate step `name:`s.
    const firstPubIdx = pub.search(/npm publish --provenance/);
    expect(gate1Idx, 'validate-gcp-secrets.mjs not in publish.yml').toBeGreaterThan(0);
    expect(gate2Idx, 'publish-dryrun.mjs not in publish.yml').toBeGreaterThan(0);
    expect(firstPubIdx, '`npm publish --provenance` not in publish.yml').toBeGreaterThan(0);
    expect(gate1Idx, 'Gate 1 must run before first npm publish').toBeLessThan(firstPubIdx);
    expect(gate2Idx, 'Gate 2 must run before first npm publish').toBeLessThan(firstPubIdx);
  });

  it('publish.yml runs marketplace-entry.mjs AFTER all npm publish steps', async () => {
    const pub = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf-8');
    const lastPubIdx = pub.lastIndexOf('npm publish --provenance');
    const marketplaceIdx = pub.indexOf('marketplace-entry.mjs');
    expect(marketplaceIdx, 'marketplace-entry.mjs not wired').toBeGreaterThan(0);
    expect(marketplaceIdx, 'marketplace gen must run after final npm publish').toBeGreaterThan(lastPubIdx);
  });

  it('publish.yml publishes every host adapter package', async () => {
    const pub = await readFile(join(WORKFLOWS, 'publish.yml'), 'utf-8');
    for (const host of ['host-claude-code', 'host-codex', 'host-pi-dev', 'host-hermes', 'host-openclaw', 'host-rvm']) {
      expect(pub, `publish.yml missing ${host}`).toMatch(new RegExp(host));
    }
  });
});
