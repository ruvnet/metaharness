// SPDX-License-Identifier: MIT
// Local-only BGE tokenizer + ONNX WASM inference; never downloads model weights.
import {createHash} from 'node:crypto';
import {statSync,readFileSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {UPSTREAM_EMBEDDING_MODEL,type EmbeddingProvider} from './vector-store.js';
export interface LocalEmbeddingRuntime {
 tokenize(text:string):Promise<Record<string,{data:ArrayLike<number|bigint>;dims:number[]}>>;
 run(inputs:Record<string,{data:ArrayLike<number|bigint>;dims:number[]}>):Promise<{data:ArrayLike<number>;dims:number[]}>;
 dispose?():Promise<void>;
}
export interface LocalEmbeddingOptions {runtimeFactory?:(directory:string)=>Promise<LocalEmbeddingRuntime>}
export const BGE_ASSET_MANIFESTS=[
 {repository:'BAAI/bge-small-en-v1.5',revision:'5c38ec7c405ec4b44b94cc5a9bb96e735b38267a',hashes:{'config.json':'094f8e891b932f2000c92cfc663bac4c62069f5d8af5b5278c4306aef3084750','tokenizer.json':'d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66','tokenizer_config.json':'9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3','onnx/model.onnx':'828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35'}},
 {repository:'Qdrant/bge-small-en-v1.5-onnx-Q',revision:'aa8f8b060edb00e03bfdd08813a2949946c8ba55',hashes:{'config.json':'13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd','tokenizer.json':'d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66','tokenizer_config.json':'0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53','onnx/model.onnx':'51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431'}}
] as const;
async function loadRuntime(directory:string):Promise<LocalEmbeddingRuntime>{
 // Dynamic package names keep the runtime genuinely optional for other tools.
 const transformersName='@huggingface/transformers',ortName='onnxruntime-web';
 const hf=await import(transformersName),ort=await import(ortName);
 hf.env.allowRemoteModels=false;hf.env.allowLocalModels=true;hf.env.useFSCache=false;
 const require=createRequire(import.meta.url),ortEntry=require.resolve(ortName);
 const wasmDir=resolve(ortEntry,'..');
 ort.env.wasm.wasmPaths=pathToFileURL(wasmDir+sep).href;ort.env.wasm.numThreads=1;ort.env.wasm.proxy=false;
 const tokenizer=await hf.AutoTokenizer.from_pretrained(directory,{local_files_only:true});
 const session=await ort.InferenceSession.create(new Uint8Array(readFileSync(join(directory,'onnx/model.onnx'))),{executionProviders:['wasm'],graphOptimizationLevel:'all'});
 return {async tokenize(text){return tokenizer(text,{padding:true,truncation:true,max_length:512});},async run(inputs){const feeds:Record<string,unknown>={};for(const name of session.inputNames){const input=inputs[name];if(!input)throw new Error(`BGE model input missing: ${name}`);feeds[name]=new ort.Tensor('int64',BigInt64Array.from(input.data as ArrayLike<bigint>,v=>BigInt(v)),input.dims);}const outputs=await session.run(feeds),output=outputs.last_hidden_state??outputs[session.outputNames[0]];return output;},async dispose(){await session.release();}};
}
export async function createLocalBgeEmbedding(modelDirectory:string,options:LocalEmbeddingOptions={}):Promise<EmbeddingProvider&{dispose():Promise<void>}>{
 if(!modelDirectory||/^https?:/i.test(modelDirectory))throw new Error('A local BGE model directory is required; downloads are disabled');
 const directory=resolve(modelDirectory);
 for(const file of ['config.json','tokenizer.json','tokenizer_config.json','onnx/model.onnx']){try{if(!statSync(join(directory,file)).isFile())throw new Error('not a file');}catch{throw new Error(`Missing local BGE asset: ${file}; no automatic downloads`);}}
 const config=JSON.parse(readFileSync(join(directory,'config.json'),'utf8'));
 if(config.model_type!=='bert'||config.hidden_size!==384)throw new Error('Expected BGE-small BERT with hidden_size=384');
 const hashes=Object.fromEntries(['config.json','tokenizer.json','tokenizer_config.json','onnx/model.onnx'].map(file=>[file,createHash('sha256').update(readFileSync(join(directory,file))).digest('hex')]));
 const manifest=BGE_ASSET_MANIFESTS.find(m=>Object.entries(m.hashes).every(([file,hash])=>hashes[file]===hash));
 if(!manifest&&!options.runtimeFactory)throw new Error('Unrecognized BGE model/tokenizer hashes; provide one of the pinned official asset manifests');
 const identity=manifest?UPSTREAM_EMBEDDING_MODEL+'@'+manifest.repository+':'+manifest.revision:'fixture-unverified-bge';
 const runtime=await (options.runtimeFactory??loadRuntime)(directory);
 return {model:identity,dimensions:384,async embed(text){const truncated=Array.from(text).slice(0,2000).join('');const output=await runtime.run(await runtime.tokenize(truncated));if(output.dims.length!==3||output.dims[0]!==1||output.dims[2]!==384||output.data.length<384)throw new Error('Unexpected BGE hidden-state shape; expected [1,tokens,384]');const vector=Array.from(output.data).slice(0,384);if(vector.some(v=>!Number.isFinite(v)))throw new Error('BGE emitted non-finite values');const norm=Math.sqrt(vector.reduce((sum,v)=>sum+v*v,0));if(norm===0)throw new Error('BGE emitted zero vector');return vector.map(v=>v/norm);},async dispose(){await runtime.dispose?.();}};
}
