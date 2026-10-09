#!/usr/bin/env node
// Arena flywheel reporter: renders one day's status JSON as a SHORT Markdown summary and/or Slack mrkdwn text.
// It only PRINTS. It never calls the arena, never posts, never writes a file and never decides anything.
// Posting is post-report.sh, which is off by default. The long per-day report is flywheel-report.mjs's
// reports/<date>/report.md. There are no clock reads: dates and "now" come from the shell (--date/--today/--now).
//
//   node report.mjs [--status FILE | --state-dir DIR] [--date YYYY-MM-DD] [--today YYYY-MM-DD]
//                   [--now ISO-8601] [--config FILE] [--format md|slack|both] [--strict]
//
// Status: --status FILE, else <state>/reports/<date>/status.json, else the newest <state>/reports/<YYYY-MM-DD>/.
// <state> = --state-dir | $ARENA_FLYWHEEL_STATE_DIR | $STATE_DIRECTORY | ${XDG_STATE_HOME:-~/.local/state}/arena-flywheel
// Spend: read-only from <state>/spend.jsonl (validated by gpu-spend.mjs; the 24 h figure needs --now).
// Exit: 0 rendered | 2 bad arguments or unreadable/invalid status | 3 no status (a "no status" note is printed)
//       | 4 --strict and something had to be redacted (nothing is printed on stdout).
// The status shape is flywheel-report.mjs writeReport(). Missing values render as "unknown", never 0 or "no".
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DECISION_KEYS, KIND_LABELS, REDRAW_KEYS, reportedKind } from './decide.mjs';
import { summarize, validateRows } from './gpu-spend.mjs';

/** decide.mjs flags grouped under the owner's four auto-submit conditions. Unlisted keys show as "Other flags". */
export const POLICY_GROUPS = [
  ['1. Gate promotes, receipt verifies, evidence is real', ['leaderboardAgreesWithIncumbent', 'darwinEvidenceIsScorecards', 'candidatePresent',
    'candidateDiffersFromIncumbent', 'candidateMatchesPlan', 'confirmationPreregistered', 'confirmationProvenanceMatchesPlan',
    'confirmationNotDryRun', 'confirmationCardsMatchGenomes', 'pairedEvidenceUsed', 'gatePromote',
    'gateReceiptVerified', 'gatePublicKeyPinned', 'gateCandidateDigestMatches', 'gateBaselineDigestMatches', 'gateConfigMatchesPlan']],
  ['2. Pre-submit checks on this request and digest', ['requestRenderedForCandidate', 'requestDigestValid',
    'requestDigestBoundInGateReceipt', 'checksForThisRequest', 'envLaneCommitPinned', 'imageEnvSourceMatchesPlan',
    'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk']],
  ['3. 24h slot free, not already submitted (today\'s run)', ['runDateIsToday', 'slotFree', 'notAlreadySubmitted']],
  ['4. mode=auto', ['modeAuto']],
];
/** Policy daily-best, decision kind 'incumbent-redraw': the same four conditions over decide.mjs REDRAW_KEYS. */
export const REDRAW_GROUPS = [
  ['1. Arena-validated incumbent, re-drawn unchanged (no gate: not an improvement)', ['leaderboardAgreesWithIncumbent',
    'redrawNotRehearsal', 'incumbentValidated', 'storedRequestIntact', 'requestRenderedForIncumbent', 'redrawIsIncumbentRequest',
    'incumbentBodyNotRejected']],
  ['2. Pre-submit checks on this request and digest, today', ['requestDigestValid', 'checksForThisRequest', 'envLaneCommitPinned',
    'redrawCheckedToday', 'imagePulledAnonymously', 'openenvValidatePassed', 'exampleReplayAllTasksPassed', 'schemaEqual', 'limitsOk']],
  ['3. 24h slot free, not already submitted (today\'s run)', ['runDateIsToday', 'slotFree', 'notAlreadySubmitted']],
  ['4. mode=auto', ['modeAuto']],
];
const KIND_SHORT = { promoted: 'promoted candidate', 'incumbent-redraw': 'incumbent re-draw' };
export const CHECK_KEYS = ['anonymousPull', 'openenvValidate', 'exampleReplay', 'schemaEqual', 'limits'];
export const SLACK_MAX = 3500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FOOTER = 'Status report only. Nothing in it approves a submission, and replies to it are not approval.';

