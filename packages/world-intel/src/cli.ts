#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWorldIntelServer } from './mcp.js';
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
  if (args.length !== 0) throw new Error('Usage: metaharness-world-intel [--live-smoke]');
  await createWorldIntelServer().connect(new StdioServerTransport());
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'World Intel failed');
  process.exitCode = 1;
});
