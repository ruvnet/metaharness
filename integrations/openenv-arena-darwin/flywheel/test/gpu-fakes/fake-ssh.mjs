// Fake `ssh` for tests: `exec node fake-ssh.mjs <calls.jsonl> <mode> "$@"`.
// mode ok:   binds the -L local port and serves GET /v1/models -> {data:[{id:'qwen38'}]} until SIGTERM
//            (stands in for tunnel + remote vLLM).
// mode fail: prints a publickey denial and exits 255 (like a key that is not attached yet).
import { appendFileSync } from 'node:fs';
import http from 'node:http';

const [logPath, mode, ...argv] = process.argv.slice(2);
appendFileSync(logPath, `${JSON.stringify({ argv, mode, envKeys: Object.keys(process.env).sort() })}\n`);
if (mode === 'fail') { process.stderr.write('root@203.0.113.5: Permission denied (publickey).\n'); process.exit(255); }
const fwd = argv[argv.indexOf('-L') + 1] ?? '';
const m = /^127\.0\.0\.1:(\d+):localhost:8000$/.exec(fwd);
if (!m) { process.stderr.write('fake-ssh: bad -L\n'); process.exit(255); }
const srv = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen38' }] })); return; }
  res.writeHead(404); res.end();
});
srv.listen(Number(m[1]), '127.0.0.1');
process.on('SIGTERM', () => process.exit(0)); // like ssh: the forward dies with the process, keep-alives too
