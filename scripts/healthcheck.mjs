#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// scripts/healthcheck.mjs — user-facing daily-driver health check.
//
// Distinct from scripts/preflight.mjs (which is release-specific and
// runs every gate publish.yml would run, ~30s wall time). Healthcheck
// is the "did I break anything?" command — fast (~3s), per-check
// PASS / WARN / FAIL, no I/O beyond reading files.
//
// Checks (in order, all soft-skip on unmet preconditions):
//   1. version coherence       all 11 packages + plugin.json + Cargo same version
//   2. plugin.json shape       required fields, kebab-case name, etc.
//   3. codex skills present    >=4 skills, each has skill.toml + README.md
//   4. workflows reference     scripts/<X>.mjs references resolve
//   5. path-guard              source clean of hardcoded /tmp + C:\ + /Users
//   6. examples runnable       quickstart + federation scripts exist
//
// Run as:
//   node scripts/healthcheck.mjs                # all checks
//   node scripts/healthcheck.mjs --json         # machine-readable output
//   node scripts/healthcheck.mjs --check=plugin # run only one check
//   node scripts/healthcheck.mjs --probe-pages  # opt-in HTTP probe of the live Studio

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const PROBE_PAGES = args.includes('--probe-pages');
const onlyCheck = args.find(a => a.startsWith('--check='))?.slice('--check='.length);

const STUDIO_URL = 'https://ruvnet.github.io/metaharness/';

