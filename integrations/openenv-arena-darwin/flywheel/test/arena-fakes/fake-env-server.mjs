// Minimal stand-in for the env container: GET /health and GET /schema only.
//   node fake-env-server.mjs PORT MODE   (MODE: ok | no-health | flaky-schema | dies)
// The schema is the env lane's captured live /schema (evidence/schema.json), which includes `state`.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const ENV_DIR = process.env.FAKE_ENV_DIR ?? '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena';
const [port, mode = 'ok'] = process.argv.slice(2);
const schema = JSON.parse(readFileSync(`${ENV_DIR}/evidence/schema.json`, 'utf8'));
if (mode === 'dies') setTimeout(() => process.exit(3), 200); // the server crashes right after start
let schemaCalls = 0;
createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health') return mode === 'no-health' || mode === 'dies' ? send(503, { status: 'starting' }) : send(200, { status: 'healthy' });
  if (req.url === '/schema') {
    schemaCalls += 1;
    if (mode === 'flaky-schema' && schemaCalls > 1) return send(200, { ...schema, action: { ...schema.action, title: 'Changed' } });
    return send(200, schema);
  }
  return send(404, { detail: 'not found' });
}).listen(Number(port), '127.0.0.1');
setTimeout(() => process.exit(0), 10 * 60 * 1000).unref(); // never outlive a broken test run by long
