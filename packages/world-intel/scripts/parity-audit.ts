/** Offline audit, never executes upstream Python or fetches providers.
 * Run after build: node --experimental-strip-types scripts/parity-audit.ts
 * --require-complete makes incomplete parity an explicit failing gate. */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeRegistry } from '../dist/registry.js';
import { createParityServer } from '../dist/parity-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
type Evidence = { kind: string; path: string };
type Row = { name?: string; uri?: string; status: string; implementedTool?: string | null; evidence: Evidence[] };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryBytes = readFileSync(resolve(root, 'data/upstream-tools.json'));
const inventory = JSON.parse(inventoryBytes.toString());
const parity = JSON.parse(readFileSync(resolve(root, 'data/parity.json'), 'utf8'));
const errors: string[] = [];
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
if (inventory.tools.length !== 160 || inventory.prompts.length !== 29 || inventory.resources.length !== 3) errors.push('Pinned inventory count drift');
if (inventory.upstream.commit !== parity.upstreamCommit) errors.push('Pinned commit mismatch');
if (hash(inventoryBytes) !== parity.inventorySha256) errors.push('Inventory digest mismatch');
if (hash(inventory.upstream.licenseText) !== inventory.upstream.licenseSha256) errors.push('License digest mismatch');
const upstreamArg = process.argv.find(a => a.startsWith('--upstream='));
if (upstreamArg) {
  const upstreamRoot = resolve(upstreamArg.slice('--upstream='.length));
  for (const [path, expected] of Object.entries(inventory.upstream.sourceHashes)) {
    if (path.includes('..') || !existsSync(resolve(upstreamRoot, path)) || hash(readFileSync(resolve(upstreamRoot, path))) !== expected) errors.push(`Pinned source mismatch: ${path}`);
  }
  if (!existsSync(resolve(upstreamRoot, 'LICENSE')) || hash(readFileSync(resolve(upstreamRoot, 'LICENSE'))) !== inventory.upstream.licenseSha256) errors.push('Pinned upstream license mismatch');
}

const nativeNames = new Set(Object.keys(createNativeRegistry()));
// Inspect the real protocol surface, not a projected copy of the inventory.
const server = createParityServer({handlers:createNativeRegistry()});
const client = new Client({name:'offline-parity-audit',version:'1'});
const [a,b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b),client.connect(a)]);
let listedTools: any[], listedPrompts: any[], listedResources: any[];
try {
 listedTools=(await client.listTools()).tools;
 listedPrompts=(await client.listPrompts()).prompts;
 listedResources=(await client.listResources()).resources;
} finally {await client.close();await server.close();}
const definitions = new Map<string, any>(listedTools.map((t: any) => [t.name, t]));
for(const t of listedTools){
 const pinned=inventory.tools.find((x:any)=>x.name===t.name);
 if(!pinned || canonical(t.inputSchema)!==canonical(pinned.inputSchema)) errors.push(`${t.name}: advertised schema mismatch`);
}
if(process.argv.includes('--refresh')) {
 const domainFiles=readdirSync(resolve(root,'src/domains')).filter(f=>f.endsWith('.ts'));
 const testFiles=readdirSync(resolve(root,'tests')).filter(f=>f.endsWith('.test.ts'));
 for(const row of parity.tools){
  if(row.status==='verified')continue;
  const name=row.name;
  const source=domainFiles.find(f=>readFileSync(resolve(root,'src/domains',f),'utf8').includes(name));
  const tests=testFiles.filter(f=>readFileSync(resolve(root,'tests',f),'utf8').includes(name));
  row.implementedTool=nativeNames.has(name)?name:null;
  row.status=nativeNames.has(name)?(tests.length?'fixture_verified':'implemented'):'missing';
  row.evidence=nativeNames.has(name)?[
   {kind:'exact_input_schema',path:'src/parity-server.ts'},
   {kind:'native_ts_dispatch',path:source?`src/domains/${source}`:'src/registry.ts'},
   ...tests.map(f=>({kind:'named_fixture_tests',path:`tests/${f}`}))
  ]:[];
  row.notes=nativeNames.has(name)?'Native registration and exact advertised input schema checked offline. Named fixture tests, where linked, cover selected cases only; no claim of exhaustive output/error/state equivalence or live provider verification.':'Not advertised by the default native registry. Configured-store-only capabilities may exist but are not part of this default surface.';
 }
 const guide=JSON.parse(readFileSync(resolve(root,'data/upstream-prompts.json'),'utf8'));
 for(const row of parity.prompts){
  const prompt=guide.prompts.find((p:any)=>p.name===row.name);
  row.status='fixture_verified';row.evidence=[{kind:'selected_rendering_and_argument_tests',path:'tests/guide.test.ts'}];
  row.missingReferencedTools=[...new Set<string>((prompt?.steps??[]).map((s:any)=>s.tool))].filter(n=>!nativeNames.has(n));
  row.notes='Rendering/validation fixtures exist; referenced tool completeness and exhaustive rendering equivalence are not certified.';
 }
 for(const row of parity.resources){row.status='fixture_verified';row.evidence=[{kind:'selected_resource_tests',path:'tests/guide.test.ts'}];row.notes='Native resources and selected fixtures exist. Local source health intentionally differs from upstream and does not claim unobserved provider health.';}
 parity.auditSnapshot={mode:'default_registry_no_credentials_no_store',registeredTools:listedTools.length,advertisedPrompts:listedPrompts.length,advertisedResources:listedResources.length,missingTools:inventory.tools.filter((t:any)=>!nativeNames.has(t.name)).map((t:any)=>t.name),note:'Snapshot refreshed by offline protocol inspection. Fixture status identifies selected tests, not exhaustive parity; rerun tests independently.'};
 writeFileSync(resolve(root,'data/parity.json'),JSON.stringify(parity,null,2)+'\n');
}

