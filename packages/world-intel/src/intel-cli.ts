// SPDX-License-Identifier: MIT
// Declarative CLI parity adapter from pinned upstream click signatures. No eval or network at import.
import {readFileSync} from 'node:fs';
import {runDomainTool} from './domain-runtime.js';
import type {DomainHandlers} from './domain-runtime.js';
import {MUTATING_TOOLS} from './execution-policy.js';
type Obj=Record<string,any>;
export interface IntelParameter{name:string;aliases:string[];positional:boolean;type:'string'|'integer'|'float'|'boolean';default:any;required:boolean;multiple:boolean;nargs:number;choices:string[]|null;caseSensitive:boolean;callback:string|null}
export interface IntelCommand{path:string[];legacyPaths?:string[][];function:string;description:string;target:string;parameters:IntelParameter[];mapping:Record<string,string>}
export const INTEL_COMMANDS:readonly IntelCommand[]=JSON.parse(readFileSync(new URL('../data/cli-commands.json',import.meta.url),'utf8')).commands;
export interface ParsedIntelCommand{command:IntelCommand;values:Obj;args:Obj;jsonOutput:boolean;help:boolean}
export class IntelUsageError extends Error{readonly exitCode=2;}
const globals=new Set(['--json-output']);
function converted(raw:string,p:IntelParameter):any{
 let value:any=raw;const numericText=raw.trim(),digits='[0-9](?:_?[0-9])*';
 if(p.type==='integer'){if(!new RegExp('^[+-]?'+digits+'$').test(numericText))throw new IntelUsageError(`${p.name}: '${raw}' is not a valid integer`);value=Number(numericText.replaceAll('_',''));if(!Number.isSafeInteger(value))throw new IntelUsageError(p.name+': integer out of range');}
 if(p.type==='float'){if(!new RegExp('^[+-]?(?:'+digits+'(?:\\.(?:'+digits+')?)?|\\.'+digits+')(?:e[+-]?'+digits+')?$','i').test(numericText))throw new IntelUsageError(`${p.name}: '${raw}' is not a valid number`);value=Number(numericText.replaceAll('_',''));if(!Number.isFinite(value))throw new IntelUsageError(p.name+': number out of range');}
 if(p.choices){const found=p.choices.find(c=>p.caseSensitive?c===value:c.toLowerCase()===String(value).toLowerCase());if(found===undefined)throw new IntelUsageError(`${p.name}: choose from ${p.choices.join(', ')}`);value=found;}
 return value;
}
function transformed(command:IntelCommand,values:Obj):Obj{
 const args:Obj={};
 for(const [target,expression]of Object.entries(command.mapping)){
  if(expression==='sym_list')args[target]=values.symbols?.length?values.symbols:null;
  else if(expression==='list(offsets) or None')args[target]=values.offsets?.length?values.offsets:null;
  else if(expression==='not no_countries')args[target]=!values.no_countries;
  else if(Object.hasOwn(values,expression))args[target]=values[expression];
  else throw Error('Unsupported generated CLI mapping: '+expression);
 }
 if(!Object.keys(command.mapping).length)Object.assign(args,values);
 if(command.function==='news_reaction'&&values.max_age_hours!=null)args.max_age_hours=values.max_age_hours;
 if(command.function==='report'){delete args.fmt;delete args.output;args.format=values.fmt;args.sections=values.sections?String(values.sections).split(',').map(s=>s.trim()):null;}
 if(command.function==='history_series')args.limit=values.limit||(values.series_key?100:200);
 if(command.function==='history_day'){args.per_source_limit=values.per_source;delete args.per_source;}
 if(command.function==='backfill_fred_cmd'){args.provider='fred';args.series=values.series_ids;delete args.series_ids;}
 if(command.function==='backfill_ecb_cmd'){args.provider='ecb';args.series=values.keys;delete args.keys;}
 // Missing optional CLI arguments must remain omitted so handler defaults apply.
 return Object.fromEntries(Object.entries(args).filter(([,v])=>v!==null&&v!==undefined));
}
export function parseIntelCommand(argv:readonly string[]):ParsedIntelCommand{
 if(argv.length>2048||argv.some(v=>v.length>16000))throw new IntelUsageError('Command line exceeds size limit');
 let jsonOutput=false;const tokens=[...argv];while(tokens.length&&globals.has(tokens[0])){jsonOutput=true;tokens.shift();}
 const command=[...INTEL_COMMANDS].sort((a,b)=>b.path.length-a.path.length).find(c=>[c.path,...c.legacyPaths??[]].some(path=>path.every((part,i)=>tokens[i]===part)));
 if(!command)throw new IntelUsageError('Unknown command. Use --help to list available commands.');
 const matching=[command.path,...command.legacyPaths??[]].find(path=>path.every((part,i)=>tokens[i]===part))!,rest=tokens.slice(matching.length);
 const values:Obj=Object.create(null),seen=new Set<string>(),positional:string[]=[],aliases=new Map(command.parameters.flatMap(p=>p.aliases.map(a=>[a,p]as const)));
 for(const p of command.parameters)values[p.name]=p.multiple||p.nargs===-1?[]:structuredClone(p.default);
 let endOptions=false,help=false;
 for(let i=0;i<rest.length;i++){
  const token=rest[i];if(!endOptions&&token==='--'){endOptions=true;continue;}
  if(!endOptions&&token==='--help'){help=true;continue;}
  if(!endOptions&&token.startsWith('-')&&!/^-\d/.test(token)){
   const eq=token.indexOf('=');let name=eq<0?token:token.slice(0,eq),p=aliases.get(name),attached:string|undefined;
   if(!p&&token.startsWith('-')&&!token.startsWith('--')&&token.length>2){name=token.slice(0,2);p=aliases.get(name);if(p&&p.type!=='boolean')attached=token.slice(2);}
   if(!p)throw new IntelUsageError('No such option: '+name);
   if(p.type==='boolean'){if(eq>=0)throw new IntelUsageError('Flag does not accept a value: '+name);values[p.name]=true;seen.add(p.name);continue;}
   const raw=attached??(eq<0?rest[++i]:token.slice(eq+1));if(raw===undefined)throw new IntelUsageError('Option requires an argument: '+name);
   const value=converted(raw,p);if(p.multiple)values[p.name].push(value);else values[p.name]=value;seen.add(p.name);
  }else positional.push(token);
 }
 let at=0;for(const p of command.parameters.filter(p=>p.positional)){
  if(p.nargs===-1){values[p.name]=positional.slice(at).map(s=>converted(s,p));at=positional.length;if(values[p.name].length)seen.add(p.name);}
  else if(at<positional.length){values[p.name]=converted(positional[at++],p);seen.add(p.name);}
 }
 if(!help){
  if(at<positional.length)throw new IntelUsageError('Unexpected extra argument: '+positional[at]);
  for(const p of command.parameters){if(p.required&&!seen.has(p.name))throw new IntelUsageError('Missing '+(p.positional?'argument ':'option ')+p.name);
   if(p.callback==='_parse_latlon_pairs')values[p.name]=values[p.name].map((s:string)=>{const parts=s.split(',');if(parts.length!==2||parts.some(n=>!n.trim()||!Number.isFinite(Number(n))))throw new IntelUsageError('Expected LAT,LON for '+p.name);const [lat,lon]=parts.map(Number);if(lat< -90||lat>90||lon< -180||lon>180)throw new IntelUsageError('Coordinates out of range');return [lat,lon];});}
 }
 return {command,values,args:help?{}:transformed(command,values),jsonOutput,help};
}
export function intelHelp(command?:IntelCommand):string{
 if(!command)return 'Usage: intel-ts [--data-dir DIRECTORY] [--allow-writes] [--json-output] COMMAND\n\n'+INTEL_COMMANDS.map(c=>c.path.join(' ')+'  '+c.description.split('\n')[0]).join('\n')+'\n';
 return 'Usage: intel-ts '+command.path.join(' ')+' [OPTIONS] '+command.parameters.filter(p=>p.positional).map(p=>p.required?p.name.toUpperCase():'['+p.name.toUpperCase()+']').join(' ')+'\n'+command.description+'\n'+command.parameters.filter(p=>!p.positional).map(p=>p.aliases.join(', ')+(p.type==='boolean'?'':' VALUE')+(p.default!=null?' (default: '+p.default+')':'')).join('\n')+'\n';
}
export interface IntelCliRunner{
 handlers:DomainHandlers;allowWrites?:boolean;onGovernance?:(value:{accepted:boolean;receiptsValid:boolean;receipts:unknown})=>void;
 status?:()=>Promise<unknown>|unknown;
 guide?:(measures:boolean)=>Promise<unknown>|unknown;
 sync?:(source?:string)=>Promise<unknown>|unknown;
 dashboard?:(args:Obj)=>Promise<unknown>|unknown;
 report?:(args:Obj,output?:string)=>Promise<unknown>|unknown;
}
export async function executeIntelCommand(parsed:ParsedIntelCommand,runner:IntelCliRunner):Promise<unknown>{
 const {command,args,values}=parsed;if(parsed.help)return {help:intelHelp(command)};
 if((MUTATING_TOOLS.has(command.target)||command.target==='$sync')&&!runner.allowWrites)throw new IntelUsageError('This command requires explicit --allow-writes');
 let invoke:()=>Promise<unknown>|unknown;
 if(command.target.startsWith('$')){
  const key=command.target.slice(1) as 'status'|'guide'|'sync'|'dashboard';if(!runner[key])throw new Error('CLI capability is not configured: '+key);
  invoke=command.target==='$status'?()=>runner.status!():command.target==='$guide'?()=>runner.guide!(Boolean(values.measures)):command.target==='$sync'?()=>runner.sync!(values.source):()=>runner.dashboard!(args);
 }else if(command.target==='intel_generate_report'&&runner.report)invoke=()=>runner.report!(args,values.output??undefined);
 else {
  if(command.target==='intel_generate_report'&&values.output)throw new IntelUsageError('Custom output path requires an explicit report writer');
  const handler=runner.handlers[command.target];if(!handler)throw new Error('Native handler not configured: '+command.target);invoke=()=>handler(args);
 }
 const run=await runDomainTool(command.target,args,invoke,true,Boolean(runner.allowWrites));
 runner.onGovernance?.({accepted:run.success,receiptsValid:run.receiptsValid,receipts:run.receipts});
 return run.steps[0]?.output.output??{error:'Command did not produce output'};
}
