import {SaxesParser} from 'saxes';
import {type SourceRuntime, type SourceRule} from '../source-runtime.js';
// SPDX-License-Identifier: MIT
// Native port of pinned World Intel public technology sources. Upstream MIT notice retained.
import type {DomainHandlers} from '../domain-runtime.js';
export interface TechTransport {json(url:URL):Promise<unknown>;text(url:URL):Promise<string>}
const paths:Record<string,RegExp>={'hacker-news.firebaseio.com':/^\/v0\/(topstories|item\/[0-9]+)\.json$/,'api.github.com':/^\/search\/repositories$/,'export.arxiv.org':/^\/api\/query$/,'api.usaspending.gov':/^\/api\/v2\/agency\/list\/$/};
export function createTechTransport(fetcher:typeof fetch=fetch,sourceRuntime?:SourceRuntime):TechTransport {
 const cache=new Map<string,{at:number;value:string}>();
 async function text(url:URL):Promise<string>{
  if(url.protocol!=='https:'||url.port||url.hash||url.username||url.password||!paths[url.hostname]?.test(url.pathname)) throw new Error('Unapproved public source');
  if(sourceRuntime){const value=await sourceRuntime.getText(url,{source:TECH_NAMES[url.hostname]!,cacheTtl:300,maxBytes:2_000_000,timeoutSeconds:20,followRedirects:false});if(value===null)throw Error('Technology provider unavailable');return value;}
  const key=url.href, old=cache.get(key);if(old&&Date.now()-old.at<300000)return old.value;
  const response=await fetcher(url,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(20000),headers:{Accept:'application/json, application/atom+xml','User-Agent':'metaharness-world-intel/0.2.0'}});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new Error('Empty body');
  let size=0;const parts:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2000000){await reader.cancel();throw new Error('Response too large');}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let pos=0;for(const p of parts){bytes.set(p,pos);pos+=p.length;}
  const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(cache.size>=200)cache.delete(cache.keys().next().value!);cache.set(key,{at:Date.now(),value});return value;
 }
 return {text,json:async url=>JSON.parse(await text(url))};
}
const row=(x:unknown):Record<string,any>=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,any>:{};
const integer=(x:unknown,d:number,max=50)=>{if(x===undefined)return d;if(typeof x!=='number'||!Number.isInteger(x)||x<0)throw new Error('Invalid limit');return Math.min(x,max);};
const iso=(now:()=>Date)=>now().toISOString().replace('Z','+00:00');
/** Corrects upstream regex attribute-order/entity/namespace bugs. Bounded, non-resolving SAX. */
export function parseArxiv(xml:string):Record<string,unknown>[] {
 if(Buffer.byteLength(xml,'utf8')>2_000_000)throw new Error('arXiv XML exceeds byte limit');
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('XML declarations not allowed');
 type Node={name:string;uri:string;text:string;attributes:Record<string,string>;children:Node[]};
 const roots:Node[]=[],stack:Node[]=[];let count=0;
 const parser=new SaxesParser({xmlns:true});
 parser.on('doctype',()=>{throw new Error('XML declarations not allowed');});
 parser.on('error',error=>{throw error;});
 parser.on('opentag',tag=>{
  if(stack.length>=32||++count>50000)throw new Error('arXiv XML complexity limit exceeded');
  const node:Node={name:tag.local,uri:tag.uri,text:'',attributes:Object.fromEntries(Object.values(tag.attributes).filter(a=>!a.uri).map(a=>[a.local,a.value])),children:[]};
  if(stack.length)stack.at(-1)!.children.push(node);else roots.push(node);stack.push(node);
 });
 const text=(value:string)=>{if(stack.length)stack.at(-1)!.text+=value;};
 parser.on('text',text);parser.on('cdata',text);parser.on('closetag',()=>{stack.pop();});parser.write(xml).close();
 const atom=(n:Node)=>!n.uri||n.uri==='http://www.w3.org/2005/Atom';
 const entries=roots.flatMap(n=>n.name==='entry'&&atom(n)?[n]:n.name==='feed'&&atom(n)?n.children.filter(c=>c.name==='entry'&&atom(c)):[]);
 return entries.map(e=>{
  const children=(name:string)=>e.children.filter(n=>n.name===name&&atom(n));
  const get=(name:string)=>children(name)[0]?.text;
  const normalize=(value:string)=>value.trim().replace(/\s+/g,' ');
  let summary=normalize(get('summary')??'');if(Array.from(summary).length>300)summary=Array.from(summary).slice(0,300).join('')+'...';
  const url=get('id')??'';
  return {id:url.includes('/abs/')?url.split('/abs/').at(-1):url,title:normalize(get('title')??''),summary,authors:children('author').flatMap(n=>n.children.filter(c=>c.name==='name'&&atom(c)).map(c=>c.text)).slice(0,5),categories:children('category').filter(n=>n.attributes.term!==undefined).map(n=>n.attributes.term).slice(0,5),published:get('published')??null,updated:get('updated')??null,pdf_url:children('link').find(n=>n.attributes.title==='pdf'&&n.attributes.href!==undefined)?.attributes.href??null,url};
 });
}
export function createTechHandlers(options:{sourceRuntime?:SourceRuntime;transport?:TechTransport;now?:()=>Date}={}):DomainHandlers{
 const transport=options.transport??createTechTransport(fetch,options.sourceRuntime),now=options.now??(()=>new Date());
 const failure=(source:string,key:string,error:unknown,extra={})=>({[key]:[],count:0,source,timestamp:iso(now),...extra,error:error instanceof Error?error.message:String(error),degraded:true});
 return {
  intel_hacker_news:async args=>{
   const limit=integer(args.limit,30);try{
    const ids=await transport.json(new URL('https://hacker-news.firebaseio.com/v0/topstories.json'));if(!Array.isArray(ids))throw new Error('Invalid top stories');
    const stories:Record<string,any>[]=[];
    for(let offset=0;offset<Math.min(ids.length,limit);offset+=5){const results=await Promise.all(ids.slice(offset,Math.min(offset+5,limit)).map(async id=>{if(!Number.isSafeInteger(id)||id<0)return null;try{const item=row(await transport.json(new URL(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));if(!Object.keys(item).length)return null;return {id:item.id??null,title:item.title??'',url:item.url??'',score:item.score??0,by:item.by??'',descendants:item.descendants??0,time:item.time??null,type:item.type??'story'};}catch{return null;}}));stories.push(...results.filter(x=>x!==null));}
    stories.sort((a,b)=>b.score-a.score);return {stories,count:stories.length,source:'hackernews',timestamp:iso(now)};
   }catch(e){return failure('hackernews','stories',e);}
  },
  intel_trending_repos:async args=>{
   const limit=integer(args.limit,25),days=integer(args.since_days,7,3650);const since=new Date(now().getTime()-days*86400000).toISOString().slice(0,10);
   let query=`created:>${since} stars:>10`;if(args.language)query+=` language:${String(args.language)}`;
   const url=new URL('https://api.github.com/search/repositories');url.search=new URLSearchParams({q:query,sort:'stars',order:'desc',per_page:String(limit)}).toString();
   try{const data=row(await transport.json(url));if(!Array.isArray(data.items))throw new Error('Invalid repository response');const repos=data.items.slice(0,limit).map((item:any)=>({name:item.full_name??null,description:(item.description??'').slice(0,200),url:item.html_url??null,stars:item.stargazers_count??0,forks:item.forks_count??0,language:item.language??null,created_at:item.created_at??null,topics:(item.topics??[]).slice(0,5)}));return {repos,count:repos.length,total_matching:data.total_count??0,query,source:'github',timestamp:iso(now)};}catch(e){return failure('github','repos',e);}
  },
  intel_arxiv_papers:async args=>{const limit=integer(args.limit,25),query=String(args.query||'cat:cs.AI OR cat:cs.LG OR cat:cs.CL');const url=new URL('https://export.arxiv.org/api/query');url.search=new URLSearchParams({search_query:query,sortBy:'submittedDate',sortOrder:'descending',max_results:String(limit)}).toString();try{const papers=parseArxiv(await transport.text(url)).slice(0,limit);return {papers,count:papers.length,query,source:'arxiv',timestamp:iso(now)};}catch(e){return failure('arxiv','papers',e);}},
  intel_usa_spending:async args=>{const limit=integer(args.limit,25,1000),date=now(),fiscal_year=date.getUTCMonth()>=9?date.getUTCFullYear():date.getUTCFullYear()-1;const url=new URL('https://api.usaspending.gov/api/v2/agency/list/?sort=obligated_amount&order=desc');try{const data=row(await transport.json(url));if(!Array.isArray(data.results))throw new Error('Invalid agency response');const agencies=data.results.filter((x:any)=>!args.agency||String(x.agency_name??'').toLowerCase().includes(String(args.agency).toLowerCase())).slice(0,limit).map((x:any)=>({name:x.agency_name??'',abbreviation:x.abbreviation??'',obligated_amount:x.obligated_amount??null,budget_authority:x.budget_authority_amount??null,percentage_of_total:x.percentage_of_total_budget_authority??null}));return {agencies,count:agencies.length,total_obligated:agencies.reduce((n:number,a:any)=>n+(a.obligated_amount||0),0),fiscal_year,source:'usaspending',timestamp:iso(now)};}catch(e){return failure('usaspending','agencies',e,{fiscal_year});}},
 };
}

const TECH_NAMES:Record<string,string>={'hacker-news.firebaseio.com':'hackernews','api.github.com':'github','export.arxiv.org':'arxiv','api.usaspending.gov':'usaspending'};
export function techSourceRules():Record<string,SourceRule>{return Object.fromEntries(Object.entries(paths).map(([host,path])=>[TECH_NAMES[host]!,{origins:['https://'+host],path}]));}
