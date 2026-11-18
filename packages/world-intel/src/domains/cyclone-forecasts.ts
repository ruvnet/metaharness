/** Native port of world-intel-mcp cyclone forecast parsers (Marc Shade, MIT). */
import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
type R=Record<string,any>;
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const coord=(n:string,h:string)=>Number(n)*(['S','W'].includes(h)?-1:1);
const iso=(d:Date|null)=>d?d.toISOString().replace(/\.\d{3}Z$/,'Z'):null;
const LL='(\\d{1,2}(?:\\.\\d+)?)([NS])[ \\t]+(\\d{1,3}(?:\\.\\d+)?)([EW])';
const match=(s:string,re:RegExp)=>s.match(re);
function validDate(y:number,m:number,d:number,h=0,min=0):Date|null{const date=new Date(Date.UTC(y,m,d,h,min));return date.getUTCFullYear()===y&&date.getUTCMonth()===m&&date.getUTCDate()===d&&date.getUTCHours()===h&&date.getUTCMinutes()===min?date:null;}
export function resolveDayTime(day:number,hour:number,minute:number,anchor:Date|null):Date|null{
 if(!anchor)return null;let best:Date|null=null;for(const offset of [-1,0,1]){const month=new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth()+offset,1));const c=validDate(month.getUTCFullYear(),month.getUTCMonth(),day,hour,minute);if(c&&(!best||Math.abs(+c-+anchor)<Math.abs(+best-+anchor)))best=c;}return best;
}
const unescape=(s:string)=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&amp;/g,'&');
export function parseNhcForecast(page:string,fallback:Date|null=null):R{
 const pre=page.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i),text=(pre?unescape(pre[1]!):page).replace(/\r\n?/g,'\n');
 const stamp=match(text,/^[ \t]*(\d{1,2})(\d{2}) UTC [A-Z]{3} ([A-Z]{3}) (\d{1,2}) (\d{4})[ \t]*$/m);
 const issued=stamp?validDate(+stamp[5]!,MONTHS.indexOf(stamp[3]!),+stamp[4]!,+stamp[1]!,+stamp[2]!):null,anchor=issued??fallback;
 const when=(m:RegExpMatchArray,i:number)=>resolveDayTime(+m[i]!,+m[i+1]!,+m[i+2]!,anchor);
 const center=match(text,new RegExp('CENTER LOCATED NEAR[ \\t]+'+LL+'[ \\t]+AT[ \\t]+(\\d{2})/(\\d{2})(\\d{2})Z'));
 const sustained=match(text,/MAX SUSTAINED WINDS[ \t]+(\d+)[ \t]*KT WITH GUSTS TO[ \t]+(\d+)[ \t]*KT/),pressure=match(text,/MINIMUM CENTRAL PRESSURE[ \t]+(\d+)[ \t]*MB/);
 const initial=center?{valid_time:iso(when(center,5)),latitude:coord(center[1]!,center[2]!),longitude:coord(center[3]!,center[4]!),max_wind_kt:sustained?+sustained[1]!:null,gust_kt:sustained?+sustained[2]!:null,pressure_mb:pressure?+pressure[1]!:null}:null;
 const sm=match(text,/AT[ \t]+(\d{2})\/(\d{2})(\d{2})Z[ \t]+CENTER WAS LOCATED NEAR/),synoptic=sm?when(sm,1):null;
 const headers=[...text.matchAll(new RegExp('^[ \\t]*(FORECAST|OUTLOOK) VALID[ \\t]+(\\d{2})/(\\d{2})(\\d{2})Z(?:[ \\t]+'+LL+')?(?:[ \\t]*\\.\\.\\.[ \\t]*([^\\n]*\\S))?','gm'))];
 const points=headers.map((h,i)=>{const body=text.slice(h.index!+h[0].length,headers[i+1]?.index??text.length),wind=match(body,/MAX WIND[ \t]+(\d+)[ \t]*KT\.\.\.GUSTS[ \t]+(\d+)[ \t]*KT/),valid=when(h,2);return {tau_hours:synoptic&&valid?Math.round((+valid-+synoptic)/3600000):null,valid_time:iso(valid),latitude:h[5]?coord(h[5],h[6]!):null,longitude:h[7]?coord(h[7],h[8]!):null,max_wind_kt:wind?+wind[1]!:null,gust_kt:wind?+wind[2]!:null,status:h[9]??null,section:h[1]!.toLowerCase()};});
 return {advisory_number:match(text,/FORECAST\/ADVISORY NUMBER[ \t]+(\w+)/)?.[1]??null,issued:iso(issued),initial,points};
}
export function parseJtwcForecast(input:string,fallback:Date):R{
 const text=input.replace(/\r\n?/g,'\n'),dated=match(text,/^[ \t]*(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})\./m),anchor=dated?validDate(2000+(+dated[3]!),MONTHS.indexOf(dated[2]!),+dated[1]!)??fallback:fallback;
 const when=(m:RegExpMatchArray,i:number)=>resolveDayTime(+m[i]!,+m[i+1]!,+m[i+2]!,anchor);
 const header=match(text,/^[ \t]*WT[A-Z]{2}\d{2}[ \t]+[A-Z]{4}[ \t]+(\d{2})(\d{2})(\d{2})\b/m),number=match(text,/WARNING NR[ \t]+(\d+)/),position=match(text,new RegExp('WARNING POSITION:\\s*(\\d{2})(\\d{2})(\\d{2})Z\\s*-+\\s*NEAR\\s+'+LL));
 const present=match(text,/PRESENT WIND DISTRIBUTION:\s*MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT,\s*GUSTS\s+(\d+)\s*KT/),pressure=match(text,/MINIMUM CENTRAL PRESSURE AT\s+(\d{2})(\d{2})(\d{2})Z\s+IS\s+(\d+)\s+MB/);
 const initial=position?{valid_time:iso(when(position,1)),latitude:coord(position[4]!,position[5]!),longitude:coord(position[6]!,position[7]!),max_wind_kt:present?+present[1]!:null,gust_kt:present?+present[2]!:null,pressure_mb:pressure&&pressure.slice(1,4).join()===position.slice(1,4).join()?+pressure[4]!:null}:null;
 const sections=[...text.matchAll(/^[ \t]*(FORECASTS|EXTENDED OUTLOOK|LONG RANGE OUTLOOK|REMARKS):/gm)],remarks=sections.find(m=>m[1]==='REMARKS')?.index??text.length;
 const blocks=[...text.matchAll(new RegExp('(\\d+)\\s+HRS,\\s+VALID AT:\\s*(\\d{2})(\\d{2})(\\d{2})Z\\s*-+\\s*'+LL,'g'))].filter(b=>b.index!<remarks);
 const structural=/^(?:MAX SUSTAINED WINDS|WIND RADII VALID|RADIUS OF|\d{3} NM [A-Z]+ QUADRANT|VECTOR TO|-+$|(?:FORECASTS|EXTENDED OUTLOOK|LONG RANGE OUTLOOK|REMARKS):)/;
 const sectionNames:Record<string,string>={FORECASTS:'forecast','EXTENDED OUTLOOK':'extended_outlook','LONG RANGE OUTLOOK':'long_range_outlook'};
 const points=blocks.map((b,i)=>{const body=text.slice(b.index!+b[0].length,blocks[i+1]?.index??remarks),wind=match(body,/MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT,\s*GUSTS\s+(\d+)\s*KT/),status=body.split('\n').map(s=>s.trim()).filter(s=>s&&!structural.test(s)).join('; ')||null;let section:string|null=null;for(const s of sections)if(s.index!<b.index!&&sectionNames[s[1]!])section=sectionNames[s[1]!]!;return {tau_hours:+b[1]!,valid_time:iso(when(b,2)),latitude:coord(b[5]!,b[6]!),longitude:coord(b[7]!,b[8]!),max_wind_kt:wind?+wind[1]!:null,gust_kt:wind?+wind[2]!:null,status,section};});
 return {warning_number:number?+number[1]!:null,issued:header?iso(when(header,1)):null,initial,points};
}
function crc32(bytes:Uint8Array):number{let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function extractConeKml(bytes:Uint8Array):Uint8Array{
 if(bytes.length>2*1024*1024)throw Error('KMZ exceeds 2MiB cap');const b=Buffer.from(bytes);let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break;}if(end<0)throw Error('Invalid KMZ directory');
 if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6))throw Error('Multidisk ZIP refused');const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);if(count>1024||start+size>end)throw Error('Invalid ZIP bounds');
 let pos=start;for(let i=0;i<count;i++){if(pos+46>start+size||b.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid ZIP entry');const flags=b.readUInt16LE(pos+8),method=b.readUInt16LE(pos+10),crc=b.readUInt32LE(pos+16),compressed=b.readUInt32LE(pos+20),expanded=b.readUInt32LE(pos+24),nl=b.readUInt16LE(pos+28),el=b.readUInt16LE(pos+30),cl=b.readUInt16LE(pos+32),offset=b.readUInt32LE(pos+42);if(pos+46+nl+el+cl>start+size)throw Error('Truncated ZIP entry');const name=b.subarray(pos+46,pos+46+nl).toString('utf8');pos+=46+nl+el+cl;if(!name.toLowerCase().endsWith('.kml'))continue;
  if(flags&1||![0,8].includes(method)||expanded>8*1024*1024||expanded>100*Math.max(1,compressed))throw Error('Unsafe KML ZIP member');if(offset+30>b.length||b.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid local header');const payload=offset+30+b.readUInt16LE(offset+26)+b.readUInt16LE(offset+28);if(payload+compressed>start)throw Error('Invalid KML payload bounds');const source=b.subarray(payload,payload+compressed),out=method===0?source:inflateRawSync(source,{maxOutputLength:8*1024*1024});if(out.length!==expanded||crc32(out)!==crc)throw Error('KML size/CRC mismatch');return out;
 }throw Error('KMZ holds no .kml document');
}
type Point=[number,number];
function simplify(ring:Point[]):Point[]{const keep=new Set([0,ring.length-1]),stack:[[number,number]]|[number,number][]=[[0,ring.length-1]];let kept=1;while(stack.length){const [a,b]=stack.pop()!;let worst=-1,index=-1;for(let i=a+1;i<b;i++){const p=ring[i]!,v=ring[a]!,w=ring[b]!,dx=w[0]-v[0],dy=w[1]-v[1],length=dx*dx+dy*dy,t=length?Math.max(0,Math.min(1,((p[0]-v[0])*dx+(p[1]-v[1])*dy)/length)):0,d=Math.hypot(p[0]-v[0]-t*dx,p[1]-v[1]-t*dy);if(d>worst){worst=d;index=i;}}if(index>=0&&worst>.01){if(++kept>500)throw Error('Cone outline exceeds 500 vertices');keep.add(index);stack.push([a,index],[index,b]);}}return ring.filter((_,i)=>keep.has(i)).slice(0,-1);}
export function parseNhcCone(bytes:Uint8Array):R{
 const text=new TextDecoder('utf-8',{fatal:true}).decode(extractConeKml(bytes));if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Unsafe KML declarations');const root=new XMLParser({ignoreAttributes:false,removeNSPrefix:true,parseTagValue:false}).parse(text),rings:any[]=[],extended:Record<string,string>={};
 function walk(v:any):void{if(!v||typeof v!=='object')return;if(Array.isArray(v)){for(const x of v)walk(x);return;}for(const [key,item]of Object.entries(v)){if(key==='LinearRing')rings.push(...(Array.isArray(item)?item:[item]));if(key==='Data')for(const d of (Array.isArray(item)?item:[item]) as R[])if(d?.['@_name']&&d.value!=null)extended[d['@_name']]=String(d.value).trim();walk(item);}}walk(root);
 if(rings.length!==1)throw Error(`expected one cone ring, found ${rings.length} rings`);const tokens=String(rings[0].coordinates??'').trim().split(/\s+/);if(tokens.length>3001)throw Error('Cone exceeds 3000 vertices');const ring:Point[]=tokens.map(t=>{const p=t.split(',');const lon=Number(p[0]),lat=Number(p[1]);if(p.length<2||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90)throw Error('Invalid cone coordinate');return [lat,lon];});if(JSON.stringify(ring[0])===JSON.stringify(ring.at(-1)))ring.pop();if(ring.length<3)throw Error('Cone needs 3 vertices');const outline=simplify([...ring,ring[0]!]);if(outline.length<3)throw Error('Cone outline needs 3 vertices');
 return {vertices:outline,vertex_count:outline.length,source_vertex_count:ring.length,simplify_tolerance_deg:.01,advisory_number:extended.advisoryNum??null,forecast_period_hours:/^\d+$/.test(extended.fcstpd??'')?Number(extended.fcstpd):null,note:"Outline simplified from NHC's ring (Douglas-Peucker, 0.01 degree tolerance); not the official geometry, which is at cone_url. NHC's KML disclaimer calls the KML format experimental."};
}
export type ForecastTransport=(url:string,maxBytes:number)=>Promise<Uint8Array>;
export function createForecastTransport(fetchFn:typeof fetch=fetch):ForecastTransport{return async(url,maxBytes)=>{
 if(refused(url,'www.nhc.noaa.gov')&&refused(url,'www.metoc.navy.mil'))throw Error('Unapproved forecast origin');if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>2*1024*1024)throw Error('Invalid forecast size bound');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();void reader?.cancel().catch(()=>{});reject(Error('Forecast request timed out'));},15000);});
 try{return await Promise.race([deadline,(async()=>{
  const r=await fetchFn(url,{redirect:'error',credentials:'omit',signal:controller.signal,headers:{'User-Agent':'metaharness-world-intel (https://github.com/ruvnet/metaharness)'}});
  if(!r.ok){await r.body?.cancel();throw Error(`HTTP ${r.status}`);}if(Number(r.headers.get('content-length')??0)>maxBytes){await r.body?.cancel();throw Error('Product too large');}if(!r.body)throw Error('Missing product');reader=r.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('Product too large');parts.push(value);}}finally{await reader.cancel();}
  if(controller.signal.aborted)throw Error('Forecast request timed out');const result=new Uint8Array(size);let at=0;for(const p of parts){result.set(p,at);at+=p.length;}return result;
 })()]);}finally{if(timer)clearTimeout(timer);}
};}
function refused(url:unknown,host:string):string|null{if(typeof url!=='string')return 'link is not a string; not fetched';if(/[\s\x00-\x1f\x7f]/.test(url))return 'link contains whitespace or control characters; not fetched';try{const u=new URL(url);if(u.protocol!=='https:'||u.hostname!==host||u.port||u.username||u.password)return `link is not https on ${host}; not fetched`;}catch{return 'link is not a valid URL; not fetched';}return null;}
function standing(found:unknown,expected:unknown):string{if(found==null)return 'unreadable';const numeric=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)||typeof v==='string'&&/^\d+$/.test(v.trim());if(numeric(found)&&numeric(expected))return Number(found)===Number(expected)?'same':Number(found)>Number(expected)?'newer':'older';return String(found).trim().replace(/^0+/,'').toUpperCase()===String(expected).trim().replace(/^0+/,'').toUpperCase()?'same':'older';}
const issuanceCaches=new WeakMap<ForecastTransport,Map<string,{at:number;bytes:Uint8Array}>>();
const FAILED=new Set(['fetch_failed','unparsed','not_fetched_cap','stale_advisory','stale_warning','refused_link','error']);
export async function attachForecasts(agency:'NHC'|'JTWC',storms:R[],raw:R[],transport:ForecastTransport,now:Date):Promise<{data_gaps:string[];degraded?:true}>{
 let cache=issuanceCaches.get(transport);if(!cache){cache=new Map();issuanceCaches.set(transport,cache);}
 const cached=(key:string)=>{const hit=cache!.get(key);return hit&&+now-hit.at<3600000?hit.bytes:undefined;};
 const retain=(key:string,bytes:Uint8Array)=>{if(cache!.size>=128)cache!.delete(cache!.keys().next().value!);cache!.set(key,{at:+now,bytes:Uint8Array.from(bytes)});};
 for(let i=0;i<storms.length;i++){
  const storm=storms[i]!,src=raw[i]??storm,advisory=agency==='NHC'?(src.forecastAdvisory||{}):{},coneMeta=agency==='NHC'?(src.trackCone||{}):{},url=agency==='NHC'?advisory.url:storm.warning_text_url,expected=agency==='NHC'?advisory.advNum:storm.warning_number,field=agency==='NHC'?'advisory':'warning';
  if(i>=10){storm.forecast={agency,track_status:'not_fetched_cap',track_error:'not fetched: per-call cap of 10 storms',initial:null,points:[],cone_status:agency==='JTWC'?'not_published':'not_fetched_cap',cone:null};continue;}
  const out:R={agency,track_url:typeof url==='string'?url:null,track_status:'ok',[field+'_number']:null,['feed_'+field+'_number']:expected??null,issued:null,initial:null,points:[],cone_url:agency==='NHC'&&typeof coneMeta.kmzFile==='string'?coneMeta.kmzFile:null,cone_status:agency==='JTWC'?'not_published':'ok',cone:null};storm.forecast=out;
  if(agency==='NHC'&&(typeof advisory!=='object'||Array.isArray(advisory))){out.track_status='refused_link';out.track_error='CurrentStorms.json forecastAdvisory is not an object; nothing fetched';}
  else if(!url){out.track_status='not_linked';out.track_error=agency==='NHC'?'CurrentStorms.json links no forecast/advisory for this storm':'the JTWC RSS item links no warning text for this storm';}
  else{const deny=refused(url,agency==='NHC'?'www.nhc.noaa.gov':'www.metoc.navy.mil');if(deny){out.track_status='refused_link';out.track_error=(agency==='NHC'?'forecast/advisory ':'warning text ')+deny;}else{
    const trackKey=JSON.stringify([agency,storm.id,expected,agency==='NHC'?advisory.fileUpdateTime:storm.issued_at,url]);
    let content:Uint8Array|undefined;try{content=cached(trackKey)??await transport(url,1024*1024);if(content.length>1024*1024)throw Error('Product too large');}catch(e){out.track_status='fetch_failed';out.track_error=`${agency==='NHC'?'NHC forecast/advisory text':'JTWC warning text'} unavailable: ${String(e)}`;}
    if(content)try{const page=new TextDecoder().decode(content),parsed=agency==='NHC'?parseNhcForecast(page,now):parseJtwcForecast(page,now);Object.assign(out,parsed);const found=parsed[field+'_number'],comparison=expected==null||expected===''?'same':standing(found,expected);
      if(!parsed.points.length){out.track_status='unparsed';out.track_error=agency==='NHC'?'forecast/advisory page carried no parseable forecast points':'warning text carried no parseable forecast positions';}
      else if(comparison==='newer'){out.track_status='feed_lags_text';out.track_error=agency==='NHC'?`forecast/advisory page shows advisory ${found}, newer than advisory ${expected} that CurrentStorms.json lists; the track is advisory ${found}, the storm's other fields are the feed's`:`warning text shows warning ${found}, newer than warning ${expected} that the RSS lists; the track is warning ${found}, the storm's other fields are the RSS's`;}
      else if(comparison==='older'||comparison==='unreadable'){out.track_status='stale_'+field;out['expected_'+field+'_number']=expected;out.track_error=comparison==='older'?(agency==='NHC'?`forecast/advisory page shows advisory ${found}, CurrentStorms.json lists ${expected}`:`warning text shows warning ${found}, the RSS lists ${expected}`):(agency==='NHC'?`forecast/advisory page carries no readable advisory number, so it cannot be matched to advisory ${expected} that CurrentStorms.json lists`:`warning text carries no readable warning number, so it cannot be matched to warning ${expected} that the RSS lists`);}
      if(['ok','feed_lags_text'].includes(out.track_status)&&!cached(trackKey))retain(trackKey,content);
    }catch(e){out.track_status='error';out.track_error='forecast track not built: '+String(e);}
  }}
  if(agency==='NHC'){
   const coneUrl=coneMeta.kmzFile;if(typeof coneMeta!=='object'||Array.isArray(coneMeta)){out.cone_status='refused_link';out.cone_error='CurrentStorms.json trackCone is not an object; nothing fetched';}else if(!coneUrl)out.cone_status='not_linked';else{const deny=refused(coneUrl,'www.nhc.noaa.gov');if(deny){out.cone_status='refused_link';out.cone_error='cone KMZ '+deny;}else{const coneKey=JSON.stringify(['cone',storm.id,coneMeta.advNum,coneMeta.fileUpdateTime,coneUrl]);let bytes:Uint8Array|undefined;try{bytes=cached(coneKey)??await transport(coneUrl,2*1024*1024);if(bytes.length>2*1024*1024)throw Error('Product too large');}catch(e){out.cone_status='fetch_failed';out.cone_error='NHC cone KMZ fetch failed: '+String(e);}if(bytes)try{out.cone=parseNhcCone(bytes);if(!cached(coneKey))retain(coneKey,bytes);}catch(e){out.cone_status='unparsed';out.cone_error='NHC cone KMZ unreadable: '+String(e);}}}
  }
 }
 const gaps:string[]=[];let degraded=false;for(const s of storms){const f=s.forecast,label=`${s.name||'unnamed'} (${s.id||'no id'})`;if(f.track_status==='not_fetched_cap'){gaps.push(`${label}: forecast not fetched, per-call cap of 10 storms`);degraded=true;continue;}if(f.track_status!=='ok'){gaps.push(`${label}: forecast track ${f.track_status}: ${f.track_error??'None'}`);degraded ||=FAILED.has(f.track_status);}if(['fetch_failed','unparsed','refused_link','error'].includes(f.cone_status)){gaps.push(`${label}: no cone, ${f.cone_error??'None'}`);degraded=true;}else if(f.cone_status==='not_linked')gaps.push(`${label}: no cone, CurrentStorms.json links no cone KMZ for it`);}
 if(agency==='JTWC'&&storms.length)gaps.push('JTWC links no cone of uncertainty: cone is null for every JTWC storm (the 34 knot danger swath in its KMZ overlay is a different product and is not fetched)');return {data_gaps:gaps,...(degraded?{degraded:true as const}:{})};
}
