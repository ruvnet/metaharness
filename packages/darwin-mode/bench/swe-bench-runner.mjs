// SPDX-License-Identifier: MIT
//
// ADR-125 — the consolidated, corpus-ready SWE-bench runner. ONE function an external
// corpus iterates: `for (const task of dataset) await runSweBenchTask(task, opts)`.
// It unifies the pieces proven separately:
//   - ADR-123: auto-derive FAIL_TO_PASS/PASS_TO_PASS + the real resolved criterion.
//   - ADR-124's DECISION: the reliable patch primitive is whole-file → `git diff` → apply
//     (raw LLM diffs corrupt). So the model emits a whole corrected file; the runner writes
//     it, captures the real unified-diff artifact via `git diff`, and scores the criterion.
// The harness's own contextBuilder does file selection (real, gated). No fabrication: every
// number returned is a measured test outcome.
//
// A `task` is: {
//   instance_id, problem_statement, test_suites: string[],
//   materialize(workDir): void   // populate workDir with the repo at the FAILING base state
// }
// Returns: { instance_id, resolved, f2p, p2p, chose, patchBytes, tokens, cost_usd }.

import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBaselineHarness } from '../dist/generator.js';
import { profileRepo } from '../dist/repo_profiler.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 'b', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'b', GIT_COMMITTER_EMAIL: 'b@b' };
const g = (work, c) => execSync(c, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });

