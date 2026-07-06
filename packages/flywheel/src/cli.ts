// @metaharness/flywheel — CLI dispatch (consumed by `metaharness flywheel <sub>`). Returns
// { code, lines } to match the sibling package convention (weight-eft / redblue). Three verbs:
//   run <config.mjs>   — run the loop from a user config module (its own proposer/evaluator/suites)
//   replay <bundle>    — independently verify a proof bundle (receipts + lineage + frozen gate)
//   graph <bundle>     — print the lineage chain + the compounding lift curve
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFlywheelGenerations, type FlywheelConfig } from './run.js';
import { verifyReplayBundle } from './replay.js';
import { makeSigner } from './receipts.js';
import { analyzeBundle, formatAnalysis } from './analyze.js';
import type { ReplayBundle } from './types.js';

export interface CliResult {
  code: number;
  lines: string[];
}

const USAGE = [
  'metaharness flywheel — a verifiable self-improvement loop for agent harnesses.',
  '',
  '  metaharness flywheel run <config.mjs> [--out bundle.json] [--generations N]',
  '      Run the loop. <config.mjs> default-exports a FlywheelConfig (your proposer/evaluator/suites).',
  '  metaharness flywheel replay <proof-bundle.json> [--gate-fingerprint <hex>]',
  '      Independently verify a bundle: receipts + lineage-to-root + (optional) frozen-gate fingerprint.',
  '  metaharness flywheel graph <proof-bundle.json>',
  '      Print the promoted lineage chain and the compounding lift curve.',
  '  metaharness flywheel analyze <proof-bundle.json>',
  '      F-P2 mutation-effectiveness: which policy levers earn promotions and how much lift each produces.',
];

function loadBundle(path?: string): ReplayBundle {
  if (!path) throw new Error('a proof-bundle.json path is required');
  return JSON.parse(readFileSync(path, 'utf-8')) as ReplayBundle;
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function replay(args: string[]): Promise<CliResult> {
  const bundle = loadBundle(args[0]);
  const v = verifyReplayBundle(bundle, { pinnedGateFingerprint: flag(args, '--gate-fingerprint') });
  const lines = [
    `Replaying ${args[0]}  [data_source=${bundle.data_source}]`,
    `  chain:  ${v.chainSummary}`,
    `  receipts verify (Ed25519, embedded key): ${v.checks.receipts ? 'PASS' : 'FAIL'}`,
    `  reconstructs to gen-0 root:               ${v.checks.reachesRoot ? 'PASS' : 'FAIL'}`,
    `  each generation re-bases on the winner:   ${v.checks.contiguousParents ? 'PASS' : 'FAIL'}`,
    `  every chain node is a promotion:          ${v.checks.allPromoted ? 'PASS' : 'FAIL'}`,
    `  gate UNCHANGED (fingerprint):             ${flag(args, '--gate-fingerprint') ? (v.checks.gateUnchanged ? 'PASS' : 'FAIL') : 'skipped (no --gate-fingerprint)'}`,
    `  verified improvements: ${bundle.verified_improvements}  |  anchor-surviving: ${bundle.anchor_surviving_improvements}  |  milestone: ${bundle.milestone_reached}`,
    '',
    `ACCEPTANCE: ${v.pass ? 'PASS' : 'FAIL (' + v.failures.join(', ') + ')'}`,
  ];
  return { code: v.pass ? 0 : 1, lines };
}

function analyze(args: string[]): CliResult {
  const bundle = loadBundle(args[0]);
  return { code: 0, lines: formatAnalysis(analyzeBundle(bundle), `${args[0]}  [data_source=${bundle.data_source}]`) };
}

function graph(args: string[]): CliResult {
  const bundle = loadBundle(args[0]);
  const max = Math.max(1, ...bundle.lift_curve.map((p) => p.primary));
  const lines = [`Lineage + lift curve — ${args[0]}  [root=${bundle.root_id}]`, ''];
  for (const p of bundle.lift_curve) {
    const bar = '█'.repeat(Math.round((p.primary / max) * 32));
    lines.push(`  gen${String(p.generation).padStart(2)}  ${String(p.primary).padStart(4)}  ${bar} ${p.delta > 0 ? `(+${p.delta})` : ''}${p.anchor !== null ? `  anchor=${p.anchor}` : ''}`);
  }
  lines.push('', `  promoted chain: ${bundle.chain.map((c) => `gen${c.generation}${c.mutation ? `(${c.mutation.target})` : '(root)'}`).join(' → ')}`);
  return { code: 0, lines };
}

async function run(args: string[]): Promise<CliResult> {
  const cfgPath = args[0];
  if (!cfgPath) return { code: 2, lines: ['Usage: metaharness flywheel run <config.mjs> [--out bundle.json] [--generations N]'] };
  const abs = isAbsolute(cfgPath) ? cfgPath : resolve(process.cwd(), cfgPath);
  const mod = (await import(pathToFileURL(abs).href)) as { default?: Partial<FlywheelConfig>; flywheelConfig?: Partial<FlywheelConfig> };
  const partial = mod.default ?? mod.flywheelConfig;
  if (!partial || !partial.rootPolicy || !partial.proposer || !partial.evaluator || !partial.holdout) {
    return { code: 2, lines: [`${cfgPath} must default-export a FlywheelConfig with at least { rootPolicy, proposer, evaluator, holdout }.`] };
  }
  const gens = Number(flag(args, '--generations')) || partial.maxGenerations || 10;
  const result = await runFlywheelGenerations({ maxGenerations: gens, signer: partial.signer ?? makeSigner(), dataSource: partial.dataSource ?? 'LIVE', ...partial } as FlywheelConfig);
  const out = flag(args, '--out');
  const lines = [`Ran ${result.generationsRun} generations.`];
  for (const p of result.liftCurve) lines.push(`  gen${p.generation}: primary=${p.primary} ${p.delta > 0 ? `(+${p.delta})` : ''}`);
  lines.push(`verified improvements: ${result.replayBundle.verified_improvements} | anchor-surviving: ${result.replayBundle.anchor_surviving_improvements} | milestone: ${result.milestoneReached}`);
  if (out) { writeFileSync(out, JSON.stringify(result.replayBundle, null, 2)); lines.push(`replay bundle written: ${out}`); }
  return { code: 0, lines };
}

export async function dispatch(sub: string | undefined, args: string[]): Promise<CliResult> {
  switch (sub) {
    case 'replay': return replay(args);
    case 'graph': return graph(args);
    case 'analyze': return analyze(args);
    case 'run': return run(args);
    case undefined:
    case 'help':
    case '--help':
      return { code: 0, lines: USAGE };
    default:
      return { code: 2, lines: [`Unknown flywheel subcommand: ${sub}`, '', ...USAGE] };
  }
}