// ---------- redaction (defence in depth: nothing upstream should hold a secret, this catches it if one does) ---
const norm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const SECRET_KEY = /(token|secret|secrets|password|passwd|apikey|privatekey|authorization|cookie|cookies|credential|credentials)$/;
const SECRET_KEY_EXACT = new Set(['onstart', 'onstartcmd', 'extraenv']);
const DIGEST_KEY = /(digest|sha256|sha|hash|fingerprint|revision|commit|receipt|receiptpath|publickey|id|path)$/;
const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => '[REDACTED private key]'],
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{12,}/g, (_m, s) => `${s} [REDACTED]`],
  [/\bhf_[A-Za-z0-9]{6,}/g, () => 'hf_[REDACTED]'],
  [/\b(?:xox[abposr]|xapp)-[A-Za-z0-9-]{8,}/g, () => '[REDACTED slack token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, () => '[REDACTED github token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, () => '[REDACTED api key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, () => '[REDACTED aws key]'],
  [/\b(api[_-]?key|access[_-]?token|instance_api_key|jupyter_token|token|secret|password)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;}]+/gi,
    (_m, k, sep) => `${k}${sep}[REDACTED]`],
];
// A bare run of 32+ hex chars may be a key (a Vast key is 64 hex). Kept only after "sha256:" or under a digest key.
const LONG_HEX = /(?<!sha256:)(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;

/** Deep copy of `value` with secrets removed -> { value, count }. `hex:false` skips the bare-hex rule (for
 *  rendered text, whose digest fields were already vetted by key name). */
export function redact(value, { hex = true } = {}) {
  let count = 0;
  const scrub = (s, hexOk) => {
    let out = s;
    for (const [re, fn] of PATTERNS) out = out.replace(re, (...m) => { count++; return fn(...m); });
    return hex && !hexOk ? out.replace(LONG_HEX, () => { count++; return '[hex redacted]'; }) : out;
  };
  const walk = (v, key, depth) => {
    if (depth > 24) return '[truncated]';
    if (typeof v === 'string') return scrub(v, DIGEST_KEY.test(norm(key)));
    if (Array.isArray(v)) return v.slice(0, 500).map(x => walk(x, key, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const n = norm(k);
        if ((SECRET_KEY.test(n) || SECRET_KEY_EXACT.has(n)) && x !== null && x !== undefined && x !== '') { count++; o[k] = '[REDACTED]'; }
        else o[k] = walk(x, k, depth + 1);
      }
      return o;
    }
    return v;
  };
  return { value: walk(value, '', 0), count };
}

// ---------- formatting: missing is "unknown", never 0 or "no" ----------
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = (v, d = 3) => (isNum(v) ? String(Number(v.toFixed(d))) : 'unknown');
const usd = v => (isNum(v) ? `$${v.toFixed(2)}` : 'unknown');
const yn = v => (v === true ? 'yes' : v === false ? 'no' : 'unknown');
export function txt(v, max = 160) {
  if (v === undefined || v === null || v === '') return 'unknown';
  const s = (typeof v === 'object' ? JSON.stringify(v) : String(v))
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const short = v => (typeof v === 'string' && v.length > 19 ? `${v.slice(0, 19)}…` : txt(v));
export function safeUrl(u) {
  try {
    const url = new URL(String(u));
    const h = url.hostname;
    const ok = url.protocol === 'https:' && (h.endsWith('.hf.space') || h === 'huggingface.co' || h.endsWith('.huggingface.co'));
    return ok && !/[|<>\s]/.test(url.href) ? url.href : null;
  } catch { return null; }
}

/** The four auto-submit conditions as rows over decide.mjs flags, recovered from decision.reasons (decideSubmit
 *  lists every key that is not exactly true). Informational only. No decision object -> every row UNKNOWN.
 *  A daily-best incumbent re-draw is shown over its own conditions (REDRAW_KEYS), never as a gate promotion. */
export function policyView(s) {
  const reasons = Array.isArray(s.decision?.reasons) ? s.decision.reasons.map(String) : null;
  const known = reasons !== null && typeof s.decision?.submit === 'boolean';
  const redraw = s.decision?.kind === 'incumbent-redraw';
  const [groups, allKeys] = redraw ? [REDRAW_GROUPS, REDRAW_KEYS] : [POLICY_GROUPS, DECISION_KEYS];
  const grouped = new Set(groups.flatMap(([, keys]) => keys));
  const other = allKeys.filter(k => !grouped.has(k));
  const rows = [...groups, ...(other.length ? [['Other flags', other]] : [])].map(([label, keys]) => {
    if (!known) return { label, result: 'UNKNOWN', detail: 'no decision recorded' };
    const failed = keys.filter(k => reasons.includes(k));
    const detail = `${keys.length - failed.length}/${keys.length} true`
      + (failed.length ? `; not true: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ', …' : ''}` : '');
    return { label, result: failed.length ? 'FAIL' : 'PASS', detail };
  });
  const extra = known ? reasons.filter(r => !allKeys.includes(r)) : [];
  const allPass = known && s.decision.submit === true && rows.every(r => r.result === 'PASS') && extra.length === 0;
  const posted = s.submission?.posted === true;
  const inconsistent = posted && (!allPass || s.mode !== 'auto');
  return { rows, extra, allPass, posted, inconsistent };
}

/** Read-only spend view from the ledger. Never seeds or writes (gpu-spend.loadLedger would seed a missing one). */
export function spendView(ledgerPath, nowIso) {
  if (!existsSync(ledgerPath)) return { line: 'no ledger yet (no GPU has been rented by the flywheel)' };
  try {
    const rows = readFileSync(ledgerPath, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
    validateRows(rows);
    const nowMs = Date.parse(nowIso ?? '');
    const total = summarize(rows, Number.isFinite(nowMs) ? nowMs : 0);
    return { total: total.spentTotal, daily: Number.isFinite(nowMs) ? total.spentDaily : null, openRuns: total.openRuns };
  } catch (e) {
    return { line: `ledger INVALID (${txt(e?.reason ?? e?.message ?? 'parse error', 80)}): renting is refused until it is fixed` };
  }
}

function view(s, ctx) {
  const p = policyView(s);
  const conf = s.confirmation ?? {};
  const k = reportedKind(s); // what this date POSTed, else the decision's kind (daily-best only)
  const kind = typeof k === 'string' && Object.hasOwn(KIND_SHORT, k) ? k : null;
  const req = kind === 'incumbent-redraw' ? s.redraw : s.request;
  const reqLabel = kind === 'incumbent-redraw' ? 'Re-draw request' : 'Request';
  const ch = req?.checks?.checks ?? {};
  const failedChecks = CHECK_KEYS.filter(k => ch[k]?.ok === false).map(k => `${k}${ch[k]?.detail ? ` (${txt(ch[k].detail, 80)})` : ''}`);
  const sub = s.submission;
  const sp = ctx.spend ?? {};
  const caps = ctx.caps ?? {};
  const lb = s.leaderboard;
  return {
    p,
    title: `Arena flywheel ${txt(s.date)}: ${txt(s.outcome, 40).toUpperCase()}${kind ? `, ${KIND_SHORT[kind]}` : ''} (mode ${txt(s.mode, 20)})`,
    alerts: [
      ctx.staleFor ? `STALE: this is the status for ${txt(s.date)}; no status was written for ${ctx.staleFor}.` : null,
      p.inconsistent ? 'INCONSISTENT: a submission was posted without mode=auto and every decide.mjs condition true. Check the journal.' : null,
      s.gpu?.downError ? `GPU DESTROY NOT CONFIRMED for instance ${txt(s.gpu.instanceId, 20)}: ${txt(s.gpu.downError, 120)}. Check vastai and watchdog.jsonl now.` : null,
      p.extra.length ? `Decision input problems: ${p.extra.slice(0, 4).map(x => txt(x, 60)).join(', ')}` : null,
    ].filter(Boolean),
    head: `Submitted: ${yn(p.posted)}. Would submit in auto mode: ${yn(s.wouldSubmitInAuto)}. Decision submit=${yn(s.decision?.submit)}.`
      + (kind ? ` Kind: ${KIND_LABELS[kind]}.` : '') + (s.error ? ` Error: ${txt(s.error, 160)}` : ''),
    genomes: `Incumbent: ${txt(s.incumbent?.source, 40)}${s.incumbent?.day1 ? ' (day 1)' : ''}. Candidate: `
      + (s.candidate ? `${txt(s.candidate.variantId, 60)}, changed ${Array.isArray(s.candidate.changedFamilies) && s.candidate.changedFamilies.length ? s.candidate.changedFamilies.map(f => txt(f, 30)).join(', ') : 'unknown'}` : 'none')
      + `. Darwin improved over baseline: ${yn(s.darwin?.improvedOverBaseline)}.`,
    scores: [['incumbent', conf.incumbentScore ?? {}], ['candidate', conf.candidateScore ?? {}]],
    gate: `Gate: promote ${yn(s.gate?.promote)}, receipt verified ${yn(s.gate?.verified)}, key pinned ${yn(s.gate?.publicKeyPinned)}`
      + (Array.isArray(s.gate?.reasons) && s.gate.reasons.length ? `, reasons ${s.gate.reasons.slice(0, 4).map(r => txt(r, 50)).join(', ')}` : ''),
    request: req ? `${reqLabel}: ${txt(req.submissionId, 80)}, ${Array.isArray(req.tasks) ? req.tasks.length : 'unknown'} tasks, sha256 ${short(req.requestSha256)}, `
      + `checks ${CHECK_KEYS.filter(k => ch[k]?.ok === true).length}/${CHECK_KEYS.length} passed${failedChecks.length ? ` (failed: ${failedChecks.join('; ')})` : ''}`
      : kind === 'incumbent-redraw' ? 'Re-draw request: none rendered (no arena-validated incumbent request)' : 'Request: none rendered for a candidate',
    needsHuman: s.needsHuman ? `NEEDS HUMAN: a v2-defaults request was rendered for review: ${txt(s.needsHuman.requestPath, 160)} (sha256 ${short(s.needsHuman.requestSha256)})` : null,
    slot: `Slot: free at preflight ${yn(s.slot?.preflight?.free)}, at decision ${yn(s.slot?.decision?.free)}`
      + (isNum(s.slot?.decision?.retryAfterS) ? `, retry after ${Math.round(s.slot.decision.retryAfterS)} s` : ''),
    gpu: `GPU: ${s.gpu?.instanceId ? `instance ${txt(s.gpu.instanceId, 20)}, destroyed ${yn(s.gpu.destroyed)}` : 'not rented'}`,
    submission: `Submission: ${sub && typeof sub === 'object' && sub.posted === true ? `${txt(sub.submissionId, 80)}, state ${txt(sub.state, 20)}, HTTP ${txt(sub.httpStatus, 5)}` : 'none'}`,
    dashboard: sub && typeof sub === 'object' ? safeUrl(sub.dashboard ?? sub.run?.dashboard) : null,
    spend: `Spend: ${sp.line ?? `24h ${usd(sp.daily)} of ${usd(caps.dailyUsd)}, total ${usd(sp.total)} of ${usd(caps.totalUsd)}`
      + (sp.openRuns ? `, ${sp.openRuns} unsettled run(s) charged at plan` : '')}`,
    board: lb && typeof lb === 'object' ? `Leaderboard: ruv ${lb.ours ? `rank ${txt(lb.ours.rank, 6)}, average ${num(lb.ours.average)}` : 'not on the board'}`
      + `; leader ${txt(lb.leader?.user, 40)} ${num(lb.leader?.average)}` : null,
    notes: Array.isArray(s.notes) && s.notes.length ? `Notes: ${s.notes.length} (see reports/${txt(s.date)}/report.md)` : null,
    systemd: ctx.systemd ?? null,
  };
}

const cell = s => String(s).replace(/\|/g, '\\|');
export function renderMarkdown(s, ctx = {}) {
  const v = view(s, ctx);
  const out = [`## ${v.title}`, ''];
  for (const a of v.alerts) out.push(`**${a}**`, '');
  out.push(v.head, '', '| Policy condition (decide.mjs flags) | Result | Detail |', '|---|---|---|',
    ...v.p.rows.map(r => `| ${cell(r.label)} | ${r.result} | ${cell(r.detail)} |`), '',
    `All conditions hold: ${v.p.allPass ? 'yes' : 'no'}`, '', `- ${v.genomes}`, '',
    '| Confirmation | primary | noopRate | costPerWin |', '|---|---|---|---|',
    ...v.scores.map(([n, c]) => `| ${n} | ${num(c.primary)} | ${num(c.noopRate)} | ${num(c.costPerWin, 1)} |`), '',
    `- ${v.gate}`, `- ${v.request}`);
  if (v.needsHuman) out.push(`- **${v.needsHuman}**`);
  out.push(`- ${v.slot}`, `- ${v.gpu}`, `- ${v.submission}`);
  if (v.dashboard) out.push(`- Run dashboard: ${v.dashboard}`);
  out.push(`- ${v.spend}`);
  for (const x of [v.board, v.notes]) if (x) out.push(`- ${x}`);
  if (v.systemd) out.push(`- systemd: ${v.systemd}`);
  out.push('', `_${FOOTER}_`);
  return out.join('\n');
}

const slackEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/@(channel|here|everyone)\b/gi, '(at)$1');
export function renderSlack(s, ctx = {}) {
  const v = view(s, ctx);
  const e = slackEsc;
  const [[, ic], [, cc]] = v.scores;
  const out = [`*${e(v.title)}*`, ...v.alerts.map(a => `*${e(a)}*`), e(v.head),
    e(`Policy: ${v.p.rows.map(r => `${r.label.replace(/^(\d)\..*$/, 'condition $1').replace(/^Other flags$/, 'other')} ${r.result}`).join(', ')}. All hold: ${v.p.allPass ? 'yes' : 'no'}`),
    e(`Confirmation primary ${num(cc.primary)} vs incumbent ${num(ic.primary)}, noopRate ${num(cc.noopRate)} vs ${num(ic.noopRate)}, costPerWin ${num(cc.costPerWin, 1)} vs ${num(ic.costPerWin, 1)}`)];
  if (v.needsHuman) out.push(`*${e(v.needsHuman)}*`);
  out.push(e(v.slot), e(`${v.gpu}. ${v.submission}`));
  if (v.dashboard) out.push(`<${v.dashboard}|Run dashboard>`);
  out.push(e(v.spend));
  if (v.board) out.push(e(v.board));
  if (v.systemd) out.push(e(`systemd: ${v.systemd}`));
  out.push(`_${e(FOOTER)}_`);
  const text = out.join('\n');
  return text.length > SLACK_MAX ? `${text.slice(0, SLACK_MAX - 60)}\n…(truncated)\n_${e(FOOTER)}_` : text;
}

export function renderNoStatus(where, day, format) {
  const md = `## Arena flywheel ${day ?? ''}: NO STATUS\n\nNo status at ${where}. The tick may have failed before writing `
    + `one; see \`journalctl --user -u arena-flywheel.service\`.\n\n_${FOOTER}_`;
  const sl = `*Arena flywheel ${slackEsc(day ?? '')}: NO STATUS*\nNo status was written. See the journal of arena-flywheel.service.\n_${slackEsc(FOOTER)}_`;
  return format === 'md' ? md : format === 'slack' ? sl : `${md}\n\n---\n${sl}`;
}

/** Newest reports/<YYYY-MM-DD>/status.json by directory name (no clock, no mtimes). */
export function latestStatusPath(stateDir) {
  const dir = join(stateDir, 'reports');
  let days = [];
  try { days = readdirSync(dir).filter(d => DATE_RE.test(d)).sort(); } catch { /* none yet */ }
  for (const d of days.reverse()) if (existsSync(join(dir, d, 'status.json'))) return join(dir, d, 'status.json');
  return null;
}

function readCaps(path) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'))?.caps ?? {};
    return { dailyUsd: isNum(c.dailyUsd) ? c.dailyUsd : null, totalUsd: isNum(c.totalUsd) ? c.totalUsd : null };
  } catch { return {}; }
}

