// SPDX-License-Identifier: MIT
//
// ADR-142 (pilot) — the SWE-bench SOLVER shim. Reuses the validated Darwin harness (relevance-
// ranked contextBuilder + symbol-index selectFiles + search/replace patch primitive, ADR-127/129)
// on REAL external Python repos. Per instance: shallow-fetch the repo at base_commit, select files,
// ask deepseek-chat for search/replace edits, apply, `git diff` → a model_patch for predictions.jsonl.
// The official `swebench` Docker harness does the test execution + resolved scoring (this shim never
// runs tests). Open-loop single-shot (no local feedback — that needs the Docker env; Stage B can add it).
//
// Run: OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
//   bench/swebench/solve.mjs [--instance <id>] [--k 12] [--out preds.jsonl]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBaselineHarness } from '../../dist/generator.js';
import { profileRepo } from '../../dist/repo_profiler.js';
import { selectFiles } from '../swe-bench-runner.mjs';
import { langProfile } from './lang-profile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const onlyInstance = argv('--instance', null);
const K = +argv('--k', 15);
const SLICE = +argv('--slice', 45000); // per-file char budget; shrink for small-context local models (ADR-150)
const LOCALIZE = args.includes('--localize');
const MODEL = argv('--model', 'deepseek/deepseek-chat');
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const OUT = rel(argv('--out', 'predictions.jsonl'));
const REPORT = rel(argv('--report', 'solve-report.json'));
const BASE_URL = ((args.indexOf('--base-url')>=0?args[args.indexOf('--base-url')+1]:'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CHAT_URL = `${BASE_URL}/chat/completions`;
const KEY_ENV = args.indexOf('--api-key-env')>=0?args[args.indexOf('--api-key-env')+1]:'OPENROUTER_API_KEY';
const key = (process.env[KEY_ENV] || (() => { try { return readFileSync('/tmp/.orkey','utf8'); } catch { return ''; } })()).trim();

let manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;
if (onlyInstance) manifest = manifest.filter((i) => i.instance_id === onlyInstance);

// One baseline contextBuilder for all instances (the harness's real relevance ranker).
const hr = mkdtempSync(join(tmpdir(), 'sb-h-')); mkdirSync(join(hr, 'src'), { recursive: true });
writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}'); writeFileSync(join(hr, 'src', 'i.js'), 'export const x=1;\n');
const base = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'sb-hw-')));
const { buildContext } = await import(`${base.dir}/context_builder.ts`);

const g = (cwd, c) => execSync(c, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

// Apply a search/replace edit. Exact match first; then a WHITESPACE-TOLERANT fallback that
// matches a contiguous line-run by trimmed content and re-indents the replacement by the
// indentation delta — critical for Python, where the LLM's SEARCH text is often slightly
// mis-indented (ADR-142 stage B1: a big share of the 48% empty-patch rate). Returns new
// content or null if no match.
function applyEdit(content, search, replace) {
  if (search.length && content.includes(search)) return content.replace(search, replace);
  const cl = content.split('\n'); const sl = search.split('\n');
  while (sl.length && sl[sl.length - 1].trim() === '') sl.pop();
  while (sl.length && sl[0].trim() === '') sl.shift();
  if (!sl.length) return null;
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i + sl.length <= cl.length; i++) {
    let ok = true; for (let j = 0; j < sl.length; j++) { if (norm(cl[i + j]) !== norm(sl[j])) { ok = false; break; } }
    if (!ok) continue;
    const indOf = (s) => (s.match(/^[ \t]*/) || [''])[0];
    const delta = indOf(cl[i]).length - indOf(sl[0]).length;
    const rl = replace.split('\n').map((line) => {
      if (!line.trim()) return line;
      if (delta >= 0) return ' '.repeat(delta) + line;
      const lead = indOf(line).length; return line.slice(Math.min(-delta, lead));
    });
    return [...cl.slice(0, i), ...rl, ...cl.slice(i + sl.length)].join('\n');
  }
  return null;
}
function fetchRepo(repo, sha) {
  const work = mkdtempSync(join(tmpdir(), 'sbrepo-'));
  g(work, 'git init -q'); g(work, `git remote add origin https://github.com/${repo}.git`);
  try { g(work, `git fetch --depth 1 origin ${sha} -q`); g(work, 'git checkout -q FETCH_HEAD'); }
  catch { g(work, 'git fetch --depth 1 origin -q'); g(work, `git fetch --depth 200 origin -q`); g(work, `git checkout -q ${sha}`); }
  return work;
}

