// iter 130 — per-host harness verification using real host CLIs where available.
// Per user directive: "use things like -p and plugin dir to confirm harnesses
// work as expected for each host."
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm', 'copilot', 'opencode', 'github-actions'];
const results = [];

// ADR-045: scaffold each host through the REAL `metaharness --host <X>` path so
// this gate verifies the CLI's actual output — not adapter-direct fixtures that
// could pass while `npx metaharness --host X` silently emits the wrong tree
// (the gap ADR-045 fixed). If the CLI bin isn't built we fall back to verifying
// whatever bot-<host>/ dirs already exist in CWD (legacy behaviour).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliBin = join(repoRoot, 'packages', 'create-agent-harness', 'dist', 'bin.js');
let scaffoldRoot = process.cwd();
if (existsSync(cliBin)) {
  try {
    scaffoldRoot = mkdtempSync(join(tmpdir(), 'verify-all-hosts-'));
    for (const host of HOSTS) {
      execSync(
        `node ${JSON.stringify(cliBin)} ${JSON.stringify('bot-' + host)} --template vertical:coding --host ${host} --description ${JSON.stringify('Verification harness for ' + host)} --force`,
        { cwd: scaffoldRoot, stdio: 'ignore', timeout: 30000 },
      );
    }
    console.log(`Scaffolded all ${HOSTS.length} hosts via metaharness --host into ${scaffoldRoot}`);
  } catch (e) {
    console.error('Scaffold step failed; falling back to CWD bot-<host>/ dirs:', String(e).slice(0, 120));
    scaffoldRoot = process.cwd();
  }
} else {
  console.log('CLI bin not built (dist/bin.js missing) — verifying pre-existing bot-<host>/ dirs in CWD.');
}

// iter 134: detect whether `claude` CLI is on PATH. CI runners typically
// don't have it; we must fall back to schema/dep verification just like
// the other 7 hosts, otherwise smoke-all-hosts always reports red on CI
// even when the published tarball is correct. Local dev runs still use
// the real CLI when available.
let CLAUDE_AVAILABLE = false;
try {
  execSync('claude --version', { stdio: 'ignore', timeout: 5000 });
  CLAUDE_AVAILABLE = true;
} catch {
  // CLI missing — fall back path is dep check, same as other hosts.
}

