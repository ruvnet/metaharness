import {it,expect,vi,afterEach} from 'vitest';
import {createDashboard,DASHBOARD_ROUTES,DASHBOARD_SOURCES,dashboardStatic,dashboardConflictFallback,dashboardSources,placeDashboardCorridors} from '../src/dashboard.js';
import {createDashboardHttpServer,validateDashboardListen} from '../src/dashboard-http.js';
import {parseDashboardArgs} from '../src/dashboard-cli.js';
const now=()=>Date.parse('2026-11-17T00:00:00Z'),request=(path:string,init?:RequestInit)=>new Request('http://localhost'+path,init),base={handlers:{},now};
afterEach(()=>vi.useRealTimers());
it('retains pinned route and stream source inventory',()=>{expect(DASHBOARD_ROUTES).toHaveLength(15);expect(new Set(DASHBOARD_ROUTES.map(r=>r.path)).size).toBe(14);expect(DASHBOARD_SOURCES).toHaveLength(47);});
it('all source adapters resolve actual upstream tool aliases',async()=>{const names:string[]=[];const handlers=new Proxy({},{get:(_,name)=>async()=>{names.push(String(name));return{};}});for(const f of Object.values(dashboardSources(handlers)))await f(new AbortController().signal);expect(names).toContain('intel_ai_releases');expect(names).toContain('intel_aviation_domestic');expect(names).toContain('intel_displacement_summary');});
it('health/static/UI and removed PDF routes preserve status, schema and route semantics',async()=>{
 const d=createDashboard(base);expect(await (await d.handle(request('/api/health'))).json()).toEqual({status:'ok'});
 const pdf=await d.handle(request('/api/report/pdf'));expect(pdf.status).toBe(410);expect(await pdf.json()).toEqual({error:'PDF reports removed — use the live dashboard at /'});
 const s=await d.handle(request('/api/static'));expect(s.headers.get('Access-Control-Allow-Origin')).toBe('*');const data=await s.json();expect(data.military_bases.count).toBe(data.military_bases.bases.length);expect(Object.keys(data)).toHaveLength(9);
 expect((await (await d.handle(request('/'))).text())).toContain('/api/stream');
 expect((await d.handle(request('/unknown'))).status).toBe(404);expect((await d.handle(request('/api/health',{method:'POST'}))).status).toBe(405);
});
it('static conflict fallback clears on either recovered event feed',()=>{const fallback=dashboardConflictFallback({error:'down'},{count:0},now)!;expect(fallback.count).toBeGreaterThan(0);expect(fallback.events[0].event_date).toBe('2026-11-17');expect(dashboardConflictFallback({count:1},null,now)).toBeNull();expect(dashboardConflictFallback(null,{count:1},now)).toBeNull();});
it('SSE tick emits completion-order progress plus conflict clearing and shared health',async()=>{
 let release!:(v:any)=>void;const slow=new Promise(r=>release=r),d=createDashboard({...base,sources:{acled_events:()=>slow,ucdp_events:()=>({count:1})},health:()=>({breakers:{a:1},cache:{total:2},freshness:{x:3}})}),iterator=d.streamTick(new AbortController().signal);
 expect((await iterator.next()).value).toMatchObject({_progressive:true,_done:1,_total:2,ucdp_events:{count:1}});
 release({error:'offline'});expect((await iterator.next()).value).toMatchObject({_done:2,acled_events:{error:'offline'}});
 expect((await iterator.next()).value.conflict_zones).toBeNull();expect((await iterator.next()).value).toMatchObject({_complete:true,_progressive:false,source_health:{a:1},cache_stats:{total:2}});expect((await iterator.next()).done).toBe(true);
});
it('source timeout remains an outage and not an empty domain',async()=>{
 vi.useFakeTimers();const d=createDashboard({...base,sourceTimeoutMs:10,sources:{earthquakes:()=>new Promise(()=>{})}}),it=d.streamTick(new AbortController().signal),p=it.next();await vi.advanceTimersByTimeAsync(11);
 expect((await p).value.earthquakes).toEqual({error:'timeout after 0.01s',_timeout:true});await it.return(undefined);
});
it('SSE response headers/framing and consumer cancellation close cleanly',async()=>{
 const d=createDashboard({...base,sources:{market_quotes:()=>({count:1})},streamIntervalMs:100000}),r=await d.handle(request('/api/stream'));expect(r.headers.get('Content-Type')).toBe('text/event-stream');expect(r.headers.get('X-Accel-Buffering')).toBe('no');
 const reader=r.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^data: .*\n\n$/);await reader.cancel();
});
it('overview attaches static layers, conflict fallback, computed brief and metadata',async()=>{const d=createDashboard({...base,sources:{earthquakes:()=>({count:0})}}),r=await (await d.handle(request('/api/overview'))).json();expect(r.conflict_zones.source).toBe('intel-hotspots');expect(r.situation_brief.source).toBe('situation-brief');expect(r.cache_stats).toEqual({});});
it('research query bounds reject malformed values before provider calls',async()=>{
 const fn=vi.fn(async()=>({})),d=createDashboard({...base,handlers:{intel_situations:fn,intel_top_stories:fn}});
 for(const p of ['/api/situations?hours=NaN','/api/situations?limit=1.2','/api/situations?kind=invalid','/api/top-stories?min_outlets=51'])expect((await d.handle(request(p))).status).toBe(400);expect(fn).not.toHaveBeenCalled();
 await d.handle(request('/api/situations?hours=48&limit=3'));expect(fn).toHaveBeenLastCalledWith({hours:48,sort:'covered',kind:'all',limit:3,min_articles:2});
});
it('research errors preserve provider payload and same-origin-only CORS',async()=>{const d=createDashboard({...base,handlers:{intel_liquidity_board:async()=>({error:'no observations',data_gaps:['x']})}}),r=await d.handle(request('/api/liquidity-board'));expect(r.status).toBe(503);expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();expect(await r.json()).toMatchObject({error:'no observations',data_gaps:['x'],net_liquidity_method:{components:{WALCL:{units:'USD millions'}}}});});
it('research deadline is distinguished from provider TimeoutError',async()=>{
 vi.useFakeTimers();const d=createDashboard({...base,researchTimeoutMs:10,handlers:{intel_top_stories:async()=>new Promise(()=>{})}}),p=d.handle(request('/api/top-stories'));await vi.advanceTimersByTimeAsync(11);expect((await p).status).toBe(504);
 const failed=createDashboard({...base,handlers:{intel_top_stories:async()=>{const e=new Error('inner');e.name='TimeoutError';throw e;}}});const r=await failed.handle(request('/api/top-stories'));expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'top stories failed: TimeoutError: inner'});
});
it('AOI snapshots show absent sweep as null and failed stores as503',async()=>{
 const d=createDashboard({...base,aoiStore:{list:()=>[{name:'a'},{name:'b'}],getSnapshot:n=>n==='a'?null:{taken_at:123,domains:{earthquakes:{one:{},two:{}},military_flights:{}}}}});const r=await (await d.handle(request('/api/aois'))).json();expect(r.aois[0].last_sweep).toBeNull();expect(r.aois[1].last_sweep).toEqual({taken_at:123,counts:{earthquakes:2,military_flights:0},total:2});
 expect((await createDashboard(base).handle(request('/api/aois'))).status).toBe(503);
});
const corridor={origin:'A',origin_iso3:'AAA',destination:'B',destination_iso3:'BBB',people:10},wb={AAA:{latitude:1,longitude:2,capital:'A'},BBB:{latitude:3,longitude:4,capital:'B'}};
it('migration anchors do not silently omit missing or aggregate endpoints',()=>{const [p,u]=placeDashboardCorridors([corridor],{...wb,BBB:{...wb.BBB,aggregate:true}});expect(p).toEqual([]);expect(u[0].no_coordinates).toEqual(['destination']);});
it('migration routes preserve primary/secondary outage distinction',async()=>{
 const handlers={intel_migration_flows:async()=>({year:2025,corridors:[corridor],corridor_count:1,prior_year_available:true,measure:'stock',timestamp:'now'}),intel_migration_surges:async()=>({error:'surges unavailable'})},d=createDashboard({...base,handlers,countryCoordinates:async()=>wb});
 const r=await d.handle(request('/api/migration?limit=1&year=2025'));expect(r.status).toBe(200);expect(await r.json()).toMatchObject({year:2025,plotted:1,rising:[],rising_error:'surges unavailable'});
 expect((await d.handle(request('/api/migration?limit=151'))).status).toBe(400);expect((await d.handle(request('/api/migration?year=no'))).status).toBe(400);
 expect((await createDashboard({...base,handlers}).handle(request('/api/migration'))).status).toBe(503);
});
it('collection health preserves unknown-source404 and unavailable503 without CORS',async()=>{
 const missing=createDashboard({...base,collectionHealth:()=>({error:'unknown source',known_sources:['a']})}),r=await missing.handle(request('/api/collection-health?source=x'));expect(r.status).toBe(404);expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
 const broken=createDashboard({...base,historyPath:'/approved/history.sqlite',collectionHealth:()=>{throw Error('broken');}}),b=await broken.handle(request('/api/collection-health'));expect(b.status).toBe(503);expect(await b.json()).toMatchObject({db_path:'/approved/history.sqlite'});
});
it('vector analytics and search distinguish absent vector backend and partial errors',async()=>{
 const no=createDashboard(base);expect((await no.vectorAnalytics()).available).toBe(false);expect((await no.handle(request('/api/vector-search',{method:'POST',body:'{}'}))).status).toBe(503);
 const semanticSearch=vi.fn(async()=>({results:[]})),d=createDashboard({...base,vector:{collectionStats:()=>({count:1}),domainSummary:()=>{throw Error('bad');},trendDetection:()=>({}),semanticSearch}});
 expect(await d.vectorAnalytics()).toMatchObject({available:true,domain_summary:{error:'bad'}});
 expect((await d.handle(request('/api/vector-search',{method:'POST',body:'bad'}))).status).toBe(400);
 expect((await d.handle(request('/api/vector-search',{method:'POST',body:'{"query":" test ","limit":99,"hours":24}'}))).status).toBe(200);
 expect(semanticSearch).toHaveBeenCalledWith('test',50,undefined,undefined,24);
 const cors=await d.handle(request('/api/vector-search',{method:'OPTIONS'}));expect(cors.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
});
it('HTTP construction never listens and remote binding needs explicit permission',()=>{
 const server=createDashboardHttpServer(base);expect(server.listening).toBe(false);server.close();
 expect(validateDashboardListen()).toMatchObject({host:'127.0.0.1',port:8501});expect(()=>validateDashboardListen({host:'0.0.0.0'})).toThrow('allowRemote');
 expect(parseDashboardArgs([],{PORT:'9000'})).toMatchObject({port:9000});expect(parseDashboardArgs(['--port','8000'],{WORLD_INTEL_DASHBOARD_PORT:'9000'})).toMatchObject({port:8000});
});
it('HTTP boundary denies foreign Origin and strips upstream wildcard CORS by default',async()=>{
 const {EventEmitter}=await import('node:events');
 async function run(origin?:string){
  const server=createDashboardHttpServer(base),req=Object.assign(new EventEmitter(),{headers:{host:'127.0.0.1:8501',...(origin?{origin}:{})},url:'/api/static',method:'GET',async *[Symbol.asyncIterator](){}}),res=Object.assign(new EventEmitter(),{headersSent:false,status:0,headers:{} as any,body:'',writeHead(status:number,headers:any={}){this.status=status;this.headers=headers;this.headersSent=true;},write(value:any){this.body+=Buffer.from(value).toString();return true;},end(value=''){this.body+=value;}});
  await (server.listeners('request')[0] as any)(req,res);server.close();return res;
 }
 const denied=await run('https://evil.test');expect(denied.status).toBe(403);
 const noOrigin=await run();expect(noOrigin.status).toBe(200);expect(noOrigin.headers['access-control-allow-origin']).toBeUndefined();expect(noOrigin.headers['Access-Control-Allow-Origin']).toBeUndefined();
 const same=await run('http://127.0.0.1:8501');expect(same.status).toBe(200);expect(same.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:8501');
 expect(()=>validateDashboardListen({allowOrigins:['*']})).toThrow();
});
it('HEAD dispatch never leaves a readable body or opens an SSE cycle',async()=>{const source=vi.fn(async()=>({})),d=createDashboard({...base,sources:{earthquakes:source}}),r=await d.handle(request('/api/stream',{method:'HEAD'}));expect(r.body).toBeNull();expect(source).not.toHaveBeenCalled();});
it('dashboard escaped provider titles and tooltip HTML sinks use strict sanitizer policy',async()=>{
 const {readFileSync}=await import('node:fs'),{runInNewContext}=await import('node:vm'),html=readFileSync(new URL('../data/dashboard/index.html',import.meta.url),'utf8');
 const escaping=html.slice(html.indexOf('function rEsc('),html.indexOf('function rLink(')),functions=html.slice(html.indexOf('var safe ='),html.indexOf('function fmtNum('));
 let policy:any;const seen:any[]=[],Layer=function(){};Layer.prototype.bindTooltip=function(v:any){seen.push(v);return this;};
 const ctx:any={L:{Layer},DOMPurify:{sanitize:(text:string,opts:any)=>{policy=opts;return text;}},URL};
 runInNewContext(escaping+functions+';this.escape=rEsc;this.href=rHref;this.safe=safe;',ctx);
 const malicious='<img src=x onerror="alert(1)"><script>alert(2)</script>';
 expect(ctx.escape(malicious)).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;');
 for(const bad of ['javascript:alert(1)','data:text/html,<script>x</script>','//evil.test/x'])expect(ctx.href(bad)).toBeNull();
 new (Layer as any)().bindTooltip(malicious);expect(seen).toHaveLength(1);
 expect(policy.ALLOWED_ATTR).not.toContain('onerror');expect(policy.ALLOWED_TAGS).not.toContain('script');expect(policy.ALLOWED_URI_REGEXP.test('javascript:alert(1)')).toBe(false);
 expect(html).not.toContain("function esc(s) { var d = document.createElement");
});
