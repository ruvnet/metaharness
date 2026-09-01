#!/usr/bin/env node
// Every test in this repo must be reachable by a runner, or be listed as a
// deliberate exclusion with a reason. See #194.
//
// The failure this exists to stop is not "a test is broken" — it is "a test is
// never run, and both runners still report green and complete". Two mechanisms
// produce it here, and neither leaves a trace in the output:
//
//   npm test  ->  `npm run -ws --if-present test`
//                 `-ws` excludes the repo root, and `--if-present` makes
//                 "no test script" indistinguishable from "tests passed".
//   cargo     ->  `cargo test --workspace`
//                 covers workspace MEMBERS only; a nested crate with its own
//                 [workspace] is silently outside it.
//
// draco.yml already carries a note about the same class, from the last time it
// bit: "An explicit list silently drifts: arm tests existed but CI never ran
// them." This generalises that fix instead of repeating it per-workflow.
//
// The allowlist is a RATCHET, not a suppression list. It is seeded with what is
// already unreached today so this passes on main; anything NEW fails. Entries
// require a non-empty reason — an allowlist without reasons is a mute button,
// and the next reader cannot tell a decision from an oversight.
//
// Zero dependencies. Run: node scripts/check-runner-coverage.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = join(ROOT, 'scripts', 'runner-coverage-allowlist.json');
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', '.git', 'pkg', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT);
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// ── what `npm test` reaches ────────────────────────────────────────────────
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const wsGlobs = rootPkg.workspaces ?? [];
const inWorkspace = (p) => wsGlobs.some((g) => {
  if (!g.endsWith('/*')) return rel(p) === g || rel(p).startsWith(g + '/');
  const base = g.slice(0, -2);
  const r = rel(p);
  return r.startsWith(base + '/') && r.slice(base.length + 1).includes('/') === false
    ? true
    : r.startsWith(base + '/');
});

