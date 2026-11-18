// SPDX-License-Identifier: MIT
// Ported from marc-shade/world-intel-mcp guide.py and guide_prompts.py at
// fdebf9a8de6e00ed688053dd647cafedc179708b. Copyright (c) 2025-2026 Phoenix AGI.
// See THIRD_PARTY_NOTICES.md. No Python execution or dependency at runtime.
import { readFileSync } from 'node:fs';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

type Arg = {name:string;description:string;required:boolean;default:string|null;absent:string|null;choices:string[];kind:'text'|'int'|'number';minimum:number|null;maximum:number|null};
type Fill = {what:string};
export type PromptStep = {tool:string;purpose:string;args:[string, unknown][];only_if:string|null};
export type ResearchPrompt = {name:string;title:string;domain:string;question:string;steps:PromptStep[];limits:string[];arguments:Arg[];derived:[string,string,number][]};
export type GuideTool = {name:string;description?:string;inputSchema?:{properties?:Record<string,unknown>;required?:string[]}};
export type GuideDomain = {key:string;title?:string;summary?:string;tools:readonly GuideTool[]};
type KeyedSource = {source:string;env:string[];without_key:string;needed_by:string[]};
type Resource = {uri:string;name:string;title:string;description:string;mimeType:string};
interface Catalog {source:{repository:string;commit:string;license:string;copyright:string};prompts:ResearchPrompt[];commonLimits:string[];answerShape:string;guideIntro:string;measures:string;keyedSources:KeyedSource[];resources:Resource[];domainTitles:Record<string,string>;healthScope:string[];serverInstructions:string;casefold:Record<string,string>}
const catalog: Catalog = JSON.parse(readFileSync(new URL('../data/upstream-prompts.json', import.meta.url), 'utf8'));
export const PROMPTS: readonly ResearchPrompt[] = catalog.prompts;
export const SERVER_INSTRUCTIONS = catalog.serverInstructions;
export const GUIDE_URI = 'intel://guide';
export const HEALTH_URI = 'intel://guide/source-health';
export const MEASURES_URI = 'intel://guide/measures';
const PLACEHOLDER = /\{([a-z_]+)\}/g;
const numberText = (n:number|null):string => {
  if(n===null)return 'None';if(Number.isInteger(n))return String(Object.is(n,-0)?0:n);
  const text=Math.abs(n)<1e-4?n.toExponential():String(n);
  return text.replace(/e([+-])([0-9])$/, 'e$10$2');
};
const promptTools = (p:ResearchPrompt):string[] => p.steps.map(s=>s.tool);
const description = (p:ResearchPrompt):string => `${p.title}. Uses ${[...new Set(promptTools(p))].join(', ')}.`;
function argHelp(a:Arg):string {
  const parts=[a.description];
  if(a.minimum!==null && a.maximum!==null) parts.push(`${numberText(a.minimum)} to ${numberText(a.maximum)}`);
  if(a.default!==null)parts.push(`default ${a.default}`);
  return parts.join('; ');
}
function invalid(message:string):never {throw new McpError(ErrorCode.InvalidParams,message);}
function clean(raw:string):string {
  // Python str.isspace includes U+001C..001F; preserve those as spaces too.
  return [...raw].filter(c=>/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(c)||!/[\p{Cc}\p{Cf}]/u.test(c)).join('').split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean).join(' ');
}
function guardNames(value:string):string[] {
  const folded=[...value.normalize('NFKC')].map(c=>catalog.casefold[c]??c.toLowerCase()).join('').replaceAll('-','_').replace(/\p{Cf}/gu,'');
  return folded.match(/intel_[a-z0-9_]+/g)??[];
}
function resolve(p:ResearchPrompt,given:Record<string,string>={}):Record<string,string|number|null> {
  const known=p.arguments.map(a=>a.name);
  const unknown=Object.keys(given).filter(n=>!known.includes(n)).sort();
  if(unknown.length)invalid(`Prompt '${p.name}' does not take ${unknown.join(', ')} (accepted: ${[...known].sort().join(', ')||'none'})`);
  const values:Record<string,string|number|null>=Object.create(null);
  for(const a of p.arguments){
    const raw=given[a.name];
    if(raw!==undefined && typeof raw!=='string')invalid(`Prompt '${p.name}' argument '${a.name}' must be a string`);
    let value=raw===undefined?'':clean(raw);
    if([...value].length>200)invalid(`Prompt '${p.name}' argument '${a.name}' is longer than 200 characters`);
    if(!value){
      if(a.required)invalid(`Prompt '${p.name}' needs argument '${a.name}': ${a.description}`);
      if(a.default===null){values[a.name]=null;continue;}
      value=a.default;
    }
    const foreign=[...new Set(guardNames(value))].filter(n=>!promptTools(p).includes(n)).sort();
    if(foreign.length)invalid(`Prompt '${p.name}' argument '${a.name}' names ${foreign.join(', ')}, which this prompt does not call`);
    if(a.choices.length && !a.choices.includes(value))invalid(`Prompt '${p.name}' argument '${a.name}' must be one of ${a.choices.join(', ')} (got '${value}')`);
    if(a.kind==='text'){values[a.name]=value;continue;}
    const numeric=a.kind==='int'?/^[+-]?[0-9]+$/:/^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
    const n=numeric.test(value)?Number(value):NaN;
    if(!Number.isFinite(n))invalid(`Prompt '${p.name}' argument '${a.name}' must be ${a.kind==='int'?'a whole number':'a number'} (got '${value}')`);
    if((a.minimum!==null&&n<a.minimum)||(a.maximum!==null&&n>a.maximum))invalid(`Prompt '${p.name}' argument '${a.name}' must be between ${numberText(a.minimum)} and ${numberText(a.maximum)} (got '${value}')`);
    values[a.name]=n;
  }
  for(const [name,source,factor] of p.derived)values[name]=Number(values[source])*factor;
  return values;
}
function stepArgs(step:PromptStep,values:Record<string,string|number|null>):Record<string,unknown>|null {
  if(step.only_if!==null && values[step.only_if]==null)return null;
  const out:Record<string,unknown>={};
  for(const [param,raw]of step.args){const match=typeof raw==='string'?/^\{([a-z_]+)\}$/.exec(raw):null;const value=match?values[match[1]]:raw;if(value!=null)out[param]=value;}
  return out;
}
export function resolvedSteps(p:ResearchPrompt,args:Record<string,string>={}):[PromptStep,Record<string,unknown>|null][] {
  const values=resolve(p,args);return p.steps.map(s=>[s,stepArgs(s,values)]);
}
function show(value:unknown,inCall=false):string {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'what'in value)return `<${(value as Fill).what}>`;
  if(typeof value==='boolean')return value?'true':'false';
  if(typeof value==='number')return numberText(value);
  if(Array.isArray(value))return `[${value.map(v=>JSON.stringify(v)).join(', ')}]`;
  const text=String(value);return (inCall?/[,;"<>\s]/:/[,;"<>]/).test(text)?JSON.stringify(text):text;
}
export function renderPrompt(p:ResearchPrompt,args:Record<string,string>={}):string {
  const values=resolve(p,args);const absent=Object.fromEntries(p.arguments.map(a=>[a.name,a.absent||'not given']));
  const prose=Object.fromEntries(Object.entries(values).map(([k,v])=>[k,v===null?absent[k]:show(v)]));
  const fill=(s:string)=>s.replace(PLACEHOLDER,(whole,key:string)=>prose[key]??whole);
  const lines=[`Research question: ${fill(p.question)}`,'','Tools to call:'];
  p.steps.forEach((step,index)=>{
    const params=stepArgs(step,values);
    if(params===null){lines.push(`${index+1}. ${step.tool}: skip this call; no ${step.only_if} was given.`);return;}
    const pairs=Object.entries(params).map(([k,v])=>`${k} ${show(v,true)}`).join(', ');
    lines.push(`${index+1}. ${step.tool}: ${pairs?`call with ${pairs}; `:''}${fill(step.purpose)}`);
  });
  lines.push('','Limits to respect:',...p.limits.map(l=>`- ${fill(l)}`),...catalog.commonLimits.map(l=>`- ${l}`),'',catalog.answerShape);
  return lines.join('\n');
}
export function listPrompts(){return PROMPTS.map(p=>({name:p.name,title:p.title,description:description(p),arguments:p.arguments.map(a=>({name:a.name,description:argHelp(a),required:a.required}))}));}
export function getPrompt(name:string,args:Record<string,string>={}){
  const p=PROMPTS.find(p=>p.name===name);if(!p)invalid(`Unknown prompt '${name}'; available: ${PROMPTS.map(p=>p.name).join(', ')}`);
  return {description:description(p),messages:[{role:'user' as const,content:{type:'text' as const,text:renderPrompt(p,args)}}]};
}
function firstSentence(text:string):string {
  const re=/(?<=[.!?])\s+(?=[A-Z(])/g;for(const match of text.matchAll(re)){const prior=text.slice(0,match.index);if(!/(?:\b(?:[A-Za-z]\.){2,}|\b(?:etc|vs|approx|Inc|No|St)\.)$/.test(prior))return prior;}return text;
}
export function toolLine(tool:GuideTool):string {
  const schema=tool.inputSchema??{};const args=Object.keys(schema.properties??{}).map(n=>(schema.required??[]).includes(n)?`${n} (required)`:n).join(', ');
  const keys=catalog.keyedSources.find(s=>s.needed_by.includes(tool.name))?.env;
  return `- \`${tool.name}\`${args?` [${args}]`:''}: ${firstSentence((tool.description??'').trim().split(/\s+/u).join(' ')).replaceAll(' — ',' - ').replaceAll('—','-')}${keys?` [needs ${keys.join(', ')}]`:''}`;
}
export function renderGuide(domains:readonly GuideDomain[], options:{implementedTools?:ReadonlySet<string>}={}):string {
  const count=domains.reduce((n,d)=>n+d.tools.length,0);
  const intro=catalog.guideIntro.replace('{tools}',String(count)).replace('{domains}',String(domains.length)).replace('{prompts}',String(PROMPTS.length));
  const parts=[intro,'## Worked research prompts\n','Each prompt names the tools to call, the arguments to pass and the limits to respect. Fetch one with prompts/get.\n'];
  for(const p of PROMPTS){const args=p.arguments.map(a=>a.required?`${a.name} (required)`:a.name).join(', ');parts.push(`- \`${p.name}\`${args?` [${args}]`:''}: ${p.title}.`);}
  parts.push('\n## Tools by domain\n');
  for(const d of domains){parts.push(`### ${d.title??catalog.domainTitles[d.key]??d.key.replaceAll('_',' ')} (${d.tools.length})\n`);if(d.summary)parts.push(`${d.summary}\n`);parts.push(...d.tools.map(toolLine),'');}
  if(options.implementedTools){const missing=[...new Set(PROMPTS.flatMap(p=>promptTools(p)))].filter(t=>!options.implementedTools!.has(t));if(missing.length)parts.push('## TypeScript implementation gaps\n','Prompt templates are ported research instructions, not evidence of working providers. These referenced tools are not implemented in this runtime: '+missing.map(t=>`\`${t}\``).join(', ')+'.\n');}
  return parts.join('\n').trimEnd()+'\n';
}
export function listResources():Resource[]{return catalog.resources.map(r=>({...r}));}
export interface HealthState {breakers:Record<string,{failures?:number;status:string;total_stale_serves?:number;[key:string]:unknown}>;cache:{available:boolean;fell_back:boolean;total_entries?:number;moved?:boolean;[key:string]:unknown};freshness:Record<string,{is_stale?:boolean;[key:string]:unknown}>|null;environ?:Record<string,string|undefined>;now?:Date;scope?:string[]}
export function sourceHealth(state:HealthState){
  const {breakers,cache,freshness}=state;const env=state.environ??{};
  const names=Object.keys(breakers);const failing=names.filter(n=>(breakers[n].failures??0)>0||breakers[n].status!=='closed').sort();
  const open=names.filter(n=>breakers[n].status!=='closed').sort();const stale=names.filter(n=>Boolean(breakers[n].total_stale_serves));
  let verdict:string;
  if(!names.length&&!cache.total_entries)verdict=`no information yet: this process has made no requests since it started and the cache ${cache.available?'is empty':'could not be read'}, so nothing here shows whether any source works`;
  else if(!names.length)verdict='cache only: this process has made no requests since it started; cache_freshness shows what any process sharing the cache fetched last';
  else verdict=`${names.length} ${names.length===1?'source':'sources'} called by this process, ${failing.length} whose last call failed, ${open.length} with an open or half-open circuit breaker${stale.length?`; ${stale.length} served a stale cached copy`:''}`;
  if(cache.fell_back)verdict+='; the configured cache could not be opened, so this process uses a temporary cache of its own';
  if(cache.moved)verdict+='; the cache file at db_path was moved or replaced while this process held it open, so its cache numbers come from a file no other process shares';
  return {generated_at:(state.now??new Date()).toISOString().replace(/\.000Z$/,'+00:00'),verdict,scope:state.scope??catalog.healthScope,failing_sources:failing,open_breakers:open,stale_serves:Object.fromEntries(stale.sort().map(n=>[n,breakers[n].total_stale_serves])),stale_cache_prefixes:freshness===null?null:Object.keys(freshness).filter(k=>freshness[k].is_stale).sort(),circuit_breakers:breakers,cache,cache_freshness:freshness,keyed_sources:catalog.keyedSources.map(s=>({source:s.source,env:s.env,configured:s.env.filter(n=>Boolean(env[n])),missing:s.env.filter(n=>!env[n]),without_key:s.without_key}))};
}
export interface ResourceContext {domains:readonly GuideDomain[];implementedTools?:ReadonlySet<string>;healthSnapshot?:()=>unknown}
/** Health is provided by the runtime, never fetched by reading a resource. */
export function readResource(uri:string,context:ResourceContext){
  if(uri===GUIDE_URI)return {contents:[{uri,mimeType:'text/markdown',text:renderGuide(context.domains,{implementedTools:context.implementedTools})}]};
  if(uri===MEASURES_URI)return {contents:[{uri,mimeType:'text/markdown',text:catalog.measures}]};
  if(uri===HEALTH_URI){const health=context.healthSnapshot?.()??sourceHealth({breakers:{},cache:{available:false,fell_back:false},freshness:null,scope:['TypeScript runtime health state was not supplied. No provider, cache or collector health is inferred. Reading this resource starts no fetches.']});return {contents:[{uri,mimeType:'application/json',text:JSON.stringify(health,null,2)}]};}
  invalid(`Unknown resource ${uri}; available: ${catalog.resources.map(r=>r.uri).join(', ')}`);
}
