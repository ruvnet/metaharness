import {afterEach, it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyPlan, planUpgrade} from '../src/upgrade.js';
import {sha256} from '../src/manifest.js';

const race = vi.hoisted(() => ({target:''}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {...actual, mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
    const result = await actual.mkdir(...args);
    if (race.target) {
      const target = race.target; race.target = '';
      // Another writer wins between proposal preflight and creation.
      await actual.writeFile(target, 'Concurrent merge work');
    }
    return result;
  }};
});
let dir = '';
afterEach(async () => {race.target = ''; if (dir) await rm(dir,{recursive:true,force:true});});
it('uses exclusive proposal creation before writing other upgrade files', async () => {
  dir = await mkdtemp(join(tmpdir(),'upgrade-rejection-race-'));
  await mkdir(join(dir,'.harness'));
  await writeFile(join(dir,'.harness/manifest.json'),JSON.stringify({files:{}}));
  await writeFile(join(dir,'policy.json'),'Local policy');
  const contents = {'added.md':'New','policy.json':'Upstream'};
  const plan = await planUpgrade(dir,Object.fromEntries(Object.entries(contents).map(([p,c]) => [p,sha256(c)])));
  race.target = join(dir,'policy.json.rej');
  await expect(applyPlan(dir,plan,contents)).rejects.toMatchObject({code:'EEXIST'});
  expect(await readFile(join(dir,'policy.json.rej'),'utf8')).toBe('Concurrent merge work');
  expect(await readFile(join(dir,'policy.json'),'utf8')).toBe('Local policy');
  await expect(readFile(join(dir,'added.md'))).rejects.toMatchObject({code:'ENOENT'});
});
