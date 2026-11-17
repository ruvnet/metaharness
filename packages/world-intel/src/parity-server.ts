import {attachedSourceRuntime} from './source-runtime.js';
import {MUTATING_TOOLS} from './execution-policy.js';
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runDomainTool, type DomainHandlers } from './domain-runtime.js';
import { getPrompt, listPrompts, listResources, readResource, SERVER_INSTRUCTIONS } from './guide.js';
interface ToolDefinition {name:string;description:string;inputSchema:Schema;upstream:{module:string}}
type Schema = {type?:string|string[];properties?:Record<string,Schema>;items?:Schema;enum?:unknown[];required?:string[];minimum?:number;maximum?:number;additionalProperties?:boolean;minLength?:number;maxLength?:number;pattern?:string};
const snapshot=JSON.parse(readFileSync(new URL('../data/upstream-tools.json',import.meta.url),'utf8')) as {tools:ToolDefinition[];upstream:{commit:string}};
/** Bounded validation of the pinned upstream schemas. Unknown optional fields retain upstream semantics. */
function validate(schema:Schema,value:unknown,path='arguments',depth=0):void {
  if(depth>20) throw new Error('Arguments nesting too deep');
  if(schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum value`);
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  const actual=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type && !types.some(t=>t===actual || t==='integer'&&actual==='number'&&Number.isInteger(value))) throw new Error(`${path}: invalid type`);
  if(typeof value==='number' && (!Number.isFinite(value) || schema.minimum!==undefined&&value<schema.minimum || schema.maximum!==undefined&&value>schema.maximum)) throw new Error(`${path}: number outside bounds`);
  if(typeof value==='string' && (value.length>16000 || schema.minLength!==undefined&&value.length<schema.minLength || schema.maxLength!==undefined&&value.length>schema.maxLength || schema.pattern&&!new RegExp(schema.pattern).test(value))) throw new Error(`${path}: invalid string`);
  if(Array.isArray(value)) { if(value.length>1000) throw new Error(`${path}: too many items`); if(schema.items) value.forEach((v,i)=>validate(schema.items!,v,`${path}[${i}]`,depth+1)); }
  else if(value && typeof value==='object') {
    const object=value as Record<string,unknown>;
    for(const key of schema.required??[]) if(!Object.hasOwn(object,key)) throw new Error(`${path}.${key} is required`);
    for(const [key,v] of Object.entries(object)) {
      if(['__proto__','constructor','prototype'].includes(key)) throw new Error('Unsafe argument key');
      if(schema.properties?.[key]) validate(schema.properties[key],v,`${path}.${key}`,depth+1);
      else if(schema.additionalProperties===false) throw new Error(`Unknown argument ${key}`);
    }
  }
}
export interface ParityServerOptions {handlers:DomainHandlers;allowWrites?:boolean;healthSnapshot?:()=>unknown}
const WRITES=MUTATING_TOOLS;
export function createParityServer(options:ParityServerOptions):Server {
  const known=new Map(snapshot.tools.map(t=>[t.name,t]));
  for(const name of Object.keys(options.handlers)) if(!known.has(name)) throw new Error(`Handler not in pinned upstream: ${name}`);
  const implemented=new Set(Object.keys(options.handlers));
  const definitions=snapshot.tools.filter(t=>implemented.has(t.name)).map(({upstream,...tool})=>tool);
  const domains=[...new Set(snapshot.tools.map(t=>t.upstream.module))].map(key=>({key,title:key,tools:snapshot.tools.filter(t=>t.upstream.module===key).map(({upstream,...t})=>t)}));
  const server=new Server({name:'metaharness-world-intel',version:'0.2.0'},{capabilities:{tools:{},prompts:{},resources:{}},instructions:SERVER_INSTRUCTIONS+'\nThis TypeScript port is in progress. Only tools returned by tools/list are implemented. Do not infer upstream parity from the guide or prompt inventory.'});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:definitions}));
  server.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:listPrompts()}));
  server.setRequestHandler(GetPromptRequestSchema,async r=>getPrompt(r.params.name,r.params.arguments));
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:listResources()}));
  server.setRequestHandler(ReadResourceRequestSchema,async r=>readResource(r.params.uri,{domains,implementedTools:implemented,healthSnapshot:options.healthSnapshot??(attachedSourceRuntime(options.handlers)?()=>attachedSourceRuntime(options.handlers)!.health():undefined)}));
  server.setRequestHandler(CallToolRequestSchema,async r=>{
    try {
      const {name}=r.params;const handler=options.handlers[name];const def=known.get(name);
      if(!handler || !def) throw new Error(`Tool not implemented in this port: ${name}`);
      const args=r.params.arguments??{};
      if(JSON.stringify(args).length>64000) throw new Error('Arguments exceed 64 KB limit');
      validate(def.inputSchema,args);
      const run=await runDomainTool(name,args,handler,!WRITES.has(name)||options.allowWrites===true,options.allowWrites===true);
      const result=run.steps[0]?.output.output??{error:'Tool did not produce output'};
      return {isError:!run.success,content:[{type:'text' as const,text:JSON.stringify(result,null,2)}],_meta:{governance:{accepted:run.success,receiptsValid:run.receiptsValid,receipts:run.receipts},upstreamCommit:snapshot.upstream.commit}};
    } catch(error) {return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:error instanceof Error?error.message:'Call failed'})}]};}
  });
  return server;
}
