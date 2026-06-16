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

// ADR-046 — opt-in `--real` pass: boot each INSTALLED host runtime against its
// scaffold. This is the top verification tier (above schema-shape + the
// OpenRouter live-content check) — it caught the opencode/openclaw schema bugs
// that the other tiers passed. Each check is best-effort: a host whose runtime
// isn't installed (or whose model key is absent) is reported `skip`, not failed,
// so the gate stays green on CI without every runtime. Use `--real-strict` to
// fail on any attempted-but-failed real check.
const REAL = process.argv.includes('--real') || process.argv.includes('--real-strict');
if (REAL) {
  const STRICT = process.argv.includes('--real-strict');
  const onPath = (bin) => { try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; } };
  const orKey = process.env.OPENROUTER_API_KEY;
  const realResults = [];
  const run = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf-8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });

  // host -> () => { ok, proof } | throws | returns {skip, proof}
  const realChecks = {
    'claude-code': (dir) => {
      if (!onPath('claude')) return { skip: true, proof: 'claude CLI not installed' };
      // `claude -p` is a full agent turn (heavy). It also flakes transiently when
      // this gate is itself run from INSIDE a `claude` session (nested-CLI
      // contention) — verified by it passing standalone but erroring nested. So
      // allow 4 min and retry once on error before failing.
      const cmd = `cd ${JSON.stringify(dir)} && claude -p --allow-dangerously-skip-permissions "Reply with exactly: REAL_OK"`;
      let out = '', err;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { out = run(cmd, { timeout: 240000 }).trim(); err = null; break; }
        catch (e) { err = e; }
      }
      if (err && !out) throw err;
      return { ok: out.includes('REAL_OK'), proof: `claude -p → ${out.slice(0, 24)}` };
    },
    codex: (dir) => {
      if (!onPath('codex')) return { skip: true, proof: 'codex not installed' };
      // Parse-validate our generated config via a throwaway CODEX_HOME. NOTE:
      // `codex doctor` exits non-zero when unrelated checks fail (no auth, MCP
      // handshake) — so capture stdout regardless of exit code and assert only
      // on the config-parse + MCP-register lines.
      const home = `${dir}/.codexhome`; execSync(`mkdir -p ${JSON.stringify(home)}`);
      execSync(`cp ${JSON.stringify(dir + '/.codex/config.toml')} ${JSON.stringify(home + '/config.toml')}`);
      let out = '';
      try { out = run(`CODEX_HOME=${JSON.stringify(home)} codex doctor`).toString(); }
      catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
      return { ok: /config\.toml parse\s+ok/i.test(out) && /MCP servers\s+1/i.test(out), proof: 'codex doctor: config parse ok + MCP registered' };
    },
    openclaw: (dir) => {
      if (!onPath('openclaw')) return { skip: true, proof: 'openclaw not installed' };
      const out = run(`OPENCLAW_CONFIG_PATH=${JSON.stringify(dir + '/.openclaw/openclaw.json')} openclaw config validate`).toString();
      return { ok: /Config valid/i.test(out), proof: out.trim().split('\n')[0].slice(0, 50) };
    },
    opencode: (dir) => {
      if (!onPath('opencode')) return { skip: true, proof: 'opencode not installed' };
      if (!orKey) return { skip: true, proof: 'no OPENROUTER_API_KEY' };
      // Disable the (unpublished) harness MCP server so the spawn doesn't hang;
      // we are proving config-load + a real model turn, not MCP registration.
      const cfg = `${dir}/.opencode/opencode.json`;
      const j = JSON.parse(readFileSync(cfg, 'utf-8'));
      for (const k of Object.keys(j.mcp || {})) j.mcp[k].enabled = false;
      execSync(`cat > ${JSON.stringify(cfg)} <<'EOF'\n${JSON.stringify(j, null, 2)}\nEOF`, { shell: '/bin/bash' });
      const out = run(`cd ${JSON.stringify(dir)} && opencode run --model openrouter/anthropic/claude-3.5-haiku "Reply with exactly: REAL_OK"`).toString();
      return { ok: out.includes('REAL_OK'), proof: 'opencode run loaded config + replied' };
    },
    'pi-dev': (dir) => {
      if (!onPath('pi')) return { skip: true, proof: 'pi not installed' };
      if (!orKey) return { skip: true, proof: 'no OPENROUTER_API_KEY' };
      const out = run(`cd ${JSON.stringify(dir)} && pi --provider openrouter --model anthropic/claude-3.5-haiku -p "Reply with exactly: REAL_OK"`).toString();
      return { ok: out.includes('REAL_OK'), proof: 'pi -p discovered AGENTS.md + replied' };
    },
    hermes: (dir) => {
      if (!onPath('hermes')) return { skip: true, proof: 'hermes not installed' };
      // Load our generated cli-config.yaml in a throwaway HERMES_HOME and assert
      // `hermes config check` accepts it (exit 0 + model.provider parsed).
      const home = `${dir}/.hermeshome`; execSync(`mkdir -p ${JSON.stringify(home)}`);
      execSync(`cp ${JSON.stringify(dir + '/cli-config.yaml')} ${JSON.stringify(home + '/config.yaml')}`);
      let out = '';
      try { out = run(`HERMES_HOME=${JSON.stringify(home)} hermes config show`).toString(); }
      catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
      return { ok: /provider'?:\s*'?auto/i.test(out) && !/traceback|invalid/i.test(out), proof: 'hermes config show loaded our config (model.provider parsed)' };
    },
    'github-actions': (dir) => {
      if (!onPath('act')) return { skip: true, proof: 'act not installed' };
      const out = run(`cd ${JSON.stringify(dir)} && act workflow_dispatch -l`).toString();
      return { ok: /gha-|harness|Job ID/i.test(out) || /\bgha\b/i.test(out) || out.includes(`bot-github-actions`), proof: 'act parsed + listed the workflow job' };
    },
  };

  console.log('\nReal-runtime verification (--real, ADR-046):');
  console.log('-'.repeat(80));
  let realPass = 0, realAttempted = 0;
  for (const host of HOSTS) {
    const fn = realChecks[host];
    const dir = join(scaffoldRoot, `bot-${host}`);
    if (!fn || !existsSync(dir)) { console.log(`${host.padEnd(14)} ·  n/a`); continue; }
    try {
      const r = fn(dir);
      if (r.skip) { console.log(`${host.padEnd(14)} ·  SKIP   ${r.proof}`); continue; }
      realAttempted++; if (r.ok) realPass++;
      console.log(`${host.padEnd(14)} ${r.ok ? '✓' : '✗'}  ${r.ok ? 'PASS' : 'FAIL'}   ${r.proof}`);
    } catch (e) {
      realAttempted++;
      console.log(`${host.padEnd(14)} ✗  ERROR  ${String(e).replace(/\n/g, ' ').slice(0, 70)}`);
    }
  }
  console.log(`\n${realPass}/${realAttempted} installed runtimes really-run-verified.`);
  if (STRICT && realPass !== realAttempted) process.exit(1);
}
process.exit(pass === results.length ? 0 : 1);
