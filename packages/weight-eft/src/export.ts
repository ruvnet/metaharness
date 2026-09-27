// SPDX-License-Identifier: MIT
//
// export.ts — Archive → training-data exporter.
//
// Reads Darwin's trajectory archive (a DarwinTrajectory[]; reconstructable from
// Firestore darwin_runs + local prediction/trajectory artifacts) and emits two
// standard training sets:
//
//   SFT  = ALL gold-resolved trajectories (cheap-OWN *and* frontier-escalation).
//          Frontier successes are included for OFF-POLICY-SAFE DISTILLATION —
//          the cheap model learns to imitate a frontier success on issues it
//          could not solve itself. SFT (max-likelihood) is off-policy-stable.
//
//   DPO  = ON-POLICY cheap-vs-cheap pairs ONLY. chosen = a resolved sample,
//          rejected = an empty/failed sample by the SAME cheap model on the
//          SAME instance (BoN-derived). We do NOT emit frontier-chosen-vs-cheap-
//          rejected as DPO: an off-policy preference pair is unstable (the
//          reference policy never produced the chosen completion). That signal
//          goes to SFT instead.
//
// THE CONTAMINATION GUARD (ADR-198, the headline correctness property): strict
// train/eval instance-ID disjointness. Any trajectory whose instance_id is in
// the caller's evalHoldout is excluded; an overlap throws. Training on eval
// instances is fake lift.
//
// Two further guards: a LONG-CONTEXT filter (drop/truncate over-budget
// trajectories, never silently) and TOOL-CALL FIDELITY (tool_calls survive into
// SFT messages, never stringified).

import type {
  ChatMessage,
  DarwinTrajectory,
  DpoRow,
  ExportOptions,
  ExportReport,
  ExportResult,
  SftRow,
} from './types.js';
import { detectRewardHack } from './reward-hack.js';

const DEFAULT_MAX_TOKENS = 28000;

/**
 * Rough token estimate for a message list. We deliberately do NOT pull in a
 * tokenizer dependency (the package is dependency-free, like darwin-mode). The
 * ~4-chars-per-token heuristic is conservative and stable; tool_calls
 * arguments count too (they cost context). This is a budget gate, not a billing
 * figure — over-estimating is the safe direction.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? '').length;
    chars += (m.name ?? '').length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length + tc.id.length;
      }
    }
    chars += 8; // per-message role/structural overhead
  }
  return Math.ceil(chars / 4);
}

/**
 * Truncate an over-length trajectory by dropping the OLDEST middle tool
 * round-trips while preserving the load-bearing turns: the leading system+user
 * (the issue) and the trailing assistant (the final patch). Returns a copy.
 */
function truncateTrajectory(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (messages.length <= 3) return messages;
  // Keep a head (system + first user/issue) and a tail (final assistant).
  let headEnd = 1;
  while (headEnd < messages.length && messages[headEnd].role !== 'user') headEnd++;
  headEnd = Math.min(headEnd + 1, messages.length); // include the issue user turn
  const head = messages.slice(0, headEnd);
  const tail = [messages[messages.length - 1]];
  const middle = messages.slice(headEnd, messages.length - 1);
  // Greedily re-add middle turns from the END (most recent context) until budget.
  const kept: ChatMessage[] = [];
  for (let i = middle.length - 1; i >= 0; i--) {
    const candidate = [...head, ...kept.slice(), middle[i], ...tail];
    if (estimateTokens(candidate) > maxTokens && kept.length > 0) break;
    kept.unshift(middle[i]);
  }
  return [...head, ...kept, ...tail];
}

/**
 * Split a full trajectory into a DPO (prompt, completion) boundary. ReAct
 * diverges at the first ACTION, so prompt = the shared leading system + user
 * (issue) messages, and the completion is everything from the first assistant
 * turn onward.
 */
