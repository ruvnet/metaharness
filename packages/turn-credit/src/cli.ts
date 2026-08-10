// @metaharness/turn-credit — CLI dispatch (consumed by `metaharness turn-credit <sub>`).
// Returns { code, lines } to match the sibling package convention (flywheel / redblue /
// weight-eft). All I/O lives here; the core stays pure.
//
//   process <input.json> [--out credit.json]   — score-pair or evidence input → TrajectoryCredit
//   report <credit.json>                       — belief curve, pivotal turns, per-label credit

import { readFileSync, writeFileSync } from 'node:fs';
import { creditByLabel } from './adapters.js';
import { evidenceFromScorePairs, processTrajectory } from './processor.js';
import { GOVERNED_DEFAULTS, PAPER_DEFAULTS } from './types.js';
import type { CreditConfig, ScorePair, TrajectoryCredit, TurnEvidence } from './types.js';

export interface CliResult {
  code: number;
  lines: string[];
}

const USAGE = [
  'metaharness turn-credit — offline recursive turn-level credit for agent trajectories (ADR-248).',
  '',
  '  metaharness turn-credit process <input.json> [--out credit.json] [--governed]',
  '      Input: { mode, prior, success?|advantage?, turns: [{turn, label?, scoreWith, scoreWithout} | {turn, label?, evidence}] }',
  '      --governed caps reshaping at ±10% of each turn\'s advantage (default: paper ±25%).',
  '  metaharness turn-credit report <credit.json>',
  '      Print the belief curve, pivotal turns, and per-label credit for a processed trajectory.',
  '',
  '  Note: verifier-delta-proxy mode is an EXPERIMENTAL stand-in for token log-probs',
  '  (hosted models) and is labelled proxy=true in every artifact.',
];

interface ProcessFile {
  mode?: 'logprob-gap' | 'verifier-delta-proxy';
  prior: number;
  success?: boolean;
  advantage?: number;
  scale?: number;
  config?: Partial<CreditConfig>;
  turns: Array<Partial<ScorePair> & Partial<TurnEvidence>>;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function processCmd(args: string[]): CliResult {
  const path = args[0];
  if (!path) return { code: 2, lines: ['Usage: metaharness turn-credit process <input.json> [--out credit.json] [--governed]'] };
  const input = JSON.parse(readFileSync(path, 'utf-8')) as ProcessFile;
  const usesPairs = input.turns.some((t) => t.scoreWith !== undefined);
  const evidence: TurnEvidence[] = usesPairs
    ? evidenceFromScorePairs(input.turns as ScorePair[], input.scale ?? 1)
    : (input.turns as TurnEvidence[]);
  const mode = input.mode ?? (usesPairs ? 'verifier-delta-proxy' : 'logprob-gap');
  const base = args.includes('--governed') ? GOVERNED_DEFAULTS : PAPER_DEFAULTS;
  const credit = processTrajectory({
    evidence,
    mode,
    prior: input.prior,
    ...(input.advantage !== undefined ? { advantage: input.advantage } : {}),
    ...(input.success !== undefined ? { success: input.success } : {}),
    config: { ...base, ...input.config },
  });
  const out = flag(args, '--out');
  if (out) writeFileSync(out, JSON.stringify(credit, null, 2) + '\n');
  return {
    code: 0,
    lines: [
      `Processed ${credit.credits.length} turns  [mode=${credit.mode}${credit.proxy ? ' PROXY — not AgentOPSD proper' : ''}]`,
      `  prior B0=${credit.prior}  advantage=${credit.advantage}  bound=±${Math.round(credit.boundPct * 100)}%`,
      `  pivotal turns: ${credit.pivotalTurns.length > 0 ? credit.pivotalTurns.join(', ') : '(none)'}`,
      ...(out ? [`  written: ${out}`] : []),
    ],
  };
}

function reportCmd(args: string[]): CliResult {
  const path = args[0];
  if (!path) return { code: 2, lines: ['Usage: metaharness turn-credit report <credit.json>'] };
  const credit = JSON.parse(readFileSync(path, 'utf-8')) as TrajectoryCredit;
  const lines = [
    `Turn credit — ${path}  [mode=${credit.mode}${credit.proxy ? ' PROXY' : ''}, bound=±${Math.round(credit.boundPct * 100)}%]`,
    `  prior=${credit.prior}  advantage=${credit.advantage}  outcome=${credit.outcomeSign > 0 ? 'success' : credit.outcomeSign < 0 ? 'failure' : 'neutral'}`,
    '',
  ];
  for (const [i, s] of credit.steps.entries()) {
    const c = credit.credits[i];
    const bar = '█'.repeat(Math.round(s.belief * 24));
    lines.push(
      `  turn${String(s.turn).padStart(3)}  B=${s.belief.toFixed(4)}  ${bar.padEnd(24)}  dB=${s.revision >= 0 ? '+' : ''}${s.revision.toFixed(4)}  m=${c.multiplier.toFixed(3)}${c.pivotal ? '  ◆ pivotal' : ''}${c.label ? `  [${c.label}]` : ''}`,
    );
  }
  const byLabel = creditByLabel(credit).filter((l) => l.label !== '(unlabelled)');
  if (byLabel.length > 0) {
    lines.push('', '  credit by label:');
    for (const l of byLabel) {
      lines.push(`    ${l.label.padEnd(20)}  turns=${l.turns}  credit=${l.totalCredit >= 0 ? '+' : ''}${l.totalCredit}  pivotal=${l.pivotalTurns}`);
    }
  }
  return { code: 0, lines };
}

export async function dispatch(sub: string | undefined, args: string[]): Promise<CliResult> {
  try {
    switch (sub) {
      case 'process':
        return processCmd(args);
      case 'report':
        return reportCmd(args);
      default:
        return { code: sub === undefined || sub === 'help' ? 0 : 2, lines: USAGE };
    }
  } catch (err) {
    return { code: 1, lines: [`turn-credit ${sub}: ${err instanceof Error ? err.message : String(err)}`] };
  }
}
