// SPDX-License-Identifier: MIT
// Bounded native ODS reader, porting border_crossings.py fdebf9a8 (Phoenix AGI MIT).
import {inflateRawSync} from 'node:zlib';
import {SaxesParser,type SaxesTagNS} from 'saxes';
export class UnreadableCell{constructor(readonly detail:string){}}
type Cell=string|number|boolean|null|UnreadableCell;
export type OdsTables=Record<string,(Cell[]|null)[]>;
const MIME='application/vnd.oasis.opendocument.spreadsheet';
function crc32(bytes:Uint8Array):number{let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
function members(bytes:Uint8Array):Map<string,Uint8Array>{if(bytes.length>8*1024*1024)throw Error('ODS archive exceeds 8 MiB');const b=Buffer.from(bytes),out=new Map<string,Uint8Array>();let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--)if(b.readUInt32LE(i)===0x06054b50){end=i;break;}if(end<0)throw Error('not an ODS file (not a zip archive)');if(b.readUInt16LE(end+4)||b.readUInt16LE(end+6))throw Error('Multidisk ZIP refused');const count=b.readUInt16LE(end+10),size=b.readUInt32LE(end+12),start=b.readUInt32LE(end+16);if(count>4096||start+size>end)throw Error('Invalid ZIP bounds');let pos=start;for(let i=0;i<count;i++){if(pos+46>start+size||b.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid ZIP entry');const flags=b.readUInt16LE(pos+8),method=b.readUInt16LE(pos+10),crc=b.readUInt32LE(pos+16),compressed=b.readUInt32LE(pos+20),expanded=b.readUInt32LE(pos+24),nl=b.readUInt16LE(pos+28),el=b.readUInt16LE(pos+30),cl=b.readUInt16LE(pos+32),offset=b.readUInt32LE(pos+42);if(pos+46+nl+el+cl>start+size)throw Error('Truncated ZIP entry');const name=b.subarray(pos+46,pos+46+nl).toString('utf8');pos+=46+nl+el+cl;if(!['mimetype','content.xml'].includes(name))continue;if(out.has(name))throw Error('Duplicate ODS ZIP member');const max=name==='mimetype'?200:16*1024*1024;if(flags&1||![0,8].includes(method)||expanded>max)throw Error('Unsafe ODS ZIP member');if(offset+30>b.length||b.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid local header');const localNameLength=b.readUInt16LE(offset+26),payload=offset+30+localNameLength+b.readUInt16LE(offset+28);if(payload+compressed>start||b.subarray(offset+30,offset+30+localNameLength).toString('utf8')!==name)throw Error('Invalid ODS payload bounds/name');const src=b.subarray(payload,payload+compressed),v=method===0?src:inflateRawSync(src,{maxOutputLength:max});if(v.length!==expanded||crc32(v)!==crc)throw Error('ODS size/CRC mismatch');out.set(name,v);}return out;}
const T='urn:oasis:names:tc:opendocument:xmlns:table:1.0',O='urn:oasis:names:tc:opendocument:xmlns:office:1.0',X='urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const repeat=(s:string|undefined):number|null=>s===undefined?1:/^[+-]?\d+$/.test(s.trim())?Math.max(Number(s),1):null;
// Python float accepts decimal syntax (including separators), not JS hexadecimal/binary literals.
function typedNumber(raw:string|undefined):Cell {
 if(raw===undefined)return new UnreadableCell('unreadable number');
 const s=raw.trim(), digits='[0-9](?:_?[0-9])*';
 const decimal=new RegExp('^[+-]?(?:'+digits+'(?:\\.(?:'+digits+')?)?|\\.'+digits+')(?:[eE][+-]?'+digits+')?$');
 if(/^[+-]?(?:inf(?:inity)?|nan)$/i.test(s))return /nan/i.test(s)?NaN:(s.startsWith('-')?-Infinity:Infinity);
 return decimal.test(s)?Number(s.replaceAll('_','')):new UnreadableCell('unreadable number');
}
function typedDate(raw:string):Cell {
 const match=/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw),parsed=Date.parse(raw);
 if(!match||!Number.isFinite(parsed))return new UnreadableCell('unreadable date');
 const clock=/T(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?/.exec(raw);
 if(clock&&(Number(clock[1])>23||Number(clock[2]??0)>59||Number(clock[3]??0)>59))return new UnreadableCell('unreadable date');

 // Date.parse silently normalizes impossible calendar dates, unlike datetime.fromisoformat.
 const y=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
 const calendar=new Date(0);calendar.setUTCFullYear(y,month-1,day);calendar.setUTCHours(0,0,0,0);
 if(y<1||calendar.getUTCFullYear()!==y||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)return new UnreadableCell('unreadable date');
 return raw.slice(0,10);
}
const key=(uri:string,local:string)=>`${uri} ${local}`;
export function readOdsTables(bytes:Uint8Array,wanted?:Iterable<string>):OdsTables{
 const files=members(bytes);if(files.has('mimetype')&&new TextDecoder().decode(files.get('mimetype')).trim()!==MIME)throw Error('not an ODS spreadsheet (mimetype)');if(!files.has('content.xml'))throw Error('ODS file has no content.xml');const raw=files.get('content.xml')!;
 // Strict UTF-8 avoids alternate-encoding DTD bypasses and silent replacement of source figures.
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(raw);if(/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))throw Error('ODS content.xml declares a DTD; refused');if(xml.split('<').some(s=>s.length>1024*1024))throw Error('ODS XML tag/text run exceeds 1 MiB');
 const selected=wanted?new Set(wanted):null,tables:OdsTables=Object.create(null),names=new Set<string>();let depth=0,skip=0,sheetAt=0,rowAt=0,cellAt=0,paraAt=0,seen=0,rowsKept=0,cellsKept=0,textKept=0,paragraphs=0,blank=0,rowDone=false;let sheet:(Cell[]|null)[]=[],row:Cell[]=[],rowRepeat:string|undefined,cellRepeat=1,text='';
 const countText=(n:number)=>{textKept+=n;if(textKept>4*1024*1024)throw Error('ODS text exceeds 4 MiB');};
 const write=(s:string)=>{countText(s.length);text+=s;};
 const add=(v:Cell,n:number)=>{if(v===null){blank+=n;return;}if(row.length+blank>=256){rowDone=true;return;}row.push(...Array(blank).fill(null));blank=0;row.push(...Array(Math.min(n,256-row.length)).fill(v));if(row.length>=256)rowDone=true;};
 const closeRow=()=>{if(!row.length)return;const n=repeat(rowRepeat),r=n===null?1:n;if(!Number.isSafeInteger(r)||rowsKept+r>200000)throw Error('ODS rows exceed 200000');const c=n===null?0:r*row.length;if(cellsKept+c>1000000)throw Error('ODS cells exceed 1000000');rowsKept+=r;cellsKept+=c;if(n===null)sheet.push(null);else for(let i=0;i<r;i++)sheet.push([...row]);};
 const parser=new SaxesParser({xmlns:true});parser.on('doctype',()=>{throw Error('ODS DTD refused');});parser.on('error',e=>{throw e;});
 parser.on('opentag',(tag:SaxesTagNS)=>{depth++;if(depth>10000)throw Error('ODS nesting exceeds 10000');const name=key(tag.uri,tag.local),attrs:Record<string,string>=Object.create(null);for(const a of Object.values(tag.attributes)){attrs[key(a.uri,a.local)]=a.value;names.add(key(a.uri,a.local));}names.add(name);if(names.size>2000)throw Error('ODS distinct names exceed 2000');if(skip)return;
  if(cellAt){if(paraAt){if(name===key(X,'s')){const n=repeat(attrs[key(X,'c')]);write(' '.repeat(Math.min(n??1,1024)));skip=depth;}else if(name===key(X,'tab')){write('\t');skip=depth;}else if(name===key(X,'line-break')){write('\n');skip=depth;}else if([key(O,'annotation'),key(X,'note')].includes(name))skip=depth;}else if([key(X,'p'),key(X,'h')].includes(name)){if(paragraphs)write('\n');paragraphs++;paraAt=depth;}else if([key(O,'annotation'),key(X,'note'),key(T,'table')].includes(name))skip=depth;return;}
  if(rowAt){if(rowDone||![key(T,'table-cell'),key(T,'covered-table-cell')].includes(name)){skip=depth;return;}const rep=repeat(attrs[key(T,'number-columns-repeated')]);if(rep===null){add(new UnreadableCell('unreadable column repeat'),1);rowDone=true;skip=depth;return;}const kind=attrs[key(O,'value-type')];let v:Cell|undefined;if(['float','percentage','currency'].includes(kind??'')){const s=attrs[key(O,'value')];v=typedNumber(s);}else if(kind==='date'){v=typedDate(attrs[key(O,'date-value')]??'');}else if(kind==='boolean')v=(attrs[key(O,'boolean-value')]??'').toLowerCase()==='true';else if(kind==='time')v=attrs[key(O,'time-value')]??null;else if(kind==='string'&&attrs[key(O,'string-value')]!==undefined)v=attrs[key(O,'string-value')]!;
   if(v!==undefined){if(typeof v==='string')countText(v.length);add(v,rep);skip=depth;return;}cellAt=depth;cellRepeat=rep;text='';paragraphs=0;return;
  }
  if(sheetAt){if(name===key(T,'table-row')){rowAt=depth;row=[];rowRepeat=attrs[key(T,'number-rows-repeated')];blank=0;rowDone=false;}else if(name===key(T,'table'))skip=depth;return;}
  if(name===key(T,'table')){seen++;const n=attrs[key(T,'name')]||`Sheet${seen}`;if(selected&&!selected.has(n)){skip=depth;return;}if(Object.hasOwn(tables,n))throw Error('ODS duplicate sheet name');sheet=[];tables[n]=sheet;sheetAt=depth;}
 });
 parser.on('text',s=>{if(paraAt&&!skip)write(s);});parser.on('cdata',s=>{if(paraAt&&!skip)write(s);});
 parser.on('closetag',()=>{const d=depth--;if(skip){if(d===skip)skip=0;else return;}if(d===paraAt)paraAt=0;else if(d===cellAt){cellAt=0;add(text||null,cellRepeat);}else if(d===rowAt){rowAt=0;closeRow();}else if(d===sheetAt)sheetAt=0;});
 for(let i=0;i<xml.length;i+=65536)parser.write(xml.slice(i,i+65536));parser.close();if(!seen)throw Error('ODS file has no sheets');return tables;
}