export function main(argv, env = process.env, out = s => process.stdout.write(`${s}\n`), err = s => process.stderr.write(`${s}\n`)) {
  let a;
  try {
    a = parseArgs({ args: argv, strict: true, options: { status: { type: 'string' }, 'state-dir': { type: 'string' },
      date: { type: 'string' }, today: { type: 'string' }, now: { type: 'string' }, config: { type: 'string' },
      format: { type: 'string', default: 'md' }, strict: { type: 'boolean' } } }).values;
  } catch (e) { err(`report: ${e.message}`); return 2; }
  for (const k of ['date', 'today']) if (a[k] !== undefined && !DATE_RE.test(a[k])) { err(`report: --${k} must be YYYY-MM-DD`); return 2; }
  if (a.now !== undefined && !Number.isFinite(Date.parse(a.now))) { err('report: --now must be an ISO-8601 timestamp'); return 2; }
  if (!['md', 'slack', 'both'].includes(a.format)) { err('report: --format must be md, slack or both'); return 2; }
  const stateDir = a['state-dir'] || env.ARENA_FLYWHEEL_STATE_DIR || env.STATE_DIRECTORY
    || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'arena-flywheel');
  const file = a.status ?? (a.date ? join(stateDir, 'reports', a.date, 'status.json') : latestStatusPath(stateDir));
  if (!file) { out(renderNoStatus(join(stateDir, 'reports'), a.today, a.format)); return 3; }
  let st;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) { err(`report: status file too large: ${file}`); return 2; }
    st = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') { out(renderNoStatus(file, a.date ?? a.today, a.format)); return 3; }
    err(`report: cannot read status ${file}: ${e instanceof SyntaxError ? 'invalid JSON' : e.code ?? 'error'}`); return 2;
  }
  if (!st || typeof st !== 'object' || Array.isArray(st)) { err(`report: status is not a JSON object: ${file}`); return 2; }
  const { value, count } = redact(st);
  const configPath = a.config || env.ARENA_FLYWHEEL_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'arena-flywheel', 'config.json');
  const ctx = {
    staleFor: !a.status && !a.date && a.today && value.date !== a.today ? a.today : null,
    spend: spendView(join(stateDir, 'spend.jsonl'), a.now), caps: readCaps(configPath),
    systemd: env.SERVICE_RESULT ? txt(`result=${env.SERVICE_RESULT} exit=${env.EXIT_CODE ?? '?'}/${env.EXIT_STATUS ?? '?'}`, 80) : null,
  };
  const md = a.format !== 'slack' ? renderMarkdown(value, ctx) : '';
  const sl = a.format !== 'md' ? renderSlack(value, ctx) : '';
  const final = redact(a.format === 'md' ? md : a.format === 'slack' ? sl : `${md}\n\n---\n${sl}`, { hex: false });
  const total = count + final.count;
  // --strict also refuses text that an upstream redactor already scrubbed: a secret reached the status at all.
  if (a.strict && (total || final.value.includes('[REDACTED'))) {
    err(`report: refused (--strict): ${total || 'upstream-redacted'} value(s) needed redaction in ${file}`); return 4;
  }
  if (total) err(`report: warning: redacted ${total} value(s) from ${file}`);
  out(final.value);
  return 0;
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) process.exitCode = main(process.argv.slice(2));
