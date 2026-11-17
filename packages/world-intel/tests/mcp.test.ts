// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWorldIntelServer } from '../src/mcp.js';
import { WorldIntelClient } from '../src/sources.js';

async function connection() {
  let calls = 0;
  const fake = {
    earthquakes: async () => { calls++; return { data: [{ id: 'fixture' }], provenance: { source: 'fixture', stale: false, fetchedAt: '2026-11-17T00:00:00Z', url: 'https://earthquake.usgs.gov/fixture', cacheAgeMs: 0, warnings: [] } }; },
    weatherAlerts: async () => { throw new Error('Provider unavailable'); },
    indicator: async () => ({ data: [], provenance: { source: 'fixture', stale: true, fetchedAt: '2026-11-16T00:00:00Z', url: 'https://api.worldbank.org/fixture', cacheAgeMs: 999999, warnings: ['stale fallback'] } }),
  } as unknown as WorldIntelClient;
  const server = createWorldIntelServer(fake);
  const client = new Client({ name: 'world-intel-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client, calls: () => calls, close: async () => { await client.close(); await server.close(); } };
}

describe('MCP protocol', () => {
  it('initializes, lists the scoped tools, and returns structured observations', async () => {
    const c = await connection();
    try {
      expect((await c.client.listTools()).tools.map(x => x.name)).toEqual(['intel_earthquakes', 'intel_weather_alerts', 'intel_indicator', 'intel_status']);
      const result = await c.client.callTool({ name: 'intel_earthquakes', arguments: { limit: 3 } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ observation: { data: [{ id: 'fixture' }] }, governance: { accepted: true, receiptsValid: true } });
      expect((result.structuredContent as any).governance.receipts).toHaveLength(1);
      expect(c.calls()).toBe(1);
    } finally { await c.close(); }
  });
  it('rejects unknown tools, unexpected arguments and invalid bounds before dispatch', async () => {
    const c = await connection();
    try {
      for (const input of [
        { name: 'shell', arguments: {} },
        { name: 'intel_earthquakes', arguments: { url: 'http://localhost' } },
        { name: 'intel_earthquakes', arguments: { limit: 101 } },
        { name: 'intel_earthquakes', arguments: { limit: 0 } },
        { name: 'intel_earthquakes', arguments: { days: 1.5 } },
        { name: 'intel_earthquakes', arguments: { allowStale: 'true' } },
        { name: 'intel_indicator', arguments: { country: '../../etc' } },
      ]) expect((await c.client.callTool(input)).isError).toBe(true);
      expect(c.calls()).toBe(0);
    } finally { await c.close(); }
  });
  it('does not treat provider failures or local status as successful live coverage', async () => {
    const c = await connection();
    try {
      const failure = await c.client.callTool({ name: 'intel_weather_alerts', arguments: {} });
      expect(failure.isError).toBe(true);
      expect(failure.structuredContent).toMatchObject({ observation: null, governance: { accepted: false, receiptsValid: true } });
      const stale = await c.client.callTool({ name: 'intel_indicator', arguments: { allowStale: true } });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toMatchObject({ observation: null, governance: { accepted: false, receiptsValid: true } });
      const status = await c.client.callTool({ name: 'intel_status', arguments: {} });
      expect(status.structuredContent).toMatchObject({ providerHealth: 'not_checked', upstreamParity: false });
      expect(c.calls()).toBe(0);
    } finally { await c.close(); }
  });
});
