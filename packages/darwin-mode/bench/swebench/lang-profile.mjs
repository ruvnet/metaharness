// SPDX-License-Identifier: MIT
//
// ADR-192 (polyglot) — a single per-instance LANGUAGE PROFILE shared by solve.mjs,
// solve-agentic.mjs, and agentic-loop.mjs. The solver was hardwired to Python in four
// categories: candidate-file discovery (`git ls-files '*.py'`), symbol/signature heuristics
// (`def`/`class` + `:`-strip), test commands (`pytest` / `python -m`), and file-extension
// assumptions in the system-prompt worked examples + test-target seeding.
//
// This module makes ALL of those a function of the instance's language. Everything is ADDITIVE:
// Python (SWE-bench Lite) behaviour is preserved byte-for-byte when lang resolves to 'py' — the
// only change for Python is that the same defaults are now reached through the profile table.
//
// Language is resolved per-instance: an explicit `lang` field on the manifest instance wins;
// otherwise it is auto-detected from the checked-out repo's root manifest files
// (package.json→js/ts, go.mod→go, Cargo.toml→rust, pom.xml/build.gradle→java, Gemfile→ruby), with
// a final fallback to Python (the SWE-bench Lite default). The official SWE-bench Docker oracle
// (`evalOne`) is the dataset's Python harness and stays Python — only the in-loop conformant gate
// (`runRepoTests`) and the localization heuristics become language-aware.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

