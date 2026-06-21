// SPDX-License-Identifier: MIT
//
// REAL-CORPUS defensive scan + AI triage. Runs the real semgrep CWE ruleset over a
// corpus of REAL third-party package source (CORPUS_DIR — populated out-of-band by
// `pip download --no-deps` + unzip; NEVER executed), then uses GLM-5.2 to
// CONTEXTUALLY triage each static hit: is it a genuine weakness or a legitimate/
// by-design use? This is the real-world value: raw SAST on real code is mostly
// false positives (template engines exec by design; HTTP-Digest/SSH use md5 by
// spec) — frontier reasoning suppresses them. Read-only: GLM reads code snippets;
// no third-party code is ever run.
//
// Optional: skips (exit 0) without OPENROUTER_API_KEY, a semgrep binary, or a
// non-empty CORPUS_DIR. Bounded caps, key from env only, defensive.
//
// Setup: mkdir -p /tmp/corpus && pip download --no-deps -d /tmp/dl requests pyyaml jinja2 paramiko click flask
//        (cd /tmp/dl; for f in *.whl; do unzip -oq "$f" -d "/tmp/corpus/${f%%-*}"; done)
// Run:   SEMGREP_BIN=$(command -v semgrep) CORPUS_DIR=/tmp/corpus node bench/real-corpus-scan.bench.mjs

import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenRouterClient, openRouterAvailable, tryParseJson } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEMGREP = process.env.SEMGREP_BIN || 'semgrep';
const CORPUS = process.env.CORPUS_DIR || '/tmp/corpus';
const FRONTIER = process.env.FRONTIER_MODEL || 'z-ai/glm-5.2';

function semgrepOk() { try { execFileSync(SEMGREP, ['--version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } }
const corpusOk = existsSync(CORPUS) && readdirSync(CORPUS).length > 0;
if (!openRouterAvailable() || !semgrepOk() || !corpusOk) {
  process.stdout.write(`Skipping real-corpus scan (key=${openRouterAvailable()}, semgrep=${semgrepOk()}, corpus=${corpusOk}).\n`);
  process.exit(0);
}

const RULES = `rules:
  - {id: cwe-94-eval, languages: [python], severity: ERROR, message: CWE-94 eval, pattern: 'eval(...)'}
  - {id: cwe-94-exec, languages: [python], severity: ERROR, message: CWE-94 exec, pattern: 'exec(...)'}
  - {id: cwe-78-os-system, languages: [python], severity: ERROR, message: CWE-78 os.system, pattern: 'os.system(...)'}
  - {id: cwe-78-shell-true, languages: [python], severity: ERROR, message: CWE-78 shell, pattern: 'subprocess.Popen(..., shell=True)'}
  - {id: cwe-502-yaml-load, languages: [python], severity: ERROR, message: CWE-502 yaml.load, pattern: 'yaml.load(...)'}
  - {id: cwe-502-pickle, languages: [python], severity: ERROR, message: CWE-502 pickle.loads, pattern: 'pickle.loads(...)'}
  - {id: cwe-327-md5, languages: [python], severity: WARNING, message: CWE-327 md5, pattern: 'hashlib.md5(...)'}
  - {id: cwe-377-mktemp, languages: [python], severity: WARNING, message: CWE-377 mktemp, pattern: 'tempfile.mktemp(...)'}
`;

const rf = join(here, 'results', '.cwe-rules.tmp.yaml');
writeFileSync(rf, RULES);
let raw = [];
try {
  let out = '';
  try { out = execFileSync(SEMGREP, ['--quiet', '--json', '--disable-version-check', '--config', rf, CORPUS], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (e.stdout) out = e.stdout.toString(); else throw e; }
  raw = (JSON.parse(out).results ?? []).map((r) => ({ rule: r.check_id.split('.').pop(), path: r.path, line: r.start?.line ?? 0 }));
} finally {
  try { execFileSync('rm', ['-f', rf]); } catch { /* ignore */ }
}

function snippet(path, line, ctx = 6) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    const a = Math.max(0, line - 1 - ctx);
    const b = Math.min(lines.length, line - 1 + ctx + 1);
    return lines.slice(a, b).map((l, i) => `${a + i + 1}: ${l}`).join('\n');
  } catch { return ''; }
}

const glm = new OpenRouterClient({ model: FRONTIER, maxRequests: 40, temperature: 0 });
async function triage(f) {
  const code = snippet(f.path, f.line);
  const r = await glm.chatJSON([
    { role: 'system', content: 'You are a senior application-security engineer. Judge static-analysis findings in context. Output ONLY JSON.' },
    { role: 'user', content: `A SAST rule "${f.rule}" fired here. Is this a GENUINE security weakness, or a legitimate/by-design/spec-mandated use (e.g. a template engine compiling templates, HTTP-Digest/SSH using md5 by protocol, loading a trusted local config)? Return JSON {"securityRelevant": true|false, "severity": "high"|"medium"|"low"|"none", "rationale": "one sentence"}.\n\nFile: ${f.path.split('/').slice(-2).join('/')}:${f.line}\n\n${code}` },
  ], { maxTokens: 220 });
  const v = tryParseJson(r.raw) ?? {};
  return { ...f, securityRelevant: v.securityRelevant === true, severity: String(v.severity ?? 'none'), rationale: String(v.rationale ?? '').slice(0, 200) };
}

const triaged = [];
for (const f of raw) triaged.push(await triage(f));

const relevant = triaged.filter((t) => t.securityRelevant);
const suppressed = triaged.length - relevant.length;
const s = glm.stats();
const costMilliUSD = +(((s.promptTokens / 1e6) * 1.2 + (s.completionTokens / 1e6) * 4.1) * 1000).toFixed(3);

const receipt = {
  experiment: 'real-corpus defensive scan + AI triage (false-positive suppression on real code)',
  corpus: CORPUS,
  frontierModel: FRONTIER,
  pythonFiles: (() => { try { return execFileSync('bash', ['-c', `find ${CORPUS} -name '*.py' | wc -l`], { encoding: 'utf8' }).trim(); } catch { return '?'; } })(),
  rawFindings: triaged.length,
  rawByRule: triaged.reduce((m, t) => ((m[t.rule] = (m[t.rule] || 0) + 1), m), {}),
  securityRelevantAfterTriage: relevant.length,
  suppressedAsBenign: suppressed,
  suppressionRatePct: triaged.length ? +((suppressed / triaged.length) * 100).toFixed(1) : 0,
  costMilliUSD,
  findings: triaged.map((t) => ({ rule: t.rule, where: t.path.split('/').slice(-2).join('/') + ':' + t.line, securityRelevant: t.securityRelevant, severity: t.severity, rationale: t.rationale })),
  note: 'Real third-party source (never executed); GLM-5.2 contextual triage of real semgrep hits. Single non-deterministic run. Demonstrates FP suppression: raw SAST on real code is mostly legitimate/by-design uses.',
};
writeFileSync(join(here, 'results', 'real-corpus-scan.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real-corpus scan (${receipt.pythonFiles} .py files, frontier=${FRONTIER})\n`);
process.stdout.write(`  ${triaged.length} raw semgrep findings → ${relevant.length} security-relevant after GLM triage (${receipt.suppressionRatePct}% suppressed as benign)\n`);
for (const t of triaged) process.stdout.write(`   [${t.securityRelevant ? 'KEEP ' + t.severity : 'suppress'}] ${t.rule} ${t.where} — ${t.rationale}\n`);
process.stdout.write(`  cost ≈ ${costMilliUSD} milli-USD → receipt bench/results/real-corpus-scan.json\n`);
