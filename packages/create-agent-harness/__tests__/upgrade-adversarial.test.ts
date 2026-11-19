// SPDX-License-Identifier: MIT
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, stat, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planUpgrade, applyPlan} from '../src/upgrade.js';
import {sha256} from '../src/manifest.js';
const roots: string[] = [];
afterEach(async () => {await Promise.all(roots.splice(0).map(p => rm(p, {recursive:true,force:true})));});
async function fixture(files: Record<string,string> = {}) {
  const dir = await mkdtemp(join(tmpdir(),'upgrade-adversarial-')); roots.push(dir);
  await mkdir(join(dir,'.harness'));
  await writeFile(join(dir,'.harness/manifest.json'),JSON.stringify({files}));
  return dir;
}
describe('upgrade adversarial boundaries', () => {
  it('preserves edited rejection work before applying any other file', async () => {
    const dir = await fixture();
    await writeFile(join(dir,'policy.json'),'Local policy');
    const contents = {'added.md':'New', 'policy.json':'Upstream'};
    const plan = await planUpgrade(dir, Object.fromEntries(Object.entries(contents).map(([p,c]) => [p,sha256(c)])));
    // Another writer can create the proposal after planning.
    await writeFile(join(dir,'policy.json.rej'),'Manual merge work');
    await expect(applyPlan(dir,plan,contents)).rejects.toThrow('rejection');
    expect(await readFile(join(dir,'policy.json.rej'),'utf8')).toBe('Manual merge work');
    expect(await readFile(join(dir,'policy.json'),'utf8')).toBe('Local policy');
    await expect(readFile(join(dir,'added.md'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('leaves an identical existing proposal untouched on repeated upgrade', async () => {
    const dir = await fixture();
    await writeFile(join(dir,'policy.json'),'Local policy');
    const contents = {'policy.json':'Upstream'};
    const plan = await planUpgrade(dir, {'policy.json':sha256('Upstream')});
    await applyPlan(dir,plan,contents);
    await utimes(join(dir,'policy.json.rej'), new Date('2000-01-01'), new Date('2000-01-01'));
    const before = await stat(join(dir,'policy.json.rej'));
    await applyPlan(dir,plan,contents);
    expect((await stat(join(dir,'policy.json.rej'))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(join(dir,'policy.json'),'utf8')).toBe('Local policy');
  });
  it('refuses a hard-linked rejection file without touching its other name', async () => {
    const dir = await fixture(); const outside = await fixture();
    await writeFile(join(outside,'owned.md'),'User work');
    await writeFile(join(dir,'policy.json'),'Local policy');
    await link(join(outside,'owned.md'),join(dir,'policy.json.rej'));
    const plan = await planUpgrade(dir, {'policy.json':sha256('Upstream')});
    await expect(applyPlan(dir,plan,{'policy.json':'Upstream'})).rejects.toThrow('rejection');
    expect(await readFile(join(outside,'owned.md'),'utf8')).toBe('User work');
  });
  it('creates directories absent from an older scaffold', async () => {
    const dir = await fixture();
    const contents = {'agents/reviewer.md':'New generated reviewer'};
    const plan = await planUpgrade(dir, {'agents/reviewer.md':sha256(contents['agents/reviewer.md'])});
    await applyPlan(dir,plan,contents);
    expect(await readFile(join(dir,'agents/reviewer.md'),'utf8')).toBe('New generated reviewer');
  });
  it('does not overwrite a file created after planning', async () => {
    const dir = await fixture(); const contents = {'reviewer.md':'Generated'};
    const plan = await planUpgrade(dir,{'reviewer.md':sha256('Generated')});
    await writeFile(join(dir,'reviewer.md'),'Concurrent writer');
    await expect(applyPlan(dir,plan,contents)).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(join(dir,'reviewer.md'),'utf8')).toBe('Concurrent writer');
  });
  it('treats an identical unmanaged file as a no-op', async () => {
    const dir = await fixture(); await writeFile(join(dir,'reviewer.md'),'Generated');
    const plan = await planUpgrade(dir,{'reviewer.md':sha256('Generated')});
    expect(plan.added).toEqual([]); expect(plan.changed).toEqual([]);
  });
  it.each(['.harness/mcp-policy.json', '.claude/settings.json', '.opencode/opencode.json', '.codex/config.toml', '.openclaw/openclaw.json', '.vscode/mcp.json', 'cli-config.yaml', '.github/workflows/harness.yml'])('keeps conflicting active policy %s byte-for-byte even with default inline mode', async path => {
    const dir = await fixture(); await mkdir(join(dir, path.split('/').slice(0,-1).join('/')), {recursive:true});
    const current = '{"defaultDeny":true,"maxToolCallsPerTurn":2}';
    const incoming = '{"defaultDeny":true,"maxToolCallsPerTurn":8}';
    await writeFile(join(dir,path),current);
    const plan = await planUpgrade(dir,{[path]:sha256(incoming)});
    await applyPlan(dir,plan,{[path]:incoming});
    expect(await readFile(join(dir,path),'utf8')).toBe(current);
    expect(await readFile(join(dir,path+'.rej'),'utf8')).toBe(incoming);
  });
  it('does not conflict when a tracked file already equals the new template', async () => {
    const dir = await fixture({'reviewer.md':sha256('Old generated')});
    await writeFile(join(dir,'reviewer.md'),'New generated');
    const plan = await planUpgrade(dir,{'reviewer.md':sha256('New generated')});
    expect(plan.changed).toEqual([]);
  });
  it.each(['../outside.md','/outside.md','agents/../../outside.md','agents\\outside.md'])('rejects an unsafe path %s before writing', async path => {
    const dir = await fixture();
    await expect(planUpgrade(dir,{[path]:sha256('Incoming')})).rejects.toThrow('Unsafe upgrade path');
  });
  it.skipIf(process.platform === 'win32')('refuses a symlinked directory rather than writing outside the harness', async () => {
    const dir = await fixture(); const outside = await fixture();
    await symlink(outside,join(dir,'agents'),'dir');
    await expect(planUpgrade(dir,{'agents/reviewer.md':sha256('Incoming')})).rejects.toThrow('symbolic link');
    await expect(readFile(join(outside,'reviewer.md'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it.skipIf(process.platform === 'win32')('preflights a symlinked rejection file before any planned writes', async () => {
    const dir = await fixture(); const outside = await fixture();
    await writeFile(join(outside,'owned.md'),'Outside');
    await writeFile(join(dir,'reviewer.md'),'User-owned');
    await symlink(join(outside,'owned.md'),join(dir,'reviewer.md.rej'));
    const plan = {added:['new.md'],removed:[],changed:[{path:'reviewer.md',kind:'conflict' as const}]};
    await expect(applyPlan(dir,plan,{'new.md':'New','reviewer.md':'Incoming'},{conflictStyle:'rej'})).rejects.toThrow('symbolic link');
    expect(await readFile(join(outside,'owned.md'),'utf8')).toBe('Outside');
    await expect(readFile(join(dir,'new.md'))).rejects.toMatchObject({code:'ENOENT'});
  });
});