function runTests(work, suites) {
  const out = join(work, '_vitest.json');
  try { execSync(`npx vitest run ${suites.join(' ')} --reporter=json --outputFile=${out}`, { cwd: work, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* fails → JSON still written */ }
  if (!existsSync(out)) return { status: {}, messages: {} };
  const j = JSON.parse(readFileSync(out, 'utf8')); const status = {}, messages = {};
  for (const tr of j.testResults ?? []) {
    const f = (tr.name || '').split('/').pop()?.replace('.test.ts', '');
    for (const a of tr.assertionResults ?? []) {
      const k = `${f} › ${a.title}`; status[k] = a.status;
      if (a.status === 'failed') messages[k] = (a.failureMessages ?? []).join('\n').replace(/\s+/g, ' ').slice(0, 220);
    }
  }
  return { status, messages };
}

const evaluate = (F, P, after) => ({
  resolved: F.length > 0 && F.every((t) => after[t] === 'passed') && P.every((t) => after[t] === 'passed'),
  f2p: `${F.filter((t) => after[t] === 'passed').length}/${F.length}`,
  p2p: `${P.filter((t) => after[t] === 'passed').length}/${P.length}`,
});

export async function runSweBenchTask(task, { model = 'google/gemini-2.5-flash', key, pkgPath } = {}) {
  key = (key || process.env.OPENROUTER_API_KEY || readFileSync('/tmp/.orkey', 'utf8')).trim();

  // 1. Materialize the repo at the failing base state; git-init so we can diff/apply.
  const work = mkdtempSync(join(tmpdir(), `swe-${task.instance_id}-`.replace(/[^a-z0-9-]/gi, '')));
  task.materialize(work);
  g(work, 'git init -q'); g(work, 'git add -A'); g(work, 'git commit -qm base');

  const maxAttempts = Math.max(1, task.maxAttempts ?? 3);

  // 2. Auto-derive FAIL_TO_PASS (failing now) / PASS_TO_PASS (passing now). (ADR-123)
  const baseRun = runTests(work, task.test_suites);
  const F2P = Object.keys(baseRun.status).filter((t) => baseRun.status[t] === 'failed');
  const P2P = Object.keys(baseRun.status).filter((t) => baseRun.status[t] === 'passed');

  // 3. The harness's real contextBuilder selects among the repo's source files. (gated)
  const realFiles = readdirSync(join(work, 'src')).filter((f) => f.endsWith('.ts'));
  const hr = mkdtempSync(join(tmpdir(), 'swe-h-')); writeFileSync(join(hr, 'package.json'), '{"name":"h","version":"1.0.0"}');
  const b = await generateBaselineHarness(await profileRepo(hr), mkdtempSync(join(tmpdir(), 'swe-hw-')));
  const { buildContext } = await import(`${b.dir}/context_builder.ts`);
  const selected = (buildContext(task.problem_statement, realFiles) ?? []).map((c) => c.path).slice(0, 6);

  // 4–6. Repair loop: each attempt emits a WHOLE corrected file (ADR-124), applies it, and
  // re-scores; if unresolved, the still-failing tests + assertion messages are fed back so
  // the next attempt can fix a different/remaining file. Lifts resolve rate on multi-fault
  // instances a single shot misses.
  let attemptsUsed = 0, chose = [], tokens = 0, cost = 0, verdict = evaluate(F2P, P2P, baseRun.status), last = baseRun;
  for (let attempt = 1; attempt <= maxAttempts && !verdict.resolved; attempt++) {
    attemptsUsed = attempt;
    const seen = selected.map((f) => `// ===== ${f} =====\n${readFileSync(join(work, 'src', f), 'utf8')}`).join('\n\n');
    const stillFailing = F2P.filter((t) => last.status[t] !== 'passed');
    const regressed = P2P.filter((t) => last.status[t] !== 'passed'); // tests that passed at base but a prior attempt broke
    const feedback = attempt === 1 ? '' : `\n--- attempt ${attempt - 1} left these FAILING (fix the remaining buggy file) ---\n${stillFailing.map((t) => `${t}: ${last.messages[t] ?? ''}`).join('\n')}${regressed.length ? `\n--- and a prior attempt REGRESSED these previously-passing tests; do NOT change their behaviour ---\n${regressed.map((t) => `${t}: ${last.messages[t] ?? ''}`).join('\n')}` : ''}\n`;
    // Sentinel format (not JSON): names one file, then the exact corrected content between
    // sentinels. Avoids JSON control-char breakage AND bounds the blob (no trailing prose).
    const prompt = `${task.problem_statement}\nIdentify the buggy file among the selected sources and fix it. Respond with EXACTLY this and nothing else:\nFILE: <one selected filename>\n<<<CONTENT\n<the COMPLETE corrected file content>\nCONTENT>>>\nNo code fences, no JSON, no commentary outside the sentinels.\n--- selected files ---\n${seen}\n--- failing tests ---\n${stillFailing.join('\n')}\n${feedback}`;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096, temperature: 0.1 }) });
    const j = await res.json();
    tokens += j.usage?.total_tokens ?? 0; cost += j.usage?.cost ?? 0;
    const rawc = j.choices?.[0]?.message?.content ?? '';
    const pf = (rawc.match(/FILE:\s*([^\n]+)/i)?.[1] ?? '').trim().replace(/^.*\//, '') || null; // bare filename
    const cm = rawc.match(/<<<CONTENT\n([\s\S]*?)\nCONTENT>>>/);
    const pc = cm ? cm[1] : null;
    if (process.env.SWE_DEBUG) console.error(`[attempt ${attempt}] finish=${j.choices?.[0]?.finish_reason} file=${pf} inRealFiles=${realFiles.includes(pf)} contentLen=${pc?.length}`);
    if (pf && realFiles.includes(pf) && typeof pc === 'string' && pc.length > 50) {
      writeFileSync(join(work, 'src', pf), pc);
      if (!chose.includes(pf)) chose.push(pf);
    }
    last = runTests(work, task.test_suites);
    verdict = evaluate(F2P, P2P, last.status);
  }

  const patchBytes = g(work, 'git diff').toString().length; // the appliable artifact (provenance)
  return { instance_id: task.instance_id, ...verdict, FAIL_TO_PASS: F2P.length, PASS_TO_PASS: P2P.length, attemptsUsed, maxAttempts, chose, patchBytes, tokens, cost_usd: cost };
}
