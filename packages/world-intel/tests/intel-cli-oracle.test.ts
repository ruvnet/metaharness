import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {parseIntelCommand} from '../src/intel-cli.js';
const oracle=JSON.parse(readFileSync(new URL('./fixtures/cli-upstream-oracle.json',import.meta.url),'utf8'));
const clean=(o:Record<string,any>)=>Object.fromEntries(Object.entries(o).filter(([,v])=>v!==null&&v!==undefined));
for(const c of oracle.cases)it('actual upstream Click values: '+c.command.join(' ')+' / '+c.mode,()=>{
 expect(parseIntelCommand(c.argv).values).toEqual(c.clickValues);
});
for(const c of oracle.cases.filter((c:any)=>!['status','sync','guide','dashboard'].includes(c.command[0])))it('actual upstream function call: '+c.command.join(' ')+' / '+c.mode,()=>{
 const parsed=parseIntelCommand(c.argv),call=c.call,expected={...call.keywords},actual={...parsed.args};
 expect(call).not.toBeNull();
 if(call.name==='history.capture_history')expected.source=call.positional[0];
 if(call.name==='history.series_history'){
  expected.series_key=call.positional[0];
  actual.limit=actual.limit??(actual.series_key?100:200);
 }
 if(call.name==='lagged.lagged_connections')expected.series_keys=call.positional[1];
 if(call.name==='day_timeline'){
  expected.day=call.positional[1];delete expected.roster;delete expected.now;
  actual.limit??=100;actual.per_source_limit??=10;
 }
 if(call.name==='backfill'){expected.provider=call.positional[1];expected.series=call.positional[2];expected.start=call.positional[3];}
 if(call.name==='generate_report'){expected.format=expected.fmt;delete expected.fmt;delete expected.output_path;}
 expect(clean(actual)).toEqual(clean(expected));
});
for(const c of oracle.edges)it('upstream CLI edge: '+c.argv.join(' '),()=>{
 // Intentional frontend hardening: upstream parses finite coordinates, then validates range in its store handler.
 if(c.argv.includes('91,0')){expect(()=>parseIntelCommand(c.argv)).toThrow('Coordinates out of range');return;}
 if(!c.accepted){expect(()=>parseIntelCommand(c.argv)).toThrow();return;}
 const parsed=parseIntelCommand(c.argv);expect(parsed.values).toEqual(c.clickValues);
 if(c.call?.name==='history.series_history')expect(parsed.args.limit).toBe(c.call.keywords.limit);
});