if (definitions.size !== nativeNames.size) errors.push('Unpinned native tool registration');
const summarize = (kind: 'tools' | 'prompts' | 'resources', key: 'name' | 'uri') => {
  const expected = new Set<string>(inventory[kind].map((r: Record<string, string>) => r[key]));
  const rows: Row[] = parity[kind];
  if (rows.length !== expected.size || new Set(rows.map(r => r[key])).size !== expected.size || rows.some(r => !expected.has(r[key]!))) errors.push(`${kind}: manifest inventory mismatch`);
  for (const row of rows) {
    if (!['missing', 'partial', 'implemented', 'fixture_verified', 'verified'].includes(row.status)) errors.push(`${kind}/${row[key]}: invalid status`);
    if (row.status !== 'verified') continue;
    const requirements: string[] = parity.acceptance[kind === 'tools' ? 'toolRequirements' : kind === 'prompts' ? 'promptRequirements' : 'resourceRequirements'];
    for (const requirement of requirements) {
      const evidence = row.evidence.find(e => e.kind === requirement);
      if (!evidence || !evidence.path || evidence.path.includes('..') || !existsSync(resolve(root, evidence.path))) errors.push(`${kind}/${row[key]}: missing ${requirement} evidence`);
    }
    if (kind === 'tools') {
      const implementation = definitions.get(row.implementedTool ?? row.name!);
      const upstream = inventory.tools.find((t: { name: string }) => t.name === row.name);
      if (!implementation) errors.push(`${row.name}: verified without native registration`);
      else if (canonical(implementation.inputSchema) !== canonical(upstream.inputSchema)) errors.push(`${row.name}: input schema differs`);
    }
  }
  const verified = rows.filter(r => r.status === 'verified').length;
  const statuses=Object.fromEntries(['missing','partial','implemented','fixture_verified','verified'].map(s=>[s,rows.filter(r=>r.status===s).length]));
  return { total: expected.size, statuses, verified, percent: Number((verified * 100 / expected.size).toFixed(2)), remaining: expected.size - verified };
};
for (const tool of inventory.tools) if (hash(tool.upstream.handlerSource) !== tool.upstream.handlerSha256) errors.push(`Handler digest mismatch: ${tool.name}`);
const result = { upstreamCommit: parity.upstreamCommit, inventoryIntegrity: errors.length === 0, registeredNativeTools: definitions.size, missingNativeTools: inventory.tools.filter((t:any)=>!nativeNames.has(t.name)).map((t:any)=>t.name), advertisedPrompts:listedPrompts.length, advertisedResources:listedResources.length, tools: summarize('tools', 'name'), prompts: summarize('prompts', 'name'), resources: summarize('resources', 'uri'), complete: false, errors };
result.inventoryIntegrity = errors.length === 0;
result.complete = errors.length === 0 && result.tools.remaining === 0 && result.prompts.remaining === 0 && result.resources.remaining === 0;
console.log(JSON.stringify(result, null, 2));
if (errors.length || (process.argv.includes('--require-complete') && !result.complete)) process.exitCode = 1;
