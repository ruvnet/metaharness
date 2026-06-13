#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/release-notes.mjs — extract a CHANGELOG slice as release notes.
//
// Two modes:
//   1. By iter range:  `--from-iter=30 --to-iter=35`
//   2. By version:     `--version=0.2.0` (extracts everything since the
//                      previous version's first iter)
//   3. By tags:        `--since=v0.1.0 --until=HEAD` (uses git tag dates
//                      to pick the iter window from CHANGELOG)
//
// Default (no flags): everything between the last released tag and HEAD.
//
// Output is GitHub-flavoured markdown suitable for piping into
//   gh release create v0.2.0 --notes-file -

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const ROOT = process.cwd();
const args = process.argv.slice(2);

function arg(name) { return args.find(a => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length); }
function flag(name) { return args.includes(`--${name}`); }
function log(tag, msg) { process.stderr.write(`[release-notes] ${tag}: ${msg}\n`); }

/**
 * Parse the CHANGELOG into a list of {iter, kind, date, body} sections.
 * Section headers look like:  ### Added — Iter 32 (2026-06-13)
 */
export function parseChangelog(text) {
  const sections = [];
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    const m = line.match(/^###\s+(Added|Fixed|Changed|Removed|Security)\s+—\s+Iter\s+(\d+)\s+\((\d{4}-\d{2}-\d{2})\)/);
    if (m) {
      if (current) sections.push(current);
      current = { kind: m[1], iter: Number(m[2]), date: m[3], body: [] };
      continue;
    }
    if (current && line.startsWith('## ')) {
      sections.push(current);
      current = null;
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Render a list of sections as a GitHub release notes body.
 */
export function renderNotes(sections, opts = {}) {
  if (sections.length === 0) {
    return '_No CHANGELOG entries in the selected range._\n';
  }
  const minIter = Math.min(...sections.map(s => s.iter));
  const maxIter = Math.max(...sections.map(s => s.iter));
  const lines = [];
  if (opts.title) lines.push(opts.title, '');
  lines.push(`Iters ${minIter}–${maxIter} • ${sections.length} entries`, '');
  // Group by kind so Added / Fixed / etc. are clustered
  const kinds = ['Added', 'Fixed', 'Changed', 'Removed', 'Security'];
  for (const kind of kinds) {
    const ours = sections.filter(s => s.kind === kind).sort((a, b) => a.iter - b.iter);
    if (ours.length === 0) continue;
    lines.push(`## ${kind}`, '');
    for (const s of ours) {
      lines.push(`### Iter ${s.iter} — ${s.date}`);
      // Strip leading blank lines, trim trailing blanks
      const body = s.body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      lines.push(body, '');
    }
  }
  return lines.join('\n') + '\n';
}

async function gitTagExists(tag) {
  try {
    await execFile('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: ROOT });
    return true;
  } catch { return false; }
}

async function previousReleasedTag() {
  try {
    const r = await execFile('git', ['describe', '--tags', '--abbrev=0', 'HEAD'], { cwd: ROOT });
    return r.stdout.trim();
  } catch { return null; }
}

async function tagDateUnix(tag) {
  try {
    const r = await execFile('git', ['log', '-1', '--format=%ct', tag], { cwd: ROOT });
    return Number(r.stdout.trim());
  } catch { return null; }
}

async function main() {
  const changelog = await readFile(join(ROOT, 'CHANGELOG.md'), 'utf-8');
  const all = parseChangelog(changelog);
  if (all.length === 0) {
    log('FAIL', 'no CHANGELOG sections matched the `### Added/Fixed — Iter N (YYYY-MM-DD)` pattern');
    process.exit(1);
  }
  log('INFO', `parsed ${all.length} CHANGELOG sections (iters ${all.at(-1).iter}–${all[0].iter})`);

  let selected = all;
  const fromIter = arg('from-iter');
  const toIter = arg('to-iter');
  const since = arg('since');
  const until = arg('until') ?? 'HEAD';
  const versionArg = arg('version');

  if (fromIter || toIter) {
    const lo = fromIter ? Number(fromIter) : 0;
    const hi = toIter ? Number(toIter) : Infinity;
    selected = all.filter(s => s.iter >= lo && s.iter <= hi);
    log('INFO', `iter range [${lo}, ${hi}]: ${selected.length} entries`);
  } else if (since) {
    if (!(await gitTagExists(since))) {
      log('FAIL', `tag ${since} doesn't exist`);
      process.exit(1);
    }
    const sinceUnix = await tagDateUnix(since);
    const untilUnix = until === 'HEAD' ? Math.floor(Date.now() / 1000) : await tagDateUnix(until);
    if (sinceUnix === null) {
      log('FAIL', `couldn't resolve date for ${since}`);
      process.exit(1);
    }
    // Filter sections whose date falls in (sinceUnix, untilUnix]
    selected = all.filter(s => {
      const t = Math.floor(new Date(s.date + 'T00:00:00Z').getTime() / 1000);
      return t > sinceUnix && t <= (untilUnix ?? Infinity);
    });
    log('INFO', `since ${since}, until ${until}: ${selected.length} entries`);
  } else if (versionArg) {
    // Best-effort: filter to entries that haven't shipped under an earlier
    // tag. Without a more sophisticated CHANGELOG → version mapping, this
    // defaults to all sections since the last released tag.
    const prev = await previousReleasedTag();
    if (prev) {
      const prevUnix = await tagDateUnix(prev);
      selected = all.filter(s => {
        const t = Math.floor(new Date(s.date + 'T00:00:00Z').getTime() / 1000);
        return t > (prevUnix ?? 0);
      });
      log('INFO', `version ${versionArg} (since ${prev}): ${selected.length} entries`);
    }
  } else {
    // Default: since the last released tag.
    const prev = await previousReleasedTag();
    if (prev) {
      const prevUnix = await tagDateUnix(prev);
      selected = all.filter(s => {
        const t = Math.floor(new Date(s.date + 'T00:00:00Z').getTime() / 1000);
        return t > (prevUnix ?? 0);
      });
      log('INFO', `default since ${prev}: ${selected.length} entries`);
    } else {
      log('INFO', `no previous tag found — using ALL ${all.length} entries`);
    }
  }

  const titleVersion = versionArg ? `v${versionArg}` : '';
  const title = titleVersion ? `# Release ${titleVersion}` : '';
  const body = renderNotes(selected, { title });
  process.stdout.write(body);
}

main().catch(err => {
  log('FAIL', err?.stack ?? err);
  process.exit(1);
});