for (const host of HOSTS) {
  const dir = join(scaffoldRoot, `bot-${host}`);
  if (!existsSync(dir)) { results.push({ host, status: 'no-scaffold' }); continue; }
  let proof = '';
  try {
    if (host === 'claude-code' && CLAUDE_AVAILABLE) {
      // iter 131 — two real e2e proofs for claude-code:
      //   A) `claude -p` from inside the harness (workspace .claude/settings.json scope)
      //   B) `claude -p --plugin-dir <harness>` (plugin scope, .claude-plugin/plugin.json)
      const tag = `HARNESS_${host.toUpperCase().replace(/-/g, '_')}_OK`;
      const outA = execSync(
        `cd "${dir}" && claude -p --allow-dangerously-skip-permissions "Reply with exactly: ${tag}"`,
        { encoding: 'utf-8', timeout: 120000 }
      ).trim();
      const okA = outA.includes(tag);
      let okB = false, outB = 'skipped (no .claude-plugin/plugin.json)';
      const pluginPath = `${dir}/.claude-plugin/plugin.json`;
      if (existsSync(pluginPath)) {
        outB = execSync(
          `claude -p --allow-dangerously-skip-permissions --plugin-dir "${dir}" "Reply with exactly: PLUGIN_${tag}"`,
          { encoding: 'utf-8', timeout: 120000 }
        ).trim();
        okB = outB.includes(`PLUGIN_${tag}`);
      }
      const status = okA && (okB || outB.startsWith('skipped')) ? 'PASS' : 'FAIL';
      results.push({
        host,
        status,
        tool: okB ? 'claude -p + --plugin-dir' : 'claude -p',
        proof: okB ? `${outA.slice(0, 30)} | plugin: ${outB.slice(0, 30)}` : outA.slice(0, 60),
      });
    } else {
      // Hosts without a runtime in CI — do schema-level verification of the
      // host's emitted config file.
      // iter 134: when CI doesn't have `claude` CLI, claude-code falls back
      // to the same schema-level proof as codex/opencode — verify the
      // scaffold's emitted .claude/settings.json + the iter-131
      // .claude-plugin/plugin.json are valid JSON.
      const checks = {
        'claude-code':{ path: '.claude/settings.json', test:(s) => { try { JSON.parse(s); return true; } catch { return false; } }, tool: '.claude/settings.json valid JSON (CI fallback — claude CLI missing)' },
        codex:   { path: '.codex/config.toml',    test: (s) => !s.startsWith('{') && /\[mcp_servers/.test(s), tool: 'TOML schema (codex spec)' },
        'pi-dev':{ path: 'AGENTS.md',             test: (s) => /pi/.test(s) || s.length > 0,                  tool: 'AGENTS.md present (pi has no MCP)' },
        hermes:  { path: 'cli-config.yaml',       test: (s) => s.length > 0,                                  tool: 'cli-config.yaml present' },
        openclaw:{ path: '.openclaw/openclaw.json',test:(s) => { try { JSON.parse(s); return true; } catch { return false; } }, tool: 'openclaw.json valid JSON' },
        rvm:     { path: 'rvm.manifest.toml',     test: (s) => /\[harness/.test(s),                          tool: 'RVM partition TOML' },
        copilot: { path: '.vscode/mcp.json',      test: (s) => { try { const j=JSON.parse(s); return j.servers || j.mcpServers; } catch { return false; } }, tool: 'VSCode mcp.json valid JSON' },
        opencode:{ path: '.opencode/opencode.json',test:(s) => { try { const j=JSON.parse(s); return j.mcp; } catch { return false; } }, tool: 'opencode.json valid JSON' },
        // ADR-045 — the CLI now emits the workflow file directly, so verify the
        // actual YAML (name + provider-agnostic env), not the containing dir.
        // (Was `.github/workflows` — a directory — which threw EISDIR once a
        // real scaffold existed.) Harness name is `bot-github-actions`, slug =
        // same after slugify.
        'github-actions':{ path: '.github/workflows/bot-github-actions.yml', test: (s) => /name:/.test(s) && /OPENROUTER_API_KEY|ANTHROPIC_API_KEY/.test(s), tool: 'GHA workflow YAML (provider-agnostic env)' },
      };
      const c = checks[host];
      const fp = `${dir}/${c.path}`;
      if (!existsSync(fp)) {
        // Many hosts don't emit a config at scaffold time — the adapter
        // emits at runtime. Verify the matching dep landed instead.
        const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf-8'));
        const dep = `@metaharness/host-${host}`;
        const ok = !!(pkg.dependencies?.[dep] || pkg.peerDependencies?.[dep]);
        results.push({ host, status: ok ? 'PASS' : 'FAIL', tool: `dep: ${dep}`, proof: ok ? `${dep} found in package.json` : 'no host dep' });
      } else {
        const content = readFileSync(fp, 'utf-8');
        const ok = c.test(content);
        // iter 134: for claude-code in CI-fallback mode, ALSO verify the
        // iter-131/132 .claude-plugin/plugin.json (the schema-level proof
        // that `claude -p --plugin-dir` would work). This catches the
        // exact regression iter-132 was guarding against — a published
        // tarball with broken or missing plugin templates.
        let pluginOk = true, pluginProof = '';
        if (host === 'claude-code') {
          const pluginPath = `${dir}/.claude-plugin/plugin.json`;
          if (existsSync(pluginPath)) {
            try {
              const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
              pluginOk = !!(p.name && p.author?.displayName === 'Generated by metaharness');
              pluginProof = ` + plugin.json (name=${p.name})`;
            } catch {
              pluginOk = false; pluginProof = ' + plugin.json INVALID';
            }
          } else {
            pluginOk = false; pluginProof = ' + plugin.json MISSING';
          }
        }
        results.push({
          host,
          status: ok && pluginOk ? 'PASS' : 'FAIL',
          tool: c.tool,
          // CodeQL #6: was `.replace(/\n/g, '\n')` — a no-op (replacing a
          // newline with itself). The intent is to flatten the multi-line
          // config excerpt onto one row; replace newlines with a space.
          proof: content.slice(0, 60).replace(/\n/g, ' ') + pluginProof,
        });
      }
    }
  } catch (e) {
    results.push({ host, status: 'ERROR', tool: 'unknown', proof: String(e).slice(0, 100) });
  }
}

console.log('\nPer-host harness verification:');
console.log('Host'.padEnd(14) + ' '.padEnd(2) + 'Status'.padEnd(8) + 'Tool / proof');
console.log('-'.repeat(80));
for (const r of results) {
  const mark = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '?';
  console.log(`${r.host.padEnd(14)} ${mark}  ${r.status.padEnd(8)} ${r.tool ?? ''} — ${r.proof ?? ''}`);
}
const pass = results.filter(r => r.status === 'PASS').length;
console.log(`\n${pass}/${results.length} hosts verified.`);
process.exit(pass === results.length ? 0 : 1);