function splitPromptCompletion(messages: ChatMessage[]): { prompt: ChatMessage[]; completion: ChatMessage[] } {
  let firstAssistant = messages.findIndex((m) => m.role === 'assistant');
  if (firstAssistant < 0) firstAssistant = messages.length; // no assistant turn → empty completion
  return {
    prompt: messages.slice(0, firstAssistant),
    completion: messages.slice(firstAssistant),
  };
}

/**
 * THE CONTAMINATION GUARD. Throws if any trajectory's instance_id appears in
 * the eval holdout. Call it the first thing the exporter does — fail loud, not
 * silently filter, when train/eval disjointness is violated.
 */
export function assertTrainEvalDisjoint(
  trajectories: DarwinTrajectory[],
  evalHoldout: Iterable<string>,
): void {
  const holdout = new Set(evalHoldout);
  const overlap = new Set<string>();
  for (const t of trajectories) {
    if (holdout.has(t.instance_id)) overlap.add(t.instance_id);
  }
  if (overlap.size > 0) {
    const sample = [...overlap].slice(0, 10).join(', ');
    throw new Error(
      `weight-eft contamination guard: ${overlap.size} training instance_id(s) overlap the eval holdout ` +
        `(${sample}${overlap.size > 10 ? ', …' : ''}). Training on eval instances is fake lift — refusing to export. ` +
        `Exclude these instance_ids from the training archive or remove them from evalHoldout.`,
    );
  }
}

/**
 * Build the SFT and DPO sets from a Darwin trajectory archive.
 *
 * @param trajectories the input archive (already-excluded-of-holdout OR raw —
 *   the exporter excludes holdout members itself, but ASSERTS disjointness on
 *   what remains so a programming error can't slip eval data through).
 */
