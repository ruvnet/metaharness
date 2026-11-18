// SPDX-License-Identifier: MIT
// Explicit HTTP lifecycle adapter. Importing/constructing does not bind a port.
import {createServer,type Server} from 'node:http';
import {createDashboard,type DashboardOptions} from './dashboard.js';
export interface DashboardListenOptions{host?:string;port?:number;allowRemote?:boolean;maxBodyBytes?:number;allowOrigins?:readonly string[]}
export function validateDashboardListen(o:DashboardListenOptions={}){
 const host=o.host??'127.0.0.1',port=o.port??8501;
 if(!o.allowRemote&&!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Remote dashboard binding requires explicit allowRemote');
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Dashboard port must be 0..65535');
 const cap=o.maxBodyBytes??64000;if(!Number.isInteger(cap)||cap<1||cap>1000000)throw new Error('Dashboard body limit must be 1..1000000');
 for(const origin of o.allowOrigins??[]){const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.origin!==origin||u.username||u.password)throw new Error('Explicit allowed origins must be exact HTTP(S) origins');}
 return {host,port,cap};
}
export function createDashboardHttpServer(options:DashboardOptions,listen:DashboardListenOptions={}):Server{
 const configured=validateDashboardListen(listen),app=createDashboard(options);
 const server=createServer(async(req,res)=>{
  const controller=new AbortController();res.once('close',()=>controller.abort());
  try{
   // Reject absolute-form targets and unexpected Host to prevent local DNS rebinding.
   const host=req.headers.host;if(!host){res.writeHead(400);res.end('Host required');return;}
   if(!listen.allowRemote&&!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)){res.writeHead(403);res.end('Untrusted Host');return;}
   const origin=req.headers.origin;
   if(origin&&origin!=='http://'+host&&!(listen.allowOrigins??[]).includes(origin)){res.writeHead(403,{'Content-Type':'application/json'});res.end('{"error":"Cross-origin dashboard access denied"}');return;}
   const target=req.url??'/';if(!target.startsWith('/')||target.startsWith('//')||target.includes('\\')||/[\x00-\x20\x7f]/.test(target)){res.writeHead(400);res.end('Invalid request target');return;}
   const chunks:Buffer[]=[];let size=0;
   for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>configured.cap){res.writeHead(413,{'Content-Type':'application/json'});res.end('{"error":"Request body exceeds limit"}');return;}chunks.push(b);}
   const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
   const method=req.method??'GET',body=['GET','HEAD'].includes(method)?undefined:Buffer.concat(chunks).toString('utf8');
   const response=await app.handle(new Request('http://'+host+target,{method,headers,body,signal:controller.signal}));
   const responseHeaders:Record<string,string>={};response.headers.forEach((v,k)=>{if(k.toLowerCase()!=='access-control-allow-origin')responseHeaders[k]=v;});if(origin){responseHeaders['Access-Control-Allow-Origin']=origin;responseHeaders.Vary='Origin';}res.writeHead(response.status,responseHeaders);
   if(method==='HEAD'||!response.body){await response.body?.cancel();res.end();return;}
   const reader=response.body.getReader(),abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
   try{while(!controller.signal.aborted){const r=await reader.read();if(r.done)break;if(!res.write(r.value))await new Promise<void>(resolve=>{const finish=()=>{res.removeListener('drain',finish);res.removeListener('close',finish);resolve();};res.once('drain',finish);res.once('close',finish);});}res.end();}
   finally{controller.signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
  }catch(e){if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:controller.signal.aborted?'Request cancelled':e instanceof Error?e.message:'Dashboard request failed'}));}
 });
 server.requestTimeout=30000;server.headersTimeout=10000;server.maxHeadersCount=100;return server;
}
/** Call only on explicit startup. close() cancels long-lived streams and closes connections. */
export async function startDashboard(options:DashboardOptions,listen:DashboardListenOptions={}){
 const {host,port}=validateDashboardListen(listen),server=createDashboardHttpServer(options,listen);
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
 let closing:Promise<void>|undefined;return {server,address:server.address(),close(){return closing??=new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();});}};
}