const CHECKS = {
  async version() {
    const root = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf-8'));
    const wantedVersion = root.version;
    const drifts = [];
    // packages/*
    const packages = await readdir(join(ROOT, 'packages'), { withFileTypes: true });
    // iter 149: the published CLI (metaharness) + its library wrapper
    // (@ruvnet/agent-harness-generator) version INDEPENDENTLY of the
    // @metaharness/* workspace packages — they ship to npm on their own semver
    // cadence. Exclude them from the workspace-coherence check.
    // @metaharness/router is likewise a standalone published library on its own
    // semver (0.2.0 → 0.3.x as its API grows — ADR-043 native backend), not
    // lock-stepped to the monorepo version.
    // @metaharness/kernel ships on its own semver (it carries the native/wasm
    // build cadence — 0.1.0 js-only → 0.1.2 with the shipped wasm backend,
    // GH #20) and the host adapters version with it (bumped to 0.1.2 so their
    // `@metaharness/kernel` dep can caret-resolve the wasm kernel — they were
    // already published off the monorepo cadence at 0.1.1). Treat both as
    // independently-versioned, like metaharness/router/lib.
    // @metaharness/darwin (Darwin Mode) is a standalone published library on its
    // own results-driven semver — it ships to npm whenever a measured benchmark
    // milestone lands (0.1.0 → 0.2.8 across the SWE-bench arc), independent of the
    // monorepo version. Treat it like metaharness/router/kernel.
    const INDEPENDENT = new Set([
      'metaharness',
      '@ruvnet/agent-harness-generator',
      '@metaharness/router',
      '@metaharness/darwin',
      // @metaharness/projects (Darwin Shield / defensive zero-day harness, ADR-155+)
      // is a standalone published library on its own semver, like @metaharness/darwin.
      '@metaharness/projects',
      // @metaharness/redblue (defensive red/blue adversarial testing, ADR-197) ships
      // on its own semver (0.1.2 → 0.1.4 across the HackerOne-integration arc).
      '@metaharness/redblue',
      // @metaharness/weight-eft (evolutionary fine-tuning, ADR-198) likewise —
      // published 0.1.1 with the umbrella-CLI wiring.
      '@metaharness/weight-eft',
      // @metaharness/jujutsu (version-control-for-agents + agenticow bridge, ADR-202)
      // likewise — npm 0.2.0 was published on its own cadence.
      '@metaharness/jujutsu',
      // @metaharness/flywheel (the reusable promotion-loop engine) is a standalone
      // published library on its own semver (published 0.1.1 with the umbrella-CLI
      // wiring, like weight-eft/redblue).
      '@metaharness/flywheel',
      // @metaharness/evals-hle (HLE benchmark adapter for the flywheel, ADR-233) is a
      // standalone published adapter on its own semver — not core, not umbrella-bundled.
      '@metaharness/evals-hle',
      // @metaharness/evals-extract (structured-extraction benchmark adapter for the
      // flywheel) is likewise a standalone published adapter on its own semver.
      '@metaharness/evals-extract',
      '@metaharness/kernel',
      '@metaharness/host-claude-code',
      '@metaharness/host-codex',
      '@metaharness/host-copilot',
      '@metaharness/host-github-actions',
      '@metaharness/host-hermes',
      '@metaharness/host-openclaw',
      '@metaharness/host-opencode',
      '@metaharness/host-pi-dev',
      '@metaharness/host-rvm',
    ]);
    for (const p of packages) {
      if (!p.isDirectory()) continue;
      const pkgPath = join(ROOT, 'packages', p.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (INDEPENDENT.has(pkg.name)) continue;
      if (pkg.version && pkg.version !== wantedVersion) {
        drifts.push(`${pkg.name}: ${pkg.version} (expected ${wantedVersion})`);
      }
    }
    // plugin.json
    const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json');
    if (existsSync(pluginPath)) {
      const plugin = JSON.parse(await readFile(pluginPath, 'utf-8'));
      if (plugin.version !== wantedVersion) {
        drifts.push(`.claude-plugin/plugin.json: ${plugin.version}`);
      }
    }
    // Cargo workspace
    const cargoPath = join(ROOT, 'Cargo.toml');
    if (existsSync(cargoPath)) {
      const cargo = await readFile(cargoPath, 'utf-8');
      const m = cargo.match(/\[workspace\.package\][\s\S]*?\bversion\s*=\s*"([^"]+)"/);
      if (m && m[1] !== wantedVersion) drifts.push(`Cargo.toml workspace: ${m[1]}`);
    }
    if (drifts.length === 0) return { tag: 'PASS', detail: `all sources at ${wantedVersion}` };
    return { tag: 'FAIL', detail: `${drifts.length} drifts: ${drifts.slice(0, 3).join('; ')}` };
  },

  async plugin() {
    const path = join(ROOT, '.claude-plugin', 'plugin.json');
    if (!existsSync(path)) return { tag: 'SKIP', detail: 'no .claude-plugin/plugin.json' };
    const plugin = JSON.parse(await readFile(path, 'utf-8'));
    const probs = [];
    if (!plugin.name?.match(/^[a-z0-9-]+$/)) probs.push('name not kebab-case');
    if (!plugin.description || plugin.description.length < 30) probs.push('description < 30 chars');
    if (!plugin.author?.id) probs.push('author.id missing');
    if (!Array.isArray(plugin.skills) || plugin.skills.length === 0) probs.push('empty skills[]');
    if (!Array.isArray(plugin.commands) || plugin.commands.length === 0) probs.push('empty commands[]');
    if (probs.length === 0) {
      return { tag: 'PASS', detail: `${plugin.skills.length} skills, ${plugin.commands.length} commands` };
    }
    return { tag: 'FAIL', detail: probs.join('; ') };
  },

  async codex() {
    const dir = join(ROOT, '.codex', 'skills');
    if (!existsSync(dir)) return { tag: 'SKIP', detail: 'no .codex/skills/' };
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    const probs = [];
    for (const e of skillDirs) {
      const sd = join(dir, e.name);
      if (!existsSync(join(sd, 'skill.toml'))) probs.push(`${e.name}/skill.toml missing`);
      if (!existsSync(join(sd, 'README.md'))) probs.push(`${e.name}/README.md missing`);
    }
    if (skillDirs.length < 4) probs.push(`only ${skillDirs.length} skills (want >=4)`);
    if (probs.length === 0) return { tag: 'PASS', detail: `${skillDirs.length} skills with skill.toml + README` };
    return { tag: 'FAIL', detail: probs.slice(0, 3).join('; ') };
  },

  async workflows() {
    const dir = join(ROOT, '.github', 'workflows');
    if (!existsSync(dir)) return { tag: 'SKIP', detail: 'no .github/workflows/' };
    const yamls = (await readdir(dir)).filter(f => /\.ya?ml$/.test(f));
    const missing = [];
    for (const f of yamls) {
      const text = await readFile(join(dir, f), 'utf-8');
      const re = /node scripts\/([\w.-]+\.m?js)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const target = join(ROOT, 'scripts', m[1]);
        if (!existsSync(target)) missing.push(`${f}: scripts/${m[1]}`);
      }
    }
    if (missing.length === 0) return { tag: 'PASS', detail: `${yamls.length} workflows, all script refs resolve` };
    return { tag: 'FAIL', detail: missing.slice(0, 3).join('; ') };
  },

  async pathguard() {
    // Lightweight version — just verify the path-guard script itself
    // is invokable. The actual scan runs via `node scripts/path-guard.mjs`
    // in CI; healthcheck just confirms wiring.
    const path = join(ROOT, 'scripts', 'path-guard.mjs');
    if (!existsSync(path)) return { tag: 'FAIL', detail: 'scripts/path-guard.mjs missing' };
    return { tag: 'PASS', detail: 'path-guard.mjs present (run separately for full scan)' };
  },

  async examples() {
    const required = [
      'examples/quickstart/quickstart.mjs',
      'examples/quickstart/README.md',
      'examples/federation/federation.mjs',
      'examples/federation/README.md',
    ];
    const missing = required.filter(p => !existsSync(join(ROOT, p)));
    if (missing.length === 0) return { tag: 'PASS', detail: '2 runnable examples present' };
    return { tag: 'FAIL', detail: `missing: ${missing.join(', ')}` };
  },

  // iter 86: surface the iter-85 lesson — catalog.json's template count
  // is asserted in THREE places that must move together:
  //   1. The catalog.json source file itself (.templates.length)
  //   2. packages/create-agent-harness/__tests__/generated-templates.test.ts
  //      (`.templates.length).toBe(N)` and `expect(loaded.length).toBe(N)`)
  //   3. crates/template-catalog/src/lib.rs
  //      (`assert_eq!(c.templates.len(), N, "expected N templates")`)
  // iter 80 → 85 caught a divergence the hard way (CI red on iter 83).
  // This check fails LOUDLY before push when any of the three drifts.
  async catalogCount() {
    const catalogPath = join(ROOT, 'packages', 'create-agent-harness', 'templates', 'catalog.json');
    const tsTestPath = join(ROOT, 'packages', 'create-agent-harness', '__tests__', 'generated-templates.test.ts');
    const rustLibPath = join(ROOT, 'crates', 'template-catalog', 'src', 'lib.rs');
    const missing = [catalogPath, tsTestPath, rustLibPath].filter(p => !existsSync(p));
    if (missing.length > 0) {
      return { tag: 'SKIP', detail: `precondition missing: ${missing.map(p => p.slice(ROOT.length + 1)).join(', ')}` };
    }
    let catalogN = null;
    try {
      const j = JSON.parse(await readFile(catalogPath, 'utf-8'));
      catalogN = Array.isArray(j.templates) ? j.templates.length : null;
    } catch {
      return { tag: 'FAIL', detail: 'catalog.json malformed JSON' };
    }
    if (catalogN === null) return { tag: 'FAIL', detail: 'catalog.json missing .templates array' };

    const tsText = await readFile(tsTestPath, 'utf-8');
    // Match the first numeric literal in `templates.length).toBe(N)` AND
    // `loaded.length).toBe(N)`. They MUST agree with each other and with
    // catalog.json. iter 80 inline assertion shape:
    //   expect(catalog.templates.length).toBe(17);
    //   expect(loaded.length).toBe(17);
    const tsMatches = [...tsText.matchAll(/\.length\)\s*\.toBe\((\d+)\)/g)].map(m => Number(m[1]));
    const tsDistinct = [...new Set(tsMatches)];
    if (tsDistinct.length === 0) return { tag: 'FAIL', detail: 'TS test has no .length).toBe(N) assertion' };

    const rustText = await readFile(rustLibPath, 'utf-8');
    // assert_eq!(c.templates.len(), N, "expected N templates")
    const rustMatch = rustText.match(/c\.templates\.len\(\)\s*,\s*(\d+)/);
    if (!rustMatch) return { tag: 'FAIL', detail: 'Rust test has no c.templates.len() assertion' };
    const rustN = Number(rustMatch[1]);

    const drifts = [];
    if (!tsDistinct.includes(catalogN)) {
      drifts.push(`TS test expects ${tsDistinct.join('/')} but catalog has ${catalogN}`);
    }
    if (rustN !== catalogN) {
      drifts.push(`Rust test expects ${rustN} but catalog has ${catalogN}`);
    }
    if (drifts.length > 0) {
      return { tag: 'FAIL', detail: drifts.join('; ') };
    }
    return { tag: 'PASS', detail: `${catalogN} templates in JSON + TS test + Rust test (in sync)` };
  },

  // iter 72: opt-in HTTP probe of the live Studio. Off by default
  // because healthcheck is supposed to be I/O-free and offline-friendly.
  // CI workflow can pass --probe-pages to also verify the deployed
  // site is alive on every release. We probe two surfaces:
  //   1. The index HTML returns 200 and contains the Studio title
  //   2. A versioned Vite asset (assets/*.js) returns 200 — proves the
  //      deploy isn't a 200-but-empty index pointing at broken bundles
  async pages() {
    if (!PROBE_PAGES) {
      return { tag: 'SKIP', detail: 'opt-in (--probe-pages to enable)' };
    }
    try {
      const idxRes = await fetch(STUDIO_URL, { method: 'GET', redirect: 'follow' });
      if (idxRes.status !== 200) {
        return { tag: 'FAIL', detail: `${STUDIO_URL} → HTTP ${idxRes.status}` };
      }
      const html = await idxRes.text();
      // Brand check — the Studio was renamed Agent Harness Generator → MetaHarness
      // (iter-118). "MetaHarness" is in the <title>, og:title, and the rendered h1.
      if (!html.includes('MetaHarness')) {
        return { tag: 'FAIL', detail: 'index served but missing "MetaHarness" title/brand' };
      }
      // Find a Vite bundle to probe — script src="/agent-harness-generator/assets/index-<hash>.js"
      const m = html.match(/src="([^"]*\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
      if (!m) {
        return { tag: 'WARN', detail: 'index HTML missing Vite bundle reference (deploy partial?)' };
      }
      const bundlePath = m[1].startsWith('http') ? m[1] : new URL(m[1], STUDIO_URL).toString();
      const bundleRes = await fetch(bundlePath, { method: 'HEAD' });
      if (bundleRes.status !== 200) {
        return { tag: 'FAIL', detail: `Vite bundle ${bundlePath} → HTTP ${bundleRes.status}` };
      }
      return { tag: 'PASS', detail: `${STUDIO_URL} OK + Vite bundle 200` };
    } catch (e) {
      return { tag: 'FAIL', detail: `probe failed: ${e?.message ?? e}` };
    }
  },
};