// ADR-146 fix: LLM file LOCALIZATION. The lexical contextBuilder has only ~45% selection recall
// on huge repos (gold-file paths barely overlap the bug report). This adds a cheap localization
// call: lexically pre-prune to `pre` candidates, show the model only PATHS + def/class signatures
// (not full content → cheap), and let it pick the top `k` files to edit. Returns ranked paths.
async function localize(problem, work, files, buildContext, k, prof, pre = 120) {
  const lexTop = selectFiles(problem, work, files, buildContext, pre); // cheap prune 800→60
  // Per-language signature extraction (ADR-192): the sig regex + post-processor come from the
  // resolved language profile (py: def/class + trailing-`:` strip; js: function/const/=>; go: func/type; …).
  const sigOf = (f) => {
    const lines = readFileSync(join(work, f), 'utf8').split('\n');
    const sigs = lines.filter((l) => prof.sigRegex.test(l)).map((l) => prof.sigPostproc(l)).slice(0, 8);
    return sigs.length ? `${f}\n    ${sigs.join('\n    ')}` : f;
  };
  const listing = lexTop.map(sigOf).join('\n');
  const prompt = `A bug is reported below. From the candidate files (path + top signatures), list ONLY the file paths most likely to contain the fix, most-likely first, one per line, at most ${k}. Output paths verbatim, nothing else.\n--- problem ---\n${problem.slice(0, 4000)}\n--- candidate files ---\n${listing.slice(0, 24000)}\n`;
  let cost = 0;
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0, usage: { include: true } }) });
    const j = await res.json(); cost = j.usage?.cost ?? 0;
    const raw = j.choices?.[0]?.message?.content ?? '';
    const picked = raw.split('\n').map((l) => l.trim().replace(/^[-*\d.\s]+/, '')).filter((l) => files.includes(l));
    const merged = [...new Set([...picked, ...lexTop])].slice(0, k); // LLM picks first, lexical fills
    return { selected: merged, cost };
  } catch { return { selected: lexTop.slice(0, k), cost }; }
}

