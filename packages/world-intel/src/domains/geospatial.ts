/** Port of world-intel-mcp fdebf9a, MIT (Marc Shade). Static snapshot, not live intelligence. */
import { readFileSync } from 'node:fs';
type Row = Record<string, unknown>;
export type GeospatialArgs = Record<string, string | number | null | undefined>;
const load = (name: string): Row[] => JSON.parse(readFileSync(new URL(`../../data/geospatial/${name}.json`, import.meta.url), 'utf8')) as Row[];
export const geospatialTools = load('tools');
const datasetNames = ['military_bases','strategic_ports','pipelines','nuclear_facilities','undersea_cables','ai_datacenters','spaceports','critical_minerals','stock_exchanges','trade_routes','cloud_regions','financial_centers'] as const;
const data = Object.fromEntries(datasetNames.map(name => [name, load(name)]));
const lower = (x: unknown): string => String(x ?? '').toLowerCase();
const text = (a: GeospatialArgs, key: string) => lower(a[key]);
const includes = (r: Row, key: string, v: string) => lower(r[key]).includes(v);
const exactCountry = (r: Row, v: string) => lower(r.country) === v || lower(r.iso3) === v;
const substringCountry = (r: Row, v: string) => includes(r, 'country', v) || lower(r.iso3) === v;
const anyString = (value: unknown, v: string) => (value as unknown[]).some(x => lower(x).includes(v));
const countBy = (rows: Row[], field: string): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const r of rows) { const k = String(r[field]); result[k] = (result[k] ?? 0) + 1; }
  return result;
};
const sum = (rows: Row[], field: string) => rows.reduce((n, r) => n + Number(r[field] ?? 0), 0);
// Python round's ties-to-even behavior for these aggregate quantities.
const round = (value: number, digits: number) => { const scale = 10 ** digits, n = value * scale, f = Math.floor(n); return (n - f === .5 ? f + f % 2 : Math.round(n)) / scale; };
const specs: Record<string, { output: string; filters: string[]; groups: string[]; match: (r: Row, a: GeospatialArgs) => boolean; totals?: (rows: Row[]) => Row }> = {
  military_bases: { output:'bases', filters:['operator','country','base_type','branch'], groups:['operator','type'], match:(r,a) => (!a.operator || lower(r.operator) === text(a,'operator')) && (!a.country || substringCountry(r,text(a,'country'))) && (!a.base_type || includes(r,'type',text(a,'base_type'))) && (!a.branch || includes(r,'branch',text(a,'branch'))) },
  strategic_ports: { output:'ports', filters:['port_type','country'], groups:['type'], match:(r,a) => (!a.port_type || includes(r,'type',text(a,'port_type'))) && (!a.country || substringCountry(r,text(a,'country'))) },
  pipelines: { output:'pipelines', filters:['pipeline_type','status'], groups:['type','status'], match:(r,a) => (!a.pipeline_type || includes(r,'type',text(a,'pipeline_type'))) && (!a.status || includes(r,'status',text(a,'status'))) },
  nuclear_facilities: { output:'facilities', filters:['facility_type','country','status'], groups:['type','status'], match:(r,a) => (!a.facility_type || includes(r,'type',text(a,'facility_type'))) && (!a.country || substringCountry(r,text(a,'country'))) && (!a.status || includes(r,'status',text(a,'status'))), totals:r=>({total_capacity_mw:sum(r,'capacity_mw')}) },
  undersea_cables: { output:'cables', filters:['status','country','owner','min_capacity_tbps'], groups:['status'], match:(r,a) => (!a.status || r.status === text(a,'status')) && (!a.min_capacity_tbps || Number(r.capacity_tbps) >= Number(a.min_capacity_tbps)) && (!a.owner || anyString(r.owners,text(a,'owner'))) && (!a.country || (r.landing_points as Row[]).some(p=>includes(p,'country',text(a,'country')))), totals:r=>({total_length_km:sum(r,'length_km'),total_capacity_tbps:sum(r,'capacity_tbps')}) },
  ai_datacenters: { output:'datacenters', filters:['country','operator','min_power_mw','region'], groups:['country'], match:(r,a) => (!a.country || exactCountry(r,text(a,'country'))) && (!a.operator || anyString(r.operators,text(a,'operator'))) && (!a.min_power_mw || Number(r.power_mw)>=Number(a.min_power_mw)) && (!a.region || includes(r,'region',text(a,'region'))), totals:r=>({total_power_mw:sum(r,'power_mw')}) },
  spaceports: { output:'spaceports', filters:['country','status','spaceport_type','operator'], groups:['country','type'], match:(r,a) => (!a.country || exactCountry(r,text(a,'country'))) && (!a.status || r.status === text(a,'status')) && (!a.spaceport_type || r.type === text(a,'spaceport_type')) && (!a.operator || includes(r,'operator',text(a,'operator'))) },
  critical_minerals: { output:'deposits', filters:['mineral','country','mineral_type','operator'], groups:['mineral','country'], match:(r,a) => (!a.mineral || r.mineral === text(a,'mineral')) && (!a.country || exactCountry(r,text(a,'country'))) && (!a.mineral_type || r.type === text(a,'mineral_type')) && (!a.operator || includes(r,'operator',text(a,'operator'))) },
  stock_exchanges: { output:'exchanges', filters:['tier','country','currency'], groups:['tier'], match:(r,a) => (!a.tier || r.tier === text(a,'tier')) && (!a.country || exactCountry(r,text(a,'country'))) && (!a.currency || lower(r.currency) === text(a,'currency')), totals:r=>({total_market_cap_usd_t:round(sum(r,'market_cap_usd_t'),2)}) },
  trade_routes: { output:'routes', filters:['route_type','country'], groups:['type'], match:(r,a) => (!a.route_type || r.type === text(a,'route_type')) && (!a.country || (r.countries as string[] ?? []).includes(String(a.country).toUpperCase())), totals:r=>({total_oil_flow_mbd:round(sum(r,'oil_flow_mbd'),1)}) },
  cloud_regions: { output:'regions', filters:['provider','country'], groups:['provider'], match:(r,a) => (!a.provider || lower(r.provider) === text(a,'provider')) && (!a.country || includes(r,'name',text(a,'country'))) },
  financial_centers: { output:'centers', filters:['country','min_rank'], groups:['iso3'], match:(r,a) => (!a.country || r.iso3 === String(a.country).toUpperCase()) && (a.min_rank == null || Number(r.gfci_rank)<=Number(a.min_rank)) },
};
/** Valid input parity: unknown fields ignored as upstream, missing filter values emitted as null. */
export function queryGeospatial(name: string, args: GeospatialArgs = {}, now: () => Date = () => new Date()): Row {
  const key = name.replace(/^intel_/, '');
  const spec = specs[key];
  if (!spec) throw new Error(`Unknown static geospatial tool: ${name}`);
  const rows = structuredClone(data[key]!.filter(r=>spec.match(r,args)));
  const groups = Object.fromEntries(spec.groups.map(g=>[`by_${g === 'iso3' ? 'country' : g}`,countBy(rows,g)]));
  return { [spec.output]:rows,count:rows.length,total_in_database:data[key]!.length,...groups,...spec.totals?.(rows),filters:Object.fromEntries(spec.filters.map(k=>[k,args[k]??null])),source:'static-geospatial',timestamp:now().toISOString().replace('Z','+00:00') };
}
export const geospatialHandlers: Record<string,(args: Record<string, unknown>)=>Promise<unknown>> = Object.fromEntries(datasetNames.map(name=>[`intel_${name}`,async (args: Record<string, unknown>={}) => {
  const definition = geospatialTools.find(t=>t.name === `intel_${name}`)!;
  const properties = (definition.inputSchema as {properties:Record<string,{type:string}>}).properties;
  for (const [key, rule] of Object.entries(properties)) {
    const value=args[key];
    if(value == null) continue;
    if(rule.type === 'string' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isInteger(value))) throw new TypeError(`Invalid ${key}`);
  }
  return queryGeospatial(`intel_${name}`,args as GeospatialArgs);
}]));
