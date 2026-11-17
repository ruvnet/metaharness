import {it,expect,vi} from 'vitest';
import {INTEL_COMMANDS,parseIntelCommand,executeIntelCommand,intelHelp,IntelUsageError} from '../src/intel-cli.js';
import {readFileSync} from 'node:fs';
const known=new Set(JSON.parse(readFileSync(new URL('../data/upstream-tools.json',import.meta.url),'utf8')).tools.map((t:any)=>t.name));
function invocation(command:typeof INTEL_COMMANDS[number]){
 const argv=[...command.path];
 for(const p of command.parameters){if(!p.required)continue;const value=p.choices?.[0]??(p.type==='integer'||p.type==='float'?'1':'sample');
  if(p.positional)argv.push(String(value));else argv.push(p.aliases[0],String(value));}
 return argv;
}
it('exactly87 executable commands map to actual handlers or explicit system capabilities',()=>{
 expect(INTEL_COMMANDS).toHaveLength(87);expect(new Set(INTEL_COMMANDS.map(c=>c.path.join(' '))).size).toBe(87);
 for(const c of INTEL_COMMANDS)expect(known.has(c.target)||['$status','$guide','$sync','$dashboard'].includes(c.target)).toBe(true);
});
for(const command of INTEL_COMMANDS)it('dispatches pinned command '+command.path.join(' ')+' through valid governance',async()=>{
 const parsed=parseIntelCommand(invocation(command)),fn=vi.fn(async(args)=>({ok:true,args})),onGovernance=vi.fn(),runner={handlers:{[command.target]:fn},allowWrites:true,onGovernance,status:()=>({status:'ok'}),guide:()=>({text:'guide'}),sync:()=>({evicted:0}),dashboard:()=>({started:true}),report:fn};
 const result:any=await executeIntelCommand(parsed,runner);expect(result.error).toBeUndefined();expect(onGovernance).toHaveBeenCalledWith(expect.objectContaining({accepted:true,receiptsValid:true}));
 if(!command.target.startsWith('$'))expect(fn).toHaveBeenCalledWith(parsed.args,...(command.function==='report'?[undefined]:[]));
});
it('preserves aliases, positional names, default values, repeated options and boolean inversions',()=>{
 expect(parseIntelCommand(['markets','-s','AAPL','--symbols','MSFT']).args).toEqual({symbols:['AAPL','MSFT']});
 expect(parseIntelCommand(['earthquakes','-m','5','-h','48']).args).toEqual({min_magnitude:5,hours:48});
 expect(parseIntelCommand(['news-reaction','--no-countries','--min-size','3','--max-age-hours','12']).args).toEqual({limit:150,min_cluster_size:3,include_countries:false,max_age_hours:12});
 expect(parseIntelCommand(['history','day','2026-11-17','--per-source','3']).args).toEqual({day:'2026-11-17',by:'collected',per_source_limit:3});
 expect(parseIntelCommand(['prediction-settled','--offset','2','--offset','4']).args.offsets_hours).toEqual([2,4]);
 expect(parseIntelCommand(['fed-liquidity','walcl']).args.series_id).toBe('WALCL');
});
it('converts repeated AOI coordinates, variadic history keys and backfill provider arguments',()=>{
 expect(parseIntelCommand(['aoi','define-polygon','area','--vertex','1,2','--vertex','3,4','--vertex','5,6']).args).toEqual({name:'area',vertices:[[1,2],[3,4],[5,6]]});
 expect(parseIntelCommand(['history','connections','a:x','b:y']).args).toMatchObject({series_keys:['a:x','b:y'],grid:'day',transform:'changes',max_lag:5});
 expect(parseIntelCommand(['history','backfill','fred','WALCL','M2SL','--start','2020-01-01']).args).toEqual({provider:'fred',series:['WALCL','M2SL'],start:'2020-01-01'});
});
it('rejects missing args, unknown options, malformed coordinates and nonfinite numbers without dispatch',()=>{
 for(const a of [['fred'],['markets','--wat'],['earthquakes','--hours','nan'],['aoi','define-polygon','a','--vertex','91,0'],['history','connections']])expect(()=>parseIntelCommand(a)).toThrow(IntelUsageError);
 expect(parseIntelCommand(['fred','--help']).help).toBe(true);expect(intelHelp()).toContain('history backfill ecb');
});
it('write capabilities are denied before handler execution and provider failures retain receipts',async()=>{
 const fn=vi.fn(async()=>({error:'provider unavailable'})),onGovernance=vi.fn();
 await expect(executeIntelCommand(parseIntelCommand(['aoi','delete','area']),{handlers:{intel_aoi_delete:fn}})).rejects.toThrow('--allow-writes');expect(fn).not.toHaveBeenCalled();
 expect(await executeIntelCommand(parseIntelCommand(['markets']),{handlers:{intel_market_quotes:fn},onGovernance})).toEqual({error:'provider unavailable'});
 expect(onGovernance).toHaveBeenCalledWith(expect.objectContaining({accepted:false,receiptsValid:true}));
});
it('importable standalone CLI help/errors do not start network or data stores',async()=>{
 const {runIntelCliMain}=await import('../src/intel-cli-main.js'),out=vi.fn(),err=vi.fn();
 expect(await runIntelCliMain(['--help'],{out,err})).toBe(0);expect(out.mock.calls[0][0]).toContain('Usage: intel-ts');expect(err).not.toHaveBeenCalled();
 expect(await runIntelCliMain(['aoi','define'],{out,err})).toBe(2);
});