export function exportTrainingData(
  trajectories: DarwinTrajectory[],
  options: ExportOptions,
): ExportResult {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  // `??` only substitutes on null/undefined — a NaN (e.g. from a malformed
  // --max-tokens CLI flag) survives it untouched. `tokens <= NaN` is then always
  // false, so every trajectory looks "over budget" and the export silently
  // yields 0 SFT/DPO rows at exit code 0 instead of naming the bad flag.
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `weight-eft: maxTokens must be a finite positive number, got ${options.maxTokens} — refusing to export ` +
        `(every trajectory would silently look over-budget and yield 0 SFT/DPO rows).`,
    );
  }
  const holdout = new Set(options.evalHoldout);
  const notes: string[] = [];

  const report: ExportReport = {
    totalTrajectories: trajectories.length,
    excludedByHoldout: 0,
    droppedOverLength: 0,
    truncatedOverLength: 0,
    droppedRewardHacked: 0,
    sftRows: 0,
    dpoRows: 0,
    sftInstanceIds: [],
    dpoInstanceIds: [],
    notes,
  };

  // 1) CONTAMINATION GUARD — exclude holdout members, then assert disjointness
  //    on what's left so an exclusion bug can never leak eval data downstream.
  const inDomain: DarwinTrajectory[] = [];
  for (const t of trajectories) {
    if (holdout.has(t.instance_id)) {
      report.excludedByHoldout++;
      continue;
    }
    inDomain.push(t);
  }
  assertTrainEvalDisjoint(inDomain, holdout);

  // 2) LONG-CONTEXT FILTER — drop or truncate over-budget trajectories, never
  //    silently. Applied to a working copy so the original archive is untouched.
  const sized: DarwinTrajectory[] = [];
  for (const t of inDomain) {
    const tokens = estimateTokens(t.messages);
    if (tokens <= maxTokens) {
      sized.push(t);
      continue;
    }
    if (options.truncateOverLength) {
      const truncated = truncateTrajectory(t.messages, maxTokens);
      report.truncatedOverLength++;
      notes.push(
        `truncated ${t.instance_id} (${t.model}) ${tokens}→~${estimateTokens(truncated)} tok (budget ${maxTokens})`,
      );
      sized.push({ ...t, messages: truncated });
    } else {
      report.droppedOverLength++;
      notes.push(`dropped ${t.instance_id} (${t.model}) ${tokens} tok > budget ${maxTokens}`);
    }
  }

  // 2b) REWARD-HACKING FILTER (Ornith-1.0 borrow). Drop any trajectory whose
  //     deterministic monitor flags a gold/test read, verification tamper, or
  //     sandbox escape — an archived "success" that reward-hacked would teach
  //     the model to reward-hack. The training-data analog of the conformance
  //     firewall. Default ON. Applied BEFORE SFT/DPO so neither set sees it.
  const dropHack = options.dropRewardHacked ?? true;
  const clean: DarwinTrajectory[] = [];
  for (const t of sized) {
    if (!dropHack) {
      clean.push(t);
      continue;
    }
    const findings = detectRewardHack(t);
    if (findings.length === 0) {
      clean.push(t);
      continue;
    }
    report.droppedRewardHacked++;
    const kinds = [...new Set(findings.map((f) => f.kind))].join(',');
    const detail = findings[0].detail;
    notes.push(
      `reward-hack drop ${t.instance_id} (${t.model}) [${kinds}] — e.g. "${detail}" via ${findings[0].tool}`,
    );
  }

  // 3) SFT — ALL gold-resolved trajectories (cheap-own AND frontier-escalation).
  const sft: SftRow[] = [];
  const sftIds = new Set<string>();
  for (const t of clean) {
    if (!t.resolved) continue;
    if (t.messages.length === 0) continue; // a resolved attempt must have a trajectory
    // Tool-call fidelity: we copy messages through verbatim — tool_calls are
    // structured objects on the assistant turns, never stringified.
    sft.push({ messages: t.messages });
    sftIds.add(t.instance_id);
  }

  // 4) DPO — ON-POLICY cheap-vs-cheap pairs ONLY. Group cheap-tier trajectories
  //    by (model, instance); pair a resolved (chosen) with an empty/failed
  //    (rejected) sample from the SAME model on the SAME instance.
  const dpo: DpoRow[] = [];
  const dpoIds = new Set<string>();
  const cheapGroups = new Map<string, DarwinTrajectory[]>();
  for (const t of clean) {
    if (t.tier !== 'cheap') continue; // ON-POLICY only — frontier never enters DPO
    const key = `${t.model} ${t.instance_id}`;
    const arr = cheapGroups.get(key);
    if (arr) arr.push(t);
    else cheapGroups.set(key, [t]);
  }
  for (const group of cheapGroups.values()) {
    const chosen = group.filter((t) => t.resolved && t.messages.length > 0);
    const rejected = group.filter((t) => !t.resolved);
    if (chosen.length === 0 || rejected.length === 0) continue;
    // Deterministic pairing: lowest-sample resolved vs lowest-sample failed.
    const bySample = (a: DarwinTrajectory, b: DarwinTrajectory) => (a.sample ?? 0) - (b.sample ?? 0);
    const c = [...chosen].sort(bySample)[0];
    const r = [...rejected].sort(bySample)[0];
    const { prompt, completion: chosenCompletion } = splitPromptCompletion(c.messages);
    const { completion: rejectedCompletion } = splitPromptCompletion(
      r.messages.length > 0 ? r.messages : prompt, // empty attempt → completion is empty
    );
    dpo.push({
      prompt,
      chosen: chosenCompletion,
      rejected: rejectedCompletion,
    });
    dpoIds.add(c.instance_id);
  }

  report.sftRows = sft.length;
  report.dpoRows = dpo.length;
  report.sftInstanceIds = [...sftIds].sort();
  report.dpoInstanceIds = [...dpoIds].sort();

  return { sft, dpo, report };
}

/** Serialize SFT rows to JSONL (one row per line). */
export function sftToJsonl(rows: SftRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/** Serialize DPO rows to JSONL (one row per line). */
export function dpoToJsonl(rows: DpoRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}