// The per-language profile table. Each entry is read once per instance and threaded through
// selectFiles / localize / grep defaults / the two system prompts / runRepoTests / existingTestTargets.
//
//   srcGlobs        git-ls-files / git-grep globs for source files
//   testPathRegex   true ⇒ path is a test file (never edit; excluded from candidate set)
//   sigRegex        cheap line-regex that matches a top-level symbol/signature
//   sigPostproc     (line) => cleaned signature string (e.g. Python's trailing-`:` strip)
//   testRunnerCmd   (targets[]) => shell command running those specific test files
//   testTargets     (changedFile) => candidate test-file paths for that changed source file
//   exampleExt      extension shown in worked-example FILE: paths / tool-call examples
//   exampleSnippet  in-language worked example for the search/replace system prompt
const PROFILES = {
  py: {
    srcGlobs: ['*.py'],
    testPathRegex: (f) => /(^|\/)(tests?|testing)\//i.test(f) || /(^|\/)(test_|conftest)/i.test(f) || /_test\.py$/.test(f),
    sigRegex: /^\s*(class|def|async def)\s+\w/,
    sigPostproc: (l) => l.trim().replace(/:\s*$/, ''),
    testRunnerCmd: (targets) => `python -m pytest -q -x -p no:cacheprovider ${targets.map((t) => `'${t}'`).join(' ')}`,
    testTargets: (f) => { const p = f.split('/'); const base = p[p.length - 1].replace(/\.py$/, ''); const dir = p.slice(0, -1).join('/'); return [`${dir}/tests/test_${base}.py`, `${dir}/test_${base}.py`]; },
    exampleExt: 'py',
    exampleSnippet: 'def add(a, b):\n    return a - b\n=======\ndef add(a, b):\n    return a + b',
  },
  js: {
    srcGlobs: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx'],
    testPathRegex: (f) => /(^|\/)(__tests__|tests?)\//i.test(f) || /\.(test|spec)\.(js|jsx|mjs|cjs|ts|tsx)$/.test(f),
    sigRegex: /^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\s+\w|=>\s*\{?\s*$/,
    sigPostproc: (l) => l.trim().replace(/\s*\{?\s*$/, ''),
    testRunnerCmd: (targets) => `npx vitest run ${targets.map((t) => `'${t}'`).join(' ')} || npx jest ${targets.map((t) => `'${t}'`).join(' ')}`,
    testTargets: (f) => { const m = f.match(/^(.*)\.(js|jsx|mjs|cjs|ts|tsx)$/); if (!m) return []; const [, stem, ext] = m; const p = stem.split('/'); const base = p[p.length - 1]; const dir = p.slice(0, -1).join('/'); return [`${stem}.test.${ext}`, `${stem}.spec.${ext}`, `${dir}/__tests__/${base}.test.${ext}`]; },
    exampleExt: 'js',
    exampleSnippet: 'function add(a, b) {\n  return a - b;\n}\n=======\nfunction add(a, b) {\n  return a + b;\n}',
  },
  go: {
    srcGlobs: ['*.go'],
    testPathRegex: (f) => /_test\.go$/.test(f),
    sigRegex: /^\s*(func|type|const|var)\s+\w/,
    sigPostproc: (l) => l.trim().replace(/\s*\{?\s*$/, ''),
    testRunnerCmd: (targets) => { const dirs = [...new Set(targets.map((t) => t.split('/').slice(0, -1).join('/') || '.'))]; return `go test ${dirs.map((d) => `./${d}/...`).join(' ')}`; },
    testTargets: (f) => { const m = f.match(/^(.*)\.go$/); return m ? [`${m[1]}_test.go`] : []; },
    exampleExt: 'go',
    exampleSnippet: 'func Add(a, b int) int {\n\treturn a - b\n}\n=======\nfunc Add(a, b int) int {\n\treturn a + b\n}',
  },
  rust: {
    srcGlobs: ['*.rs'],
    testPathRegex: (f) => /(^|\/)tests\//.test(f),
    sigRegex: /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|const|static|type)\s+\w/,
    sigPostproc: (l) => l.trim().replace(/\s*\{?\s*$/, ''),
    testRunnerCmd: () => 'cargo test',
    testTargets: (f) => { const m = f.match(/^(.*)\.rs$/); return m ? [`tests/${m[1].split('/').pop()}.rs`] : []; },
    exampleExt: 'rs',
    exampleSnippet: 'fn add(a: i32, b: i32) -> i32 {\n    a - b\n}\n=======\nfn add(a: i32, b: i32) -> i32 {\n    a + b\n}',
  },
  java: {
    srcGlobs: ['*.java'],
    testPathRegex: (f) => /(^|\/)src\/test\//.test(f) || /Test\.java$/.test(f) || /Tests\.java$/.test(f),
    sigRegex: /^\s*(public|private|protected)?\s*(static\s+)?(final\s+)?(class|interface|enum|abstract\s+class)\s+\w|^\s*(public|private|protected)[\w<>\[\],\s.]*\s+\w+\s*\(/,
    sigPostproc: (l) => l.trim().replace(/\s*\{?\s*$/, ''),
    testRunnerCmd: () => 'mvn -q test || ./gradlew test',
    testTargets: (f) => { const m = f.match(/^(.*)\/main\/(.*)\.java$/); if (m) return [`${m[1]}/test/${m[2]}Test.java`]; const n = f.match(/^(.*)\.java$/); return n ? [`${n[1]}Test.java`] : []; },
    exampleExt: 'java',
    exampleSnippet: 'int add(int a, int b) {\n    return a - b;\n}\n=======\nint add(int a, int b) {\n    return a + b;\n}',
  },
  ruby: {
    srcGlobs: ['*.rb'],
    testPathRegex: (f) => /(^|\/)(spec|test)\//.test(f) || /_(spec|test)\.rb$/.test(f),
    sigRegex: /^\s*(class|module|def)\s+\w/,
    sigPostproc: (l) => l.trim(),
    testRunnerCmd: (targets) => `bundle exec rspec ${targets.map((t) => `'${t}'`).join(' ')} || ruby -Itest ${targets.map((t) => `'${t}'`).join(' ')}`,
    testTargets: (f) => { const m = f.match(/^(.*)\.rb$/); if (!m) return []; const stem = m[1]; const p = stem.split('/'); const base = p[p.length - 1]; const dir = p.slice(0, -1).join('/'); return [`${dir}/${base}_spec.rb`, `${dir}/${base}_test.rb`, `spec/${base}_spec.rb`, `test/${base}_test.rb`]; },
    exampleExt: 'rb',
    exampleSnippet: 'def add(a, b)\n  a - b\nend\n=======\ndef add(a, b)\n  a + b\nend',
  },
};

// Generic (language-neutral) directory excludes applied on top of the per-language test filter,
// so vendored/build trees never enter the candidate set regardless of language.
const GENERIC_EXCLUDE = /(^|\/)(node_modules|site-packages|vendor|\.tox|\.git|build|dist|target|\.gradle|out|bin|obj|coverage|__pycache__)\//i;

/** Auto-detect the language from the checked-out repo's root manifest files. Falls back to 'py'. */
export function detectLang(work) {
  const has = (f) => { try { return existsSync(join(work, f)); } catch { return false; } };
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'rust';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
  if (has('Gemfile') || has('Rakefile')) return 'ruby';
  if (has('package.json') && !has('setup.py') && !has('pyproject.toml') && !has('setup.cfg')) return 'js';
  return 'py';
}

/**
 * Resolve the language profile for an instance. An explicit `inst.lang` wins; otherwise we
 * auto-detect from `work` (the checked-out repo). Unknown langs degrade to Python. The returned
 * object also exposes `genericExclude` (the shared dir-exclude regex) and `lang` (the resolved id).
 */
export function langProfile(inst = {}, work = null) {
  let lang = (inst.lang || '').toLowerCase();
  const alias = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'js', ts: 'js', node: 'js', golang: 'go', go: 'go', rust: 'rust', rs: 'rust', java: 'java', ruby: 'ruby', rb: 'ruby' };
  lang = alias[lang] || '';
  if (!lang && work) lang = detectLang(work);
  if (!PROFILES[lang]) lang = 'py';
  return { lang, genericExclude: GENERIC_EXCLUDE, ...PROFILES[lang] };
}

export { PROFILES, GENERIC_EXCLUDE };
