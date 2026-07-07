// SPDX-License-Identifier: MIT
//
// `workspace-probe` CLI — a thin shell surface over @metaharness/workspace-lens + this package, for
// interpretability-audit workflows that don't want to write TypeScript. All inputs are JSON files, all
// output is JSON on stdout, so it composes with `jq` and CI. Pure (fs reads only); no model, no network.
//
//   workspace-probe diag           <lens.json>
//   workspace-probe readout        <lens.json> <activations.json> [--top-k N]
//   workspace-probe probe          <receipts.json> [--drift-threshold F]
//   workspace-probe grade-mutation <baseline-receipts.json> <mutant-receipts.json>

import { readFile } from 'node:fs/promises';
import { WorkspaceLens, type LensArtifact, type HiddenState } from '@metaharness/workspace-lens';
import { workspaceProbeScore, gradeMutationByWorkspace } from './probe.js';
import type { WorkspaceLensReceipt } from '@metaharness/workspace-lens';

const USAGE = `workspace-probe — interpretability CLI (@metaharness/workspace-probe)

Usage:
  workspace-probe diag           <lens.json>
  workspace-probe readout        <lens.json> <activations.json> [--top-k N]
  workspace-probe probe          <receipts.json> [--drift-threshold F]
  workspace-probe grade-mutation <baseline-receipts.json> <mutant-receipts.json> [--drift-threshold F]

All inputs are JSON; all output is JSON on stdout. A fitted lens artifact is produced out-of-band
(open-weight model + backward pass — see @metaharness/workspace-lens). Exit 0 on success, 2 on usage
error, 1 on a runtime error.`;

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function numFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) ? v : undefined;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** Run the CLI. Returns a process exit code (0 ok, 2 usage, 1 runtime). Pure w.r.t. process.exit. */
export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a) => !a.startsWith('--'));
  try {
    switch (cmd) {
      case 'diag': {
        if (!positional[0]) { process.stderr.write(USAGE + '\n'); return 2; }
        const lens = WorkspaceLens.fromArtifact(await readJson<LensArtifact>(positional[0]));
        out({ modelId: lens.modelId, lensId: lens.lensId, dModel: lens.dModel, layers: lens.layers, vocabSize: lens.artifact.vocab.length });
        return 0;
      }
      case 'readout': {
        if (!positional[0] || !positional[1]) { process.stderr.write(USAGE + '\n'); return 2; }
        const lens = WorkspaceLens.fromArtifact(await readJson<LensArtifact>(positional[0]));
        const states = await readJson<HiddenState[]>(positional[1]);
        const topK = numFlag(rest, '--top-k') ?? 8;
        out(states.filter((s) => lens.hasLayer(s.layer)).map((s) => lens.readout(s, topK)));
        return 0;
      }
      case 'probe': {
        if (!positional[0]) { process.stderr.write(USAGE + '\n'); return 2; }
        const receipts = await readJson<WorkspaceLensReceipt[]>(positional[0]);
        out(workspaceProbeScore(receipts, { driftThreshold: numFlag(rest, '--drift-threshold') }));
        return 0;
      }
      case 'grade-mutation': {
        if (!positional[0] || !positional[1]) { process.stderr.write(USAGE + '\n'); return 2; }
        const baseline = await readJson<WorkspaceLensReceipt[]>(positional[0]);
        const mutant = await readJson<WorkspaceLensReceipt[]>(positional[1]);
        out(gradeMutationByWorkspace(baseline, mutant, { driftThreshold: numFlag(rest, '--drift-threshold') }));
        return 0;
      }
      case undefined:
      case '-h':
      case '--help':
        process.stdout.write(USAGE + '\n');
        return 0;
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n` + USAGE + '\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`workspace-probe: ${(e as Error).message}\n`);
    return 1;
  }
}
