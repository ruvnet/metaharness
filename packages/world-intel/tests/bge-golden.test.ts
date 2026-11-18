// Opt-in local-assets integration test. Never downloads model assets.
import {describe,it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {createLocalBgeEmbedding} from '../src/local-embedding.js';
const directory=process.env.WORLD_INTEL_BGE_ASSET_DIR;
const golden=JSON.parse(readFileSync(new URL('./fixtures/bge-fastembed-golden.json',import.meta.url),'utf8'));
describe.skipIf(!directory)('pinned FastEmbed0.7.0 Qdrant BGE golden comparison',()=>{
 it('matches token IDs exactly and normalized vectors within measured WASM tolerance',async()=>{const name='@huggingface/transformers';const hf=await import(name);hf.env.allowRemoteModels=false;hf.env.useFSCache=false;const tokenizer=await hf.AutoTokenizer.from_pretrained(directory!,{local_files_only:true});const provider=await createLocalBgeEmbedding(directory!);try{expect(provider.model).toContain(golden.revision);const actual:number[][]=[];
 for(const row of golden.rows){const input=await tokenizer(Array.from(row.text as string).slice(0,2000).join(''),{padding:true,truncation:true,max_length:512});for(const key of ['input_ids','attention_mask','token_type_ids'])expect(Array.from(input[key].data,Number)).toEqual(row[key]);const vector=Array.from(await provider.embed(row.text));actual.push(vector);expect(Math.max(...vector.map((v,i)=>Math.abs(v-row.vector[i])))).toBeLessThan(.0003);expect(vector.reduce((s,v,i)=>s+v*row.vector[i],0)).toBeGreaterThan(.999999);}
 // Rankings of all six corpus texts against every fixture query must agree.
 const rank=(query:number[],corpus:number[][])=>corpus.map((v,i)=>({i,score:v.reduce((s,x,k)=>s+x*query[k],0)})).sort((a,b)=>b.score-a.score).map(x=>x.i);
 for(let i=0;i<actual.length;i++)expect(rank(actual[i],actual)).toEqual(rank(golden.rows[i].vector,golden.rows.map((r:any)=>r.vector)));
 }finally{await provider.dispose();}},60000);
});