function log(tag, name, detail) {
  process.stderr.write(`  ${tag.padEnd(4)} ${name.padEnd(12)} ${detail}\n`);
}

async function main() {
  const checks = onlyCheck ? [onlyCheck] : Object.keys(CHECKS);
  const results = [];
  for (const name of checks) {
    const fn = CHECKS[name];
    if (!fn) { results.push({ name, tag: 'FAIL', detail: `unknown check: ${name}` }); continue; }
    try { results.push({ name, ...(await fn()) }); }
    catch (e) { results.push({ name, tag: 'FAIL', detail: e?.message ?? String(e) }); }
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ results, ok: results.every(r => r.tag !== 'FAIL') }, null, 2) + '\n');
    process.exit(results.some(r => r.tag === 'FAIL') ? 1 : 0);
  }

  process.stderr.write(`healthcheck — ${results.length} check${results.length === 1 ? '' : 's'}\n`);
  for (const r of results) log(r.tag, r.name, r.detail);
  const fails = results.filter(r => r.tag === 'FAIL');
  if (fails.length === 0) {
    process.stderr.write(`\nResult: HEALTHY (${results.length}/${results.length} pass)\n`);
    process.exit(0);
  }
  process.stderr.write(`\nResult: ${fails.length} FAIL — fix before merge\n`);
  process.exit(1);
}

main().catch(err => {
  process.stderr.write(`[healthcheck] unexpected: ${err?.stack ?? err}\n`);
  process.exit(1);
});
