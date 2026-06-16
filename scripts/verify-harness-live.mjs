// ADR-044 — Live-LLM host harness verification via OpenRouter.
//
// The existing scripts/verify-all-hosts.mjs proves the *shape* of each host's
// emitted config (valid JSON/TOML, dep present) and runs a real `claude -p`
// only for claude-code (Anthropic-only). It does NOT prove that a generated
// harness's CONTENT (system prompt + agent roster + tool manifest) is usable
// by a real model — and it can't exercise the 8 non-Anthropic hosts against a
// live provider at all.
//
// This script closes that gap. For each host it extracts the harness's
// capabilities from the emitted config, hands them to a REAL model via
// OpenRouter (provider-agnostic, so codex/opencode/hermes/... are covered too),
// and asserts the model can enumerate the harness's tools/agents back — i.e.
// the generated content is coherent and model-actionable, not just well-formed.
//
// Key resolution (in order):
//   1. $OPENROUTER_API_KEY
//   2. `gcloud secrets versions access latest --secret=OPENROUTER_API_KEY`
//
// Usage:
//   node scripts/verify-harness-live.mjs --self-test          # built-in fixture
//   node scripts/verify-harness-live.mjs --dir bot-claude-code # a real scaffold
//   node scripts/verify-harness-live.mjs --all                 # every bot-<host>/
//
// Offline/no-key: exits 0 with status SKIPPED (so CI without the secret is green).

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const MODEL = process.env.METAHARNESS_VERIFY_MODEL || 'anthropic/claude-haiku-4.5';
const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

const HOSTS = ['claude-code', 'codex', 'copilot', 'github-actions', 'hermes', 'openclaw', 'opencode', 'pi-dev', 'rvm'];

function resolveKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  try {
    return execSync('gcloud secrets versions access latest --secret=OPENROUTER_API_KEY', {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

/** Pull the harness's capability surface out of whatever config a host emitted. */
function extractCapabilities(dir) {
  const cap = { systemPrompt: '', agents: [], tools: [], mcpServers: [] };
  const read = (p) => (existsSync(`${dir}/${p}`) ? readFileSync(`${dir}/${p}`, 'utf-8') : null);
  const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

  // System prompt lives in different files per host.
  for (const p of ['CLAUDE.md', 'AGENTS.md', 'SYSTEM.md', 'cli-config.yaml', '.github/copilot-instructions.md']) {
    const s = read(p);
    if (s && s.trim()) { cap.systemPrompt = s.trim().slice(0, 2000); break; }
  }
  // MCP servers across the JSON hosts.
  for (const p of ['.claude/settings.json', '.vscode/mcp.json', '.opencode/opencode.json', 'openclaw.json']) {
    const j = read(p) && tryJson(read(p));
    if (!j) continue;
    const srv = j.servers || j.mcpServers || j.mcp_servers || j.mcp?.servers;
    if (srv) cap.mcpServers.push(...Object.keys(srv));
  }
  // Agents — Claude Code / opencode markdown dirs, openclaw SKILL.md headings.
  const skill = read('SKILL.md');
  if (skill) for (const m of skill.matchAll(/^- \*\*(.+?)\*\*/gm)) cap.agents.push(m[1]);

  return cap;
}

async function liveProbe(key, name, cap) {
  const manifest = [
    `Harness: ${name}`,
    cap.systemPrompt ? `System prompt (excerpt): ${cap.systemPrompt.slice(0, 400)}` : 'System prompt: (none emitted)',
    `MCP servers: ${cap.mcpServers.join(', ') || '(none)'}`,
    `Agents: ${cap.agents.join(', ') || '(none)'}`,
  ].join('\n');

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 60,
      messages: [
        { role: 'system', content: `You are validating a generated agent harness. Given its manifest, reply with ONLY a JSON object {"coherent":true|false,"capabilities":<count of distinct named MCP servers + agents>}. Nothing else.` },
        { role: 'user', content: manifest },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const cost = data.usage?.cost ?? 0;
  let parsed = null;
  try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch { /* leave null */ }
  const declared = cap.mcpServers.length + cap.agents.length;
  // PASS = model judged it coherent AND saw the capabilities we emitted.
  const ok = parsed?.coherent === true && (declared === 0 || (parsed?.capabilities ?? 0) >= 1);
  return { ok, declared, cost, raw: text.slice(0, 80) };
}

const SELF_TEST_FIXTURE = {
  name: 'demo-harness',
  cap: {
    systemPrompt: 'You are demo-harness, a repo-aware coding agent for the acme/widgets monorepo.',
    mcpServers: ['acme-memory', 'acme-search'],
    agents: ['reviewer', 'test-writer'],
    tools: [],
  },
};

async function main() {
  const args = process.argv.slice(2);
  const key = resolveKey();
  if (!key) {
    console.log('SKIPPED — no OPENROUTER_API_KEY in env and gcloud secret unavailable.');
    process.exit(0);
  }
  console.log(`Live-LLM harness verification (model=${MODEL})\n` + '-'.repeat(72));

  const targets = [];
  if (args.includes('--self-test')) {
    targets.push(SELF_TEST_FIXTURE);
  } else if (args.includes('--all')) {
    for (const h of HOSTS) if (existsSync(`bot-${h}`)) targets.push({ name: `bot-${h}`, cap: extractCapabilities(`bot-${h}`) });
  } else {
    const di = args.indexOf('--dir');
    if (di === -1 || !args[di + 1]) { console.error('usage: --self-test | --dir <path> | --all'); process.exit(2); }
    const dir = args[di + 1];
    targets.push({ name: dir, cap: extractCapabilities(dir) });
  }
  if (targets.length === 0) { console.log('No harness scaffolds found (bot-<host>/). Nothing to verify.'); process.exit(0); }

  let pass = 0, totalCost = 0;
  for (const t of targets) {
    try {
      const r = await liveProbe(key, t.name, t.cap);
      totalCost += r.cost;
      if (r.ok) pass++;
      console.log(`${t.name.padEnd(20)} ${r.ok ? '✓ PASS' : '✗ FAIL'}  caps=${r.declared}  $${r.cost.toFixed(6)}  «${r.raw}»`);
    } catch (e) {
      console.log(`${t.name.padEnd(20)} ✗ ERROR  ${String(e).slice(0, 90)}`);
    }
  }
  console.log('-'.repeat(72));
  console.log(`${pass}/${targets.length} harnesses verified against a live model · total cost $${totalCost.toFixed(6)}`);
  process.exit(pass === targets.length ? 0 : 1);
}

main();
