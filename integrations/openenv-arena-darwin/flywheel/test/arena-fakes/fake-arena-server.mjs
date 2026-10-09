// Local fake of the OpenEnv Arena HTTP API for tests. Records every request (method, path, headers, body)
// in memory only. Routes are `"METHOD /path"` -> handler(req, body) => {status, json?, text?, headers?}.
import { createServer } from 'node:http';

export const FAKE_BOARD = {
  tasks_per_domain: 5, max_tasks: 50, benchmark: 'heldout-v2', next_cursor: null,
  domains: [{ id: 'software-engineering', name: 'Software engineering', short: 'Software' }],
  baseline: { model: 'Qwen3.8-27B', solved: 4, total: 40 },
  entries: [{ user: 'someone-else', runs: 1, average: 0.125, scores: {} }],
  runs: [{ user: 'someone-else', run_id: 'r1', submission_id: 'x-v1', solved: 5, total: 40 }],
};

export async function startFakeArena(routes = {}) {
  const requests = [];
  const table = {
    'GET /api/openenv': () => ({ status: 200, json: { connected: true, in_flight: 0 } }),
    'GET /api/leaderboard': () => ({ status: 200, json: FAKE_BOARD }),
    'GET /api/openenv/submissions': () => ({ status: 200, json: [] }),
    ...routes,
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = new URL(req.url, 'http://x').pathname;
      const rec = { method: req.method, path, headers: { ...req.headers }, body };
      requests.push(rec);
      const key = `${req.method} ${path}`;
      const handler = table[key] ?? Object.entries(table).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
      const out = handler ? handler(rec) : { status: 404, json: { code: 'NOT_FOUND' } };
      const payload = out.text ?? (out.json === undefined ? '' : JSON.stringify(out.json));
      res.writeHead(out.status, { 'Content-Type': out.text ? 'text/html' : 'application/json', ...(out.headers ?? {}) });
      res.end(payload);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, base: `${origin}/api/openenv`, requests, routes: table,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}