writeFileSync(OUT, ''); // fresh
const report = []; let totalCost = 0, totalTok = 0;
for (const inst of manifest) {
  const t0 = Date.now(); let row = { instance_id: inst.instance_id, repo: inst.repo };
  try {
    const work = fetchRepo(inst.repo, inst.base_commit);
    // Resolve the per-instance language profile (explicit inst.lang wins; else detect from repo root).
    const prof = langProfile(inst, work); row.lang = prof.lang;
    // candidate source files: tracked source in this language's globs, excluding tests/vendored, size-bounded
    const globArgs = prof.srcGlobs.map((g2) => `'${g2}'`).join(' ');
    const all = g(work, `git ls-files ${globArgs}`).toString().split('\n').filter(Boolean)
      .filter((f) => !prof.genericExclude.test(f) && !prof.testPathRegex(f))
      .filter((f) => { try { return statSync(join(work, f)).size <= 100_000; } catch { return false; } });
    let selected;
    if (LOCALIZE) { const lz = await localize(inst.problem_statement, work, all, buildContext, K, prof); selected = lz.selected; totalCost += lz.cost; row.localizeCost = lz.cost; }
    else selected = selectFiles(inst.problem_statement, work, all, buildContext, K);
    row.candidateFiles = all.length; row.selected = selected;
    const seen = selected.map((f) => `# ===== ${f} =====\n${readFileSync(join(work, f), 'utf8').slice(0, SLICE)}`).join('\n\n');
    // ADR-150: a SYSTEM message with a concrete format example. Weak local models (qwen-7b)
    // ignore an inline format spec and emit a prose code-summary instead of edit blocks (0/25
    // applied). A system role + worked example lifts format adherence; deepseek already complies
    // so this is additive (no change to the hosted baseline's output shape).
    // ADR-192: the FILE: path extension and worked example are templated to the instance's language
    // so a weak model is shown an in-language pattern (js example for a js instance, etc.).
    const ext = prof.exampleExt;
    const sysBase = `You are a non-conversational code-patching tool. Output ONLY search/replace edit blocks. NEVER write prose, explanations, summaries, or markdown fences. Each edit is EXACTLY:\nFILE: path/to/file.${ext}\n<<<SEARCH\n<lines copied verbatim from the file, incl. indentation>\n=======\n<replacement lines>\n>>>REPLACE\nExample of a valid response:\nFILE: pkg/util.${ext}\n<<<SEARCH\n${prof.exampleSnippet}\n>>>REPLACE`;
    // D1-S3 (flywheel domain-scale): an OPERATING-POLICY seam. SWE_POLICY_SYSTEM (set by the flywheel's
    // SWE-bench runSolver from the candidate policy's levers) is appended to the system prompt so the
    // flywheel can evolve HOW this cheap solver operates. Unset ⇒ byte-identical to before (backward-safe).
    const POLICY_SYSTEM = (process.env.SWE_POLICY_SYSTEM || '').trim();
    const sys = POLICY_SYSTEM ? `${sysBase}\n${POLICY_SYSTEM}` : sysBase;
    const prompt = `Fix the bug described below by editing the selected real source files. Emit one or more edit blocks in the exact format from the system message. The SEARCH text must match the file character-for-character (incl. indentation). No prose outside blocks.\n--- problem statement ---\n${inst.problem_statement.slice(0, 6000)}\n--- selected source files ---\n${seen}\n`;
    const res = await fetch(CHAT_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }], max_tokens: 4096, temperature: 0, usage: { include: true } }) });
    const j = await res.json();
    totalTok += j.usage?.total_tokens ?? 0; totalCost += j.usage?.cost ?? 0; row.cost_usd = j.usage?.cost ?? 0;
    const raw = j.choices?.[0]?.message?.content ?? '';
    if (process.env.SWE_RAWDUMP) writeFileSync(rel(`raw-${inst.instance_id}.txt`), raw);
    let applied = 0; const re = /FILE:\s*([^\n]+)\n<<<SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>REPLACE/g;
    for (let m; (m = re.exec(raw)); ) { const f = m[1].trim(); if (!selected.includes(f)) continue; const fp = join(work, f); if (!existsSync(fp)) continue; const cur = readFileSync(fp, 'utf8'); const next = applyEdit(cur, m[2], m[3]); if (next && next !== cur) { writeFileSync(fp, next); applied++; } }
    row.blocksApplied = applied;
    const diff = applied ? g(work, 'git diff').toString() : '';
    row.patchBytes = diff.length;
    appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: `darwin-${MODEL.replace(/[/:]/g, '-')}-searchreplace`, model_patch: diff }) + '\n');
  } catch (e) { row.error = String(e).split('\n')[0].slice(0, 200); appendFileSync(OUT, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: `darwin-${MODEL.replace(/[/:]/g, '-')}-searchreplace`, model_patch: '' }) + '\n'); }
  row.sec = Math.round((Date.now() - t0) / 1000); report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${inst.instance_id} files=${row.candidateFiles ?? '?'} applied=${row.blocksApplied ?? 0} patch=${row.patchBytes ?? 0}B ${row.sec}s ${row.error ? 'ERR:' + row.error : ''}`);
}
writeFileSync(REPORT, JSON.stringify({ model: MODEL, k: K, n: report.length, totalTokens: totalTok, totalCost_usd: Math.round(totalCost * 10000) / 10000, instances: report }, null, 2));
console.error(`\nDONE ${report.length} instances | applied-a-patch: ${report.filter((r) => r.blocksApplied).length} | $${Math.round(totalCost * 10000) / 10000} | preds → ${OUT}`);