/** Workspace dirs npm will visit, and whether each declares a `test` script. */
const workspaces = [];
for (const f of files) {
  if (!f.endsWith(`${sep}package.json`)) continue;
  const dir = dirname(f);
  if (dir === ROOT) continue;
  const r = rel(dir);
  const matched = wsGlobs.some((g) => {
    const base = g.endsWith('/*') ? g.slice(0, -2) : g;
    if (!g.endsWith('/*')) return r === base;
    return r.startsWith(base + '/') && !r.slice(base.length + 1).includes('/');
  });
  let pkg;
  try { pkg = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
  workspaces.push({ dir, rel: r, matched, hasTest: Boolean(pkg.scripts?.test), name: pkg.name });
}

// ── test files explicitly named by a workflow step ─────────────────────────
const explicit = new Set();
const wfDir = join(ROOT, '.github', 'workflows');
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir)) {
    const body = readFileSync(join(wfDir, f), 'utf8');
    // Two invocation forms are both in use here and BOTH count as reached.
    // Matching only the first produced four false positives on the first run —
    // ci.yml's "SOTA integrity-attestation gate" runs its suites under plain
    // `node`, not vitest. A checker that cries wolf gets ignored, which is
    // worse than the gap it closes.
    for (const re of [
      /vitest\s+run\s+([^\s\\|&;]+\.(?:test|spec)\.[cm]?[jt]sx?)/g,
      /\bnode\s+([^\s\\|&;]+\.(?:test|spec)\.[cm]?[jt]sx?)/g,
    ]) {
      for (const m of body.matchAll(re)) explicit.add(m[1].replace(/^\.\//, ''));
    }
  }
}

// A workflow job can also run a sub-project's own suite via
// `working-directory: <dir>` + `npm test` — pages.yml does exactly that for
// apps/web-ui, which is outside the `workspaces` globs and would otherwise read
// as 9 unreached files. Deliberately COARSE (workflow-level, not job-level):
// erring toward "covered" costs a missed gap, erring the other way blocks CI on
// correct code, and only one of those two makes people delete the check.
const coveredDirs = new Set();
if (existsSync(wfDir)) {
  for (const f of readdirSync(wfDir)) {
    const body = readFileSync(join(wfDir, f), 'utf8');
    if (!/\bnpm (?:run )?test\b/.test(body)) continue;
    for (const m of body.matchAll(/working-directory:\s*['"]?([^'"\s]+)/g)) {
      coveredDirs.add(m[1].replace(/^\.\//, '').replace(/\/$/, ''));
    }
  }
}

// ── cargo workspace membership ─────────────────────────────────────────────
const cargoRoot = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8');
const membersBlock = cargoRoot.match(/members\s*=\s*\[([\s\S]*?)\]/);
const members = membersBlock ? [...membersBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];

// ── collect the findings ───────────────────────────────────────────────────
const TESTFILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const unreachedTests = [];
for (const f of files) {
  if (!TESTFILE.test(f)) continue;
  const r = rel(f);
  if (explicit.has(r)) continue;
  if ([...coveredDirs].some((d) => r.startsWith(d + '/'))) continue;
  const owner = workspaces.find((w) => r.startsWith(w.rel + '/'));
  if (owner && owner.matched && owner.hasTest) continue;   // `npm test` runs it
  unreachedTests.push({
    path: r,
    why: !owner
      ? 'at the repo root — `npm run -ws` excludes the root package'
      : !owner.matched
        ? `in ${owner.rel}, which no \`workspaces\` glob matches (${JSON.stringify(wsGlobs)})`
        : `in ${owner.rel}, which has no \`test\` script (\`--if-present\` skips it silently)`,
  });
}

const unreachedCrates = [];
for (const f of files) {
  if (!f.endsWith(`${sep}Cargo.toml`)) continue;
  const dir = dirname(f);
  if (dir === ROOT) continue;
  const r = rel(dir);
  if (members.includes(r)) continue;
  const rs = walk(dir).filter((x) => x.endsWith('.rs'));
  let n = 0;
  for (const x of rs) n += (readFileSync(x, 'utf8').match(/#\[(?:tokio::)?test\]/g) ?? []).length;
  if (n > 0) unreachedCrates.push({ path: r, tests: n });
}

// ── compare against the allowlist ──────────────────────────────────────────
let allow = { tests: {}, crates: {} };
if (existsSync(ALLOWLIST)) allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));

const problems = [];
const reasonless = [];
for (const t of unreachedTests) {
  const r = allow.tests?.[t.path];
  if (r === undefined) problems.push(`test never run: ${t.path}\n      ${t.why}`);
  else if (!String(r).trim()) reasonless.push(`tests["${t.path}"]`);
}
for (const c of unreachedCrates) {
  const r = allow.crates?.[c.path];
  if (r === undefined) problems.push(`crate never run: ${c.path} (${c.tests} #[test] fns)\n      not a member of the root cargo workspace`);
  else if (!String(r).trim()) reasonless.push(`crates["${c.path}"]`);
}

// A stale entry is a mute button for something that no longer exists.
const liveTests = new Set(unreachedTests.map((t) => t.path));
const liveCrates = new Set(unreachedCrates.map((c) => c.path));
for (const k of Object.keys(allow.tests ?? {})) {
  if (!liveTests.has(k)) problems.push(`stale allowlist entry: tests["${k}"] is now reachable (or gone) — drop it`);
}
for (const k of Object.keys(allow.crates ?? {})) {
  if (!liveCrates.has(k)) problems.push(`stale allowlist entry: crates["${k}"] is now reachable (or gone) — drop it`);
}
for (const r of reasonless) problems.push(`allowlist entry with an empty reason: ${r}`);

// ── report ────────────────────────────────────────────────────────────────
const allowedTests = unreachedTests.length - problems.filter((p) => p.startsWith('test never run')).length;
console.log(`runner coverage:`);
console.log(`  workspaces npm test visits : ${workspaces.filter((w) => w.matched && w.hasTest).length}`);
console.log(`  cargo workspace members    : ${members.length}`);
console.log(`  test files not reached     : ${unreachedTests.length} (${allowedTests} allowlisted)`);
console.log(`  crates not reached         : ${unreachedCrates.length}`);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(`\nEither wire it into a runner, or add it to
${rel(ALLOWLIST)} with a reason saying why it is deliberately not run.`);
  process.exit(1);
}
console.log(`\nok — every test is reached by a runner or allowlisted with a reason`);
