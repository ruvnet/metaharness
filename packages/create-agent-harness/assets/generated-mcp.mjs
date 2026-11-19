// SPDX-License-Identifier: MIT
// Read-only scaffold metadata over MCP stdio. No arbitrary paths, shell or network.
import { readFileSync, realpathSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const protocols = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const tool = { name: 'harness_info', description: 'Read this generated harness name, version and description.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };

export function startMcp() {
  let buffer = '';
  let initialized = false;
  const send = message => process.stdout.write(JSON.stringify(message) + '\n');
  const error = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
  function handle(line) {
    let request;
    try { request = JSON.parse(line); } catch { error(null, -32700, 'Parse error'); return; }
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
      ('id' in request && typeof request.id !== 'string' && typeof request.id !== 'number')) {
      error(null, -32600, 'Invalid request'); return;
    }
    // Notifications have no response, including notifications/initialized.
    if (!('id' in request)) return;
    const {id, method, params} = request;
    let result;
    if (method === 'initialize') {
      if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) {
        error(id, -32602, 'Invalid initialize parameters'); return;
      }
      initialized = true;
      result = {protocolVersion: protocols.includes(params.protocolVersion) ? params.protocolVersion : protocols[0],
        capabilities: {tools: {}}, serverInfo: {name: pkg.name, version: pkg.version}};
    } else if (method === 'ping') result = {};
    else if (!initialized) { error(id, -32000, 'Initialize first'); return; }
    else if (method === 'tools/list') result = {tools: [tool]};
    else if (method === 'tools/call') {
      const args = params?.arguments === undefined ? {} : params.arguments;
      if (params?.name !== tool.name || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) {
        error(id, -32602, 'Only harness_info with empty arguments is supported'); return;
      }
      result = {content: [{type: 'text', text: JSON.stringify({name: pkg.name, version: pkg.version, description: pkg.description})}], isError: false};
    } else { error(id, -32601, 'Method not found'); return; }
    send({jsonrpc: '2.0', id, result});
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    // Bound both incomplete and complete messages before JSON parsing.
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      if (Buffer.byteLength(buffer.slice(0, index), 'utf8') > 65536) { process.stderr.write('MCP message exceeds 64 KiB\n'); process.exitCode = 1; process.stdin.destroy(); return; }
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (line.trim()) handle(line);
    }
    if (Buffer.byteLength(buffer, 'utf8') > 65536) { process.stderr.write('MCP message exceeds 64 KiB\n'); process.exitCode = 1; process.stdin.destroy(); }
  });
}

// Also launch directly from host configuration; importing from the CLI is inert.
import { fileURLToPath } from 'node:url';
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    // Node resolves module symlinks; argv may retain /var rather than
    // /private/var on macOS, or an explicitly symlinked harness directory.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (invokedDirectly) startMcp();
