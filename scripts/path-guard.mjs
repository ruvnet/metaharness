#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/path-guard.mjs — cross-platform path-handling regression guard.
//
// Pins the lessons from earlier in development:
//
//   1. `/tmp` does NOT resolve on Windows. Source must use os.tmpdir().
//   2. Path joins in test fixtures must use path.join, not string concat.
//   3. Manifest keys (per-file fingerprints, etc.) must be POSIX-normalised
//      so the same harness scaffolded on Windows and Linux hashes the same.
//   4. Windows-native paths (C:\Users\...) must round-trip through file
//      operations without corruption.
//
// Greps the source tree and asserts none of the known bad patterns are
// present in production code (tests + fixtures excluded; comments
// excluded). Runs on every platform in CI; fails loudly when a regression
// slips in.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const SCAN_DIRS = ['packages', 'crates', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', 'pkg', '__tests__', 'tests',
  'templates', '.git', 'coverage',
]);
const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.rs']);

const BAD_PATTERNS = [
  {
    re: /['"`]\/tmp\//,
    msg: '`/tmp/` does not resolve on Windows — use `os.tmpdir()` + `path.join(...)`',
  },
  {
    re: /[^a-zA-Z]\/tmp([^a-zA-Z]|$)/,
    msg: 'unquoted `/tmp` reference — use os.tmpdir()',
    exclude: /^\s*\/\//, // skip line comments
  },
  {
    re: /['"`]C:\\\\/,
    msg: 'hardcoded Windows-style `C:\\\\...` path — derive at runtime',
  },
  {
    re: /['"`]\/Users\//,
    msg: 'hardcoded macOS-style `/Users/...` path — derive at runtime',
  },
  {
    re: /['"`]\/home\//,
    msg: 'hardcoded Linux-style `/home/...` path — derive at runtime',
  },
];

const offenders = [];

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && SCAN_EXT.has(extname(e.name))) {
      yield full;
    }
  }
}

function isComment(line, ext) {
  const trimmed = line.trim();
  if (ext === '.rs') return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#');
}

for (const top of SCAN_DIRS) {
  const path = join(root, top);
  try { statSync(path); } catch { continue; }
  for (const file of walk(path)) {
    const ext = extname(file);
    const text = readFileSync(file, 'utf-8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isComment(line, ext)) continue;
      for (const p of BAD_PATTERNS) {
        if (p.exclude && p.exclude.test(line)) continue;
        if (p.re.test(line)) {
          const rel = file.slice(root.length + 1).split(sep).join(posix.sep);
          offenders.push(`${rel}:${i + 1}  ${p.msg}\n    > ${line.trim()}`);
        }
      }
    }
  }
}

// Self-test: the guard itself MUST behave correctly across platforms.
// Verify os.tmpdir() returns something usable.
const t = tmpdir();
if (!t || t.length === 0) {
  console.error('path-guard self-test failed: os.tmpdir() returned empty');
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('Path-handling guard found regressions:');
  for (const o of offenders) console.error('  ' + o);
  console.error('');
  console.error(`Total: ${offenders.length} regression(s).`);
  console.error('Replace hardcoded paths with os.tmpdir() + path.join(...).');
  process.exit(1);
}

console.log(`path-guard: clean (scanned ${SCAN_DIRS.join(', ')} on ${process.platform})`);
