import {realpathSync} from 'node:fs';
import {it,expect} from 'vitest';
import {SQLiteAOIStorage} from '../src/domains/aoi-storage.js';
import {createAOIHandlers} from '../src/domains/aoi.js';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
it.skipIf(Number(process.versions.node.split('.')[0])<22||(Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])<13))('persists native SQLite AOIs, geometry and rename snapshot migration',()=>{const dir=mkdtempSync(join(realpathSync(tmpdir()),'world-aoi-')),path=join(dir,'aoi.db');try{let store=new SQLiteAOIStorage(path);let h=createAOIHandlers({store});h.intel_aoi_define_polygon({name:'Shape',vertices:[[0,0],[0,1],[1,1]]});store.putSnapshot('shape',{taken_at:100,domains:{news:{x:'Title'}}});h.intel_aoi_update({name:'Shape',new_name:'Renamed'});store.close();store=new SQLiteAOIStorage(path);h=createAOIHandlers({store});expect(store.get('shape')).toBeNull();expect(store.get('renamed')?.kind).toBe('polygon');expect(store.getSnapshot('renamed')?.domains.news.x).toBe('Title');h.intel_aoi_delete({name:'renamed'});expect(store.getSnapshot('renamed')).toBeNull();store.close()}finally{rmSync(dir,{recursive:true,force:true})}});
it('requires explicit storage path',()=>expect(()=>new SQLiteAOIStorage('')).toThrow('explicit'));
