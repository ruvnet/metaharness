// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scaffold, TEMPLATES, type Host } from '../src/index.js';
import { doctor } from '../src/subcommands.js';
import { upgradeCmd } from '../src/upgrade-cmd.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function generate(host: Host = 'claude-code', template: string = 'vertical:coding') {
  const dir = await mkdtemp(join(tmpdir(), 'generated journey ')); roots.push(dir);
  await scaffold({ name: 'journey-bot', template, host,
    targetDir: dir, force: true, generatorVersion: 'test', darwin: false });
  return dir;
}
const json = async (dir: string, path: string) => JSON.parse(await readFile(join(dir, path), 'utf8'));

describe('generated user journey', () => {
  it.each(TEMPLATES)('emits a loadable plugin layout for %s', async template => {
    const dir = await generate('claude-code', template);
    const plugin = await json(dir, '.claude-plugin/plugin.json');
    expect(plugin.author.name).toBeTruthy();
    expect(plugin.mcpServers['journey-bot'].args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/mcp.js']);
    const manifest = await json(dir, '.harness/manifest.json');
    for (const path of Object.keys(manifest.files).filter(p => /^\.claude\/(skills|commands)\//.test(p)))
      expect(await readFile(join(dir, path.slice('.claude/'.length)), 'utf8')).toBe(await readFile(join(dir, path), 'utf8'));
  });

  it.each(['codex', 'hermes', 'copilot', 'opencode', 'openclaw'] as Host[])('launches the local MCP entry emitted for %s', async host => {
    const dir = await generate(host, 'minimal');
    let command: string; let args: string[];
    if (host === 'codex') {
      const config = await readFile(join(dir, '.codex/config.toml'), 'utf8');
      command = /command = "([^"]+)"/.exec(config)![1];
      args = JSON.parse(/args = (\[[^\n]+\])/.exec(config)![1]);
    } else if (host === 'opencode') {
      [command, ...args] = (await json(dir, '.opencode/opencode.json')).mcp['journey-bot'].command;
    } else if (host === 'hermes') {
      const config = await readFile(join(dir, 'cli-config.yaml'), 'utf8');
      const server = JSON.parse(config.split('mcp_servers:\n')[1].trim().slice('journey-bot: '.length));
      ({command, args} = server);
    } else {
      const config = await json(dir, host === 'copilot' ? '.vscode/mcp.json' : '.openclaw/openclaw.json');
      const server = host === 'copilot' ? config.servers['journey-bot'] : config.mcp.servers['journey-bot'];
      ({command, args} = server);
    }
    expect(command).toBe('node');
    expect(args).toEqual(['./bin/mcp.js']);
    const client = new Client({name: 'host-config-journey', version: '1.0.0'});
    try {
      await client.connect(new StdioClientTransport({command, args, cwd: dir}));
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['harness_info']);
    } finally { await client.close(); }
  });

  it.each([{hosts:['copilot','hermes'] as Host[]},{hosts:['hermes','copilot'] as Host[]}])('retains separate Hermes and sibling host setup guides for %j', async ({hosts}) => {
    const dir = await mkdtemp(join(tmpdir(),'multi-host-guides-')); roots.push(dir);
    await scaffold({name:'journey-bot',template:'minimal',hosts,targetDir:dir,force:true,generatorVersion:'test',darwin:false});
    expect(await readFile(join(dir,'install-hermes.md'),'utf8')).toContain('$HERMES_HOME/config.yaml');
    expect(await readFile(join(dir,'install.md'),'utf8')).toContain('Copilot');
  });

  it('rejects malformed protocol input and bounds complete and incomplete messages', async () => {
    const dir = await generate();
    const exchange = (input: string) => new Promise<{code: number | null; stdout: string}>(resolve => {
      const child = spawn(process.execPath, [join(dir, 'bin/mcp.js')], {stdio: ['pipe', 'pipe', 'pipe']});
      let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.on('close', code => resolve({code, stdout})); child.stdin.end(input);
    });
    const result = await exchange('null\nnot-json\n' + JSON.stringify({jsonrpc:'2.0', id: 1, method:'tools/list'}) + '\n');
    expect(result.stdout.trim().split('\n').map(line => JSON.parse(line).error.code)).toEqual([-32600, -32700, -32000]);
    expect((await exchange('x'.repeat(65537))).code).toBe(1);
    expect((await exchange('x'.repeat(65537) + '\n')).code).toBe(1);
  });

  it.skipIf(process.platform === 'win32')('initializes MCP through a symlinked directory with spaces', async () => {
    const dir = await generate();
    const parent = await mkdtemp(join(tmpdir(), 'aliased journey ')); roots.push(parent);
    const alias = join(parent, 'aliased harness'); await symlink(dir, alias, 'dir');
    const client = new Client({name:'alias-journey',version:'1.0.0'});
    try {
      await client.connect(new StdioClientTransport({command:process.execPath,args:[join(alias,'bin/mcp.js')],cwd:parent}));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['harness_info']);
      expect(JSON.stringify((await client.callTool({name:'harness_info',arguments:{}})).content)).toContain('journey-bot');
    } finally { await client.close(); }
  });

  it('ships host-discoverable commands, skills and agent instructions', async () => {
    const dir = await generate();
    expect((await json(dir, '.claude-plugin/plugin.json')).author.name).toBe('Generated by metaharness');
    expect(await readFile(join(dir, 'commands/review-diff.md'), 'utf8')).toMatch(/review/i);
    expect(await readFile(join(dir, 'skills/plan-change/SKILL.md'), 'utf8')).toContain('plan');
    expect(await readFile(join(dir, 'agents/reviewer.md'), 'utf8')).toContain('You review diffs');
    await writeFile(join(dir, '.harness/claims.json'), '{"private":true}');
    const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' }))[0];
    const paths = packed.files.map((f: {path: string}) => f.path);
    expect(paths).not.toContain('.harness/claims.json');
    for (const path of ['.claude-plugin/plugin.json', 'commands/review-diff.md', 'skills/plan-change/SKILL.md', 'agents/reviewer.md', 'bin/mcp.js']) expect(paths).toContain(path);
  });

  it('diagnoses an invalid plugin without claiming the host was executed', async () => {
    const dir = await generate();
    const plugin = await json(dir, '.claude-plugin/plugin.json'); delete plugin.author.name;
    await writeFile(join(dir, '.claude-plugin/plugin.json'), JSON.stringify(plugin));
    const result = await doctor([dir]);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('author.name');
    expect(result.lines.join('\n')).not.toContain('--plugin-dir works');
  });

  it('connects the emitted plugin MCP command with a real SDK client and calls its read-only tool', async () => {
    const dir = await generate();
    const plugin = await json(dir, '.claude-plugin/plugin.json');
    const server = plugin.mcpServers['journey-bot'];
    expect(server.command).toBe('node');
    expect(JSON.stringify(server)).not.toContain('@latest');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: server.args.map((arg: string) => arg.replace('${CLAUDE_PLUGIN_ROOT}', dir)), cwd: tmpdir() });
    const client = new Client({name: 'journey-test', version: '1.0.0'});
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toEqual(['harness_info']);
      const response = await client.callTool({name: 'harness_info', arguments: {}});
      expect(response.isError).not.toBe(true);
      expect(JSON.stringify(response.content)).toContain('journey-bot');
      await expect(client.callTool({name: 'harness_info', arguments: {path: '/etc/passwd'}})).rejects.toThrow();
      await expect(client.callTool({name: 'shell', arguments: {command: 'echo no'}})).rejects.toThrow();
    } finally { await client.close(); }
  });

  it('rejects non-object MCP arguments while retaining the connection', async () => {
    const dir = await generate();
    const requests = [
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'adversarial',version:'1'}}},
      ...[null, [], 'text', 1, false, {path:'/etc/passwd'}].map((arguments_, index) =>
        ({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name:'harness_info',arguments:arguments_}})),
      {jsonrpc:'2.0',id:8,method:'ping'},
    ];
    const responses = await new Promise<any[]>((resolve, reject) => {
      const child = spawn(process.execPath, [join(dir,'bin/mcp.js')], {stdio:['pipe','pipe','pipe']});
      let stdout = ''; child.stdout.on('data', chunk => {stdout += chunk;}); child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(stdout.trim().split('\n').map(line => JSON.parse(line))) : reject(new Error('MCP exited '+code)));
      child.stdin.end(requests.map(request => JSON.stringify(request)).join('\n')+'\n');
    });
    expect(responses.slice(1,7).map(response => response.error?.code)).toEqual(Array(6).fill(-32602));
    expect(responses.at(-1)).toMatchObject({id:8,result:{}});
  });

  it('preserves a user-owned file when an upgrade first adds that path', async () => {
    const dir = await generate();
    const manifest = await json(dir, '.harness/manifest.json');
    const path = 'agents/reviewer.md'; delete manifest.files[path];
    const body = JSON.stringify(manifest);
    await writeFile(join(dir, '.harness/manifest.json'), body);
    await writeFile(join(dir, '.harness/manifest.sha256'), createHash('sha256').update(body).digest('hex'));
    await writeFile(join(dir, path), 'User-owned review instructions');
    const result = await upgradeCmd([dir, '--apply', '--conflict=rej']);
    expect(result.code).toBe(1);
    expect(await readFile(join(dir, path), 'utf8')).toBe('User-owned review instructions');
    expect(await readFile(join(dir, path + '.rej'), 'utf8')).toContain('You review diffs');
  });

  it('preserves customized legacy Claude permissions during registration migration', async () => {
    const dir = await generate();
    const path = '.claude/settings.json';
    const oldSettings = {permissions:{allow:['mcp__journey-bot__*'],deny:['Read(./.env)']},
      mcpServers:{'journey-bot':{command:'npx',args:['-y','journey-bot@latest','mcp','start']}}};
    const original = JSON.stringify(oldSettings);
    const manifest = await json(dir,'.harness/manifest.json');
    manifest.files[path] = createHash('sha256').update(original).digest('hex');
    const body = JSON.stringify(manifest);
    await writeFile(join(dir,'.harness/manifest.json'),body);
    await writeFile(join(dir,'.harness/manifest.sha256'),createHash('sha256').update(body).digest('hex'));
    oldSettings.permissions.deny.push('Bash(curl *)');
    const customized = JSON.stringify(oldSettings); await writeFile(join(dir,path),customized);
    const result = await upgradeCmd([dir,'--apply']);
    expect(result.code).toBe(1);
    expect(await readFile(join(dir,path),'utf8')).toBe(customized);
    expect((await json(dir,path)).permissions.deny).toContain('Bash(curl *)');
    expect((await json(dir,path+'.rej')).mcpServers['journey-bot'].command).toBe('node');
    expect(result.lines.join('\n')).toContain('structured configuration uses a .rej file');
  });

  it('preserves customized legacy OpenCode permissions during registration migration', async () => {
    const dir = await generate('opencode');
    const path = '.opencode/opencode.json';
    const oldConfig = await json(dir, path);
    oldConfig.mcp['journey-bot'].command = ['npx', '-y', 'journey-bot@latest', 'mcp', 'start'];
    const original = JSON.stringify(oldConfig);
    const manifest = await json(dir,'.harness/manifest.json');
    manifest.files[path] = createHash('sha256').update(original).digest('hex');
    const body = JSON.stringify(manifest);
    await writeFile(join(dir,'.harness/manifest.json'),body);
    await writeFile(join(dir,'.harness/manifest.sha256'),createHash('sha256').update(body).digest('hex'));
    oldConfig.permission.bash['curl *'] = 'deny';
    const customized = JSON.stringify(oldConfig); await writeFile(join(dir,path),customized);
    const result = await upgradeCmd([dir,'--apply']);
    expect(result.code).toBe(1);
    expect(await readFile(join(dir,path),'utf8')).toBe(customized);
    expect((await json(dir,path)).permission.bash['curl *']).toBe('deny');
    expect((await json(dir,path+'.rej')).mcp['journey-bot'].command).toEqual(['node','./bin/mcp.js']);
  });

  it('accepts a plugin that omits the optional author field', async () => {
    const dir = await generate();
    const plugin = await json(dir, '.claude-plugin/plugin.json'); delete plugin.author;
    await writeFile(join(dir, '.claude-plugin/plugin.json'), JSON.stringify(plugin));
    expect((await doctor([dir])).code).toBe(0);
  });

  it('upgrade preserves user policy and keeps plugin instructions and server packaged', async () => {
    const dir = await generate();
    // Reconstruct the previously generated manifest before the plugin/runtime overlay.
    const manifest = await json(dir, '.harness/manifest.json');
    for (const path of Object.keys(manifest.files)) {
      if (/^(commands|skills|agents)\//.test(path) || path === 'bin/mcp.js') {
        await rm(join(dir, path), {force: true}); delete manifest.files[path];
      }
    }
    for (const directory of ['commands', 'skills', 'agents']) await rm(join(dir, directory), {recursive: true, force: true});
    const plugin = await json(dir, '.claude-plugin/plugin.json');
    delete plugin.author.name; delete plugin.mcpServers;
    const legacy = JSON.stringify(plugin); await writeFile(join(dir, '.claude-plugin/plugin.json'), legacy);
    manifest.files['.claude-plugin/plugin.json'] = createHash('sha256').update(legacy).digest('hex');
    const manifestBody = JSON.stringify(manifest);
    await writeFile(join(dir, '.harness/manifest.json'), manifestBody);
    await writeFile(join(dir, '.harness/manifest.sha256'), createHash('sha256').update(manifestBody).digest('hex'));
    const path = join(dir, '.harness/mcp-policy.json');
    const policy = await json(dir, '.harness/mcp-policy.json'); policy.maxToolCallsPerTurn = 2;
    await writeFile(path, JSON.stringify(policy));
    expect((await upgradeCmd([dir, '--apply'])).code).toBe(0);
    expect((await json(dir, '.harness/mcp-policy.json')).maxToolCallsPerTurn).toBe(2);
    expect((await json(dir, '.claude-plugin/plugin.json')).author.name).toBeTruthy();
    expect(await readFile(join(dir, 'bin/mcp.js'), 'utf8')).toContain('harness_info');
    expect((await upgradeCmd([dir, '--apply'])).code).toBe(0);
  });
});
