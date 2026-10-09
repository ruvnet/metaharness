// Daily status JSON + human-readable markdown under <stateDir>/reports/<date>/. Everything is redacted again
// on the way out (defence in depth: the orchestrator never holds the HF token or the Vast key).
import { join } from 'node:path';
import { KIND_LABELS, reportedKind } from './decide.mjs';
import { redact, redactDeep, writeJsonAtomic, writeTextAtomic } from './journal.mjs';

const yes = v => (v === true ? 'yes' : v === false ? 'no' : '—');
const code = v => (v === null || v === undefined ? '—' : `\`${String(v)}\``);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : '—');

export function renderMarkdown(s) {
  const L = [];
  L.push(`# Arena flywheel ${s.date}`, '', `- Outcome: **${s.outcome}**`, `- Mode: \`${s.mode}\``,
    ...(s.policy ? [`- Policy: \`${s.policy}\``] : []),
    `- Submitted: ${yes(s.submission?.posted === true)}`, `- Would submit in auto mode: ${yes(s.wouldSubmitInAuto)}`);
  if (s.error) L.push(`- Error: ${s.error}`);
  if (s.decision) {
    L.push('', '## Decision (pure `decideSubmit`, no LLM)', '', `submit = **${s.decision.submit}**`, '');
    const kind = reportedKind(s); // what this date POSTed, else the decision's kind
    if (kind) L.push(`Kind: **${kind}** (${KIND_LABELS[kind] ?? 'unknown kind'})`, '');
    if (s.decision.reasons.length) L.push('Blocking conditions:', '', ...s.decision.reasons.map(r => `- \`${r}\``));
  }
  L.push('', '## Incumbent and candidate', '',
    `- Incumbent: ${s.incumbent?.source ?? '—'} (genome ${code(s.incumbent?.genomeDigest?.slice(0, 16))}${s.incumbent?.day1 ? ', day 1' : ''})`,
    `- Arena: connected ${yes(s.arena?.connected)}; leaderboard has \`${s.arena?.user ?? '—'}\`: ${yes(s.arena?.hasIncumbent)}${s.arena?.rank ? ` (rank ${s.arena.rank})` : ''}; agrees with local incumbent: ${yes(s.incumbent?.boardAgrees)}${s.arena?.error ? `; error: ${s.arena.error}` : ''}`,
    `- Candidate: ${s.candidate ? `${s.candidate.variantId} (genome ${code(s.candidate.genomeDigest.slice(0, 16))}, changed: ${s.candidate.changedFamilies?.join(', ') || '—'})` : 'none'}`,
    `- Darwin evidence: ${code(s.darwin?.evidence)}; search winner improved over baseline: ${yes(s.darwin?.improvedOverBaseline)}`);
  if (s.confirmation) {
    const c = s.confirmation;
    L.push('', '## Preregistered paired confirmation', '', `- Plan sha256: ${code(c.planHash)}`,
      `- Seeds: ${c.seedRange?.join('..') ?? '—'} (${c.attempts} attempts per cell)`,
      `- Preregistered before rollouts: ${yes(c.preregistered)}; provenance matches plan: ${yes(c.provenanceMatchesPlan)}; dry-run: ${yes(c.dryRun)}`,
      `- Incumbent primary/noop/costPerWin: ${num(c.incumbentScore?.primary)} / ${num(c.incumbentScore?.noopRate)} / ${num(c.incumbentScore?.costPerWin)}`,
      `- Candidate primary/noop/costPerWin: ${num(c.candidateScore?.primary)} / ${num(c.candidateScore?.noopRate)} / ${num(c.candidateScore?.costPerWin)}`,
      `- Paired blocks (changed cells only): ${c.pairedCount ?? '—'}; needed ${c.power?.needed ?? '—'} at candidateBudget ${c.candidateBudget ?? '—'}, max possible ${c.power?.maxDiscordant ?? '—'}${c.pairedError ? `; error: ${c.pairedError}` : ''}`);
  }
  if (s.gate) {
    const g = s.gate;
    L.push('', '## Gate', '', `- Promote: ${yes(g.promote)}; receipt verified (pinned key): ${yes(g.verified)} / pinned: ${yes(g.publicKeyPinned)}`,
      `- Reasons: ${(g.reasons ?? []).map(r => `\`${r}\``).join(', ') || '—'}`,
      `- e-value: ${num(g.sequential?.eValue)} (threshold ${num(g.sequential?.threshold)}, informative ${g.sequential?.informativePairs ?? '—'}/${g.sequential?.totalPairs ?? '—'})`,
      `- Request digest bound in receipt: ${code(g.boundRequestSha256)} (gate.mjs supports binding: ${yes(g.bindingSupported)})`,
      `- Receipt: ${code(g.receiptPath)}; public key ${code(g.publicKey)}`);
  }
  for (const [title, r] of [['Candidate request', s.request], ['Needs-human request (v2 defaults)', s.needsHuman],
    ['Incumbent re-draw request (same request as the validated incumbent, fresh submission_id)', s.redraw]]) {
    if (!r) continue;
    const ch = r.checks?.checks ?? {};
    L.push('', `## ${title}`, '', `- File: ${code(r.requestPath)}`, `- sha256: ${code(r.requestSha256)}`,
      `- Submission ID: ${code(r.submissionId)}; tasks: ${(r.tasks ?? []).map(t => t.task_id).join(', ')}`,
      `- Checks for this request/image: ${yes(r.checks?.requestSha256 === r.requestSha256 && r.checks?.image === r.image)}`,
      ...['anonymousPull', 'openenvValidate', 'exampleReplay', 'schemaEqual', 'limits'].map(k => `- ${k}: ${yes(ch[k]?.ok)}${ch[k]?.detail ? ` (${redact(ch[k].detail)})` : ''}`));
  }
  L.push('', '## Slot, GPU, submission', '', `- Slot at preflight: free ${yes(s.slot?.preflight?.free)}; at decision: free ${yes(s.slot?.decision?.free)}${s.slot?.decision?.retryAfterS ? ` (retry after ${s.slot.decision.retryAfterS} s)` : ''}`,
    `- GPU: ${s.gpu?.instanceId ? `instance ${s.gpu.instanceId}, destroyed ${yes(s.gpu.destroyed)}` : 'not rented'}${s.gpu?.downError ? `; DOWN FAILED: ${s.gpu.downError}` : ''}`,
    `- Submission: ${s.submission ? `${code(s.submission.submissionId)} state ${code(s.submission.state)} (HTTP ${s.submission.httpStatus ?? '—'})` : 'none'}`);
  if (s.notes?.length) L.push('', '## Notes', '', ...s.notes.map(n => `- ${n}`));
  L.push('', 'Slack/board messages are never approval. Only `mode=auto` plus every condition above may POST.');
  return `${L.join('\n')}\n`;
}

export function writeReport(stateDir, status) {
  const dir = join(stateDir, 'reports', status.date);
  const clean = redactDeep(status);
  const statusPath = writeJsonAtomic(join(dir, 'status.json'), clean);
  const markdownPath = writeTextAtomic(join(dir, 'report.md'), renderMarkdown(clean));
  return { statusPath, markdownPath };
}
