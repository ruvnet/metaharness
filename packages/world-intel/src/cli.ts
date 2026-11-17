#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createParityServer } from './parity-server.js';
import { createNativeRegistry } from './registry.js';
import { createConfiguredRuntime } from './configured-runtime.js';
import { createLocalBgeEmbedding } from './local-embedding.js';
import { WorldIntelClient } from './sources.js';
import { runIntelObservation } from './harness.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--live-smoke') {
    const run = await runIntelObservation(() => new WorldIntelClient().earthquakes({ limit: 3, days: 1 }));
    console.log(JSON.stringify(run, null, 2));
    if (!run.success || !run.receiptsValid) process.exitCode = 1;
    return;
  }
  let dataDir:string|undefined,embeddingModelDir:string|undefined;let allowWrites=false;
  for(let i=0;i<args.length;i++){if(args[i]==='--data-dir'&&args[i+1])dataDir=args[++i];else if(args[i]==='--embedding-model-dir'&&args[i+1])embeddingModelDir=args[++i];else if(args[i]==='--allow-writes')allowWrites=true;else throw new Error('Usage: world-intel-ts [--data-dir DIRECTORY] [--allow-writes] [--embedding-model-dir DIRECTORY] | --live-smoke');}
  if(allowWrites&&!dataDir)throw new Error('--allow-writes requires an explicit --data-dir');
  if(embeddingModelDir&&!dataDir)throw new Error('--embedding-model-dir requires an explicit --data-dir');
  const embedding=embeddingModelDir?await createLocalBgeEmbedding(embeddingModelDir):undefined;
  let runtime:ReturnType<typeof createConfiguredRuntime>|undefined;
  try{runtime=dataDir?createConfiguredRuntime(dataDir,{embedding}):undefined;}catch(error){await embedding?.dispose();throw error;}
  const server=createParityServer({handlers:runtime?.handlers??createNativeRegistry(),allowWrites});
  if(runtime){server.onclose=()=>{runtime?.close();void embedding?.dispose();};}
  await server.connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'World Intel failed');
  process.exitCode = 1;
});
