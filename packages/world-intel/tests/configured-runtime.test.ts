import {realpathSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync,readdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConfiguredRuntime,explicitDataDirectory} from '../src/configured-runtime.js';
import {withExecutionPolicy} from '../src/execution-policy.js';
const [major,minor]=process.versions.node.split('.').map(Number);
describe.skipIf(major<22||major===22&&minor<13)('explicit configured runtime',()=>{
 it('wires all160 tools with durable stores without downloading a model',async()=>{const dir=mkdtempSync(join(realpathSync(tmpdir()),'intel-config-'));let r:ReturnType<typeof createConfiguredRuntime>|undefined;try{r=createConfiguredRuntime(dir);expect(Object.keys(r.handlers)).toHaveLength(160);expect(await r.handlers.intel_vector_stats({})).toMatchObject({enabled:true,points_count:0});expect(await r.handlers.intel_status({})).toMatchObject({vector_store:{enabled:true}});const denied=await r.handlers.intel_aoi_define({name:'Test',lat:43,lon:-79,radius_km:10});expect(denied).toMatchObject({reason:'write_policy_denied'});const saved=await withExecutionPolicy(true,async()=>r!.handlers.intel_aoi_define({name:'Test',lat:43,lon:-79,radius_km:10}));expect(saved).not.toHaveProperty('error');expect(readdirSync(dir).some(n=>n.includes('model'))).toBe(false);r.close();r=createConfiguredRuntime(dir);const list=await r.handlers.intel_aoi_list({}) as any;expect(JSON.stringify(list)).toContain('Test');}finally{r?.close();rmSync(dir,{recursive:true,force:true});}});
 it('rejects symlink roots and preexisting database symlinks',()=>{const dir=mkdtempSync(join(realpathSync(tmpdir()),'intel-links-'));try{symlinkSync(dir,join(dir,'link'));expect(()=>explicitDataDirectory(join(dir,'link','nested'))).toThrow('symlinks');symlinkSync(join(dir,'target'),join(dir,'aois.sqlite'));expect(()=>createConfiguredRuntime(dir)).toThrow('symlink');}finally{rmSync(dir,{recursive:true,force:true});}});
});
