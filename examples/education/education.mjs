#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// examples/education/education.mjs
//
// Runnable demo of the iter-80 vertical:education vertical: scaffold
// a tutoring-pod harness, validate it, and surface the 4-agent shape
// (tutor / explainer / quiz-master / grader) + the 2 commands
// (teach-next / mastery-report) so a contributor can see the new
// vertical work end-to-end without invoking npm or pulling network.
//
// Matches the iter-32 quickstart + iter-40 federation pattern.
//
// Run with:
//   node examples/education/education.mjs              # default: claude-code
//   node examples/education/education.mjs --host=codex # any of 6 hosts
//   node examples/education/education.mjs --keep       # don't auto-clean

import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { scaffold } from '../../packages/create-agent-harness/dist/index.js';
import { validate } from '../../packages/create-agent-harness/dist/validate.js';

const HOSTS = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'];

function parseFlag(name, fallback) {
  const arg = process.argv.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : fallback;
}

async function walk(dir, prefix = '') {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...await walk(full, rel));
    } else {
      const st = await stat(full);
      out.push({ rel, size: st.size });
    }
  }
  return out;
}

async function main() {
  const host = parseFlag('host', 'claude-code');
  const keep = process.argv.includes('--keep');

  if (!HOSTS.includes(host)) {
    process.stderr.write(`error: --host=${host} unsupported. Pick one of: ${HOSTS.join(', ')}\n`);
    process.exit(2);
  }

  process.stderr.write('# vertical:education — runnable demo\n');
  process.stderr.write(`#   host: ${host}\n`);
  process.stderr.write('#   template: vertical:education (iter 80)\n\n');

  const t0 = Date.now();
  const dir = await mkdtemp(join(tmpdir(), `ahg-edu-${host}-`));

  try {
    // 1. Scaffold
    const stepStart = Date.now();
    const r = await scaffold({
      name: 'my-tutor',
      template: 'vertical:education',
      host,
      description: 'iter-80 demo — mastery-based tutoring pod',
      targetDir: dir,
      force: true,
      generatorVersion: '0.1.0',
    });
    const scaffoldMs = Date.now() - stepStart;
    process.stderr.write(`[1/3] scaffold → ${r.paths.length} files in ${scaffoldMs}ms\n`);

    // 2. Surface the 4-agent + 2-command shape
    const files = await walk(dir);
    const agents = files.filter(f => f.rel.startsWith('src/agents/') && f.rel.endsWith('.ts'));
    const commands = files.filter(f => f.rel.startsWith('.claude/commands/') || f.rel.startsWith('.codex/commands/'));
    const skills = files.filter(f => f.rel.includes('/skills/') && f.rel.endsWith('SKILL.md'));

    process.stderr.write(`\n[2/3] shape:\n`);
    process.stderr.write(`        agents:   ${agents.map(a => a.rel.split('/').at(-1).replace('.ts', '')).join(', ')}\n`);
    process.stderr.write(`        commands: ${commands.map(c => c.rel.split('/').at(-1).replace('.md', '')).join(', ')}\n`);
    process.stderr.write(`        skills:   ${skills.map(s => s.rel.split('/').at(-2)).join(', ')}\n`);

    // Sanity-check the 4 expected agents
    const expected = ['tutor', 'explainer', 'quiz-master', 'grader'];
    const have = new Set(agents.map(a => a.rel.split('/').at(-1).replace('.ts', '')));
    const missing = expected.filter(n => !have.has(n));
    if (missing.length > 0) {
      process.stderr.write(`\nFAIL: missing agents: ${missing.join(', ')}\n`);
      process.exit(1);
    }

    // 3. Validate
    const v = await validate([dir, '--skip-gcp']);
    const healthy = v.lines.join('\n').includes('Result: HEALTHY');
    if (!healthy) {
      process.stderr.write(`\n[3/3] validate → FAIL\n${v.lines.join('\n')}\n`);
      process.exit(v.code);
    }
    process.stderr.write(`[3/3] validate → HEALTHY (release-ready)\n`);

    const totalMs = Date.now() - t0;
    process.stderr.write(`\n[education] DONE in ${totalMs}ms — try:\n`);
    process.stderr.write(`             cd ${dir}\n`);
    process.stderr.write(`             cat src/agents/tutor.ts   # the system prompt that drives mastery-aware tutoring\n`);
    process.stderr.write(`             cat .claude/commands/mastery-report.md   # learner-progress command\n`);

    if (!keep) {
      await rm(dir, { recursive: true, force: true });
    } else {
      process.stderr.write(`\n[education] --keep — left at ${dir}\n`);
    }
  } catch (err) {
    process.stderr.write(`\n[education] FAIL: ${err?.stack ?? err}\n`);
    if (!keep) await rm(dir, { recursive: true, force: true });
    process.exit(1);
  }
}

main();
