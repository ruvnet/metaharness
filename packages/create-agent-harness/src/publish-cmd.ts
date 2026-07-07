// SPDX-License-Identifier: MIT
//
// `harness publish [path] [--confirm]` CLI subcommand.
//
// Wraps the iter-5 publishHarness() flow with a friendly CLI surface.
// Default is DRY-RUN — confirms the manifest exists, witness verifies
// (if present), and reports what WOULD be pinned. --confirm actually
// pins to IPFS via Pinata.
//
// Required env (in --confirm mode):
//   PINATA_JWT — fetch via `harness secrets fetch PINATA_JWT`
//                or your local .env

import { resolve } from 'node:path';
import { publishHarness } from './publish.js';

export type SubcommandResult = { code: number; lines: string[] };

/**
 * `harness publish [path] [--confirm] [--name=<override>]`
 */
export async function publishCmd(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  const confirm = args.includes('--confirm');
  const allowUnverified = args.includes('--allow-unverified-witness');
  const nameOverride = args.find(a => a.startsWith('--name='))?.slice('--name='.length);

  const lines: string[] = [`harness publish — ${dir} ${confirm ? '(CONFIRMED)' : '(DRY-RUN)'}`];
  if (allowUnverified) {
    lines.push('  ⚠️  --allow-unverified-witness: the witness signature will NOT be cryptographically checked.');
  }

  if (confirm) {
    const jwt = process.env.PINATA_JWT;
    if (!jwt) {
      lines.push(
        '  PINATA_JWT env var not set.',
        '  Fetch with: harness secrets fetch PINATA_JWT',
        '  Or omit --confirm to dry-run.',
      );
      return { code: 1, lines };
    }
  }

  try {
    const r = await publishHarness({
      harnessDir: dir,
      pinata: {
        jwt: process.env.PINATA_JWT ?? 'dry-run-no-jwt',
      },
      confirm,
      name: nameOverride,
      allowUnverified,
    });
    lines.push(`  manifest CID: ${r.manifestCid}`);
    lines.push(`  size: ${r.manifestSize} bytes`);
    lines.push(`  confirmed: ${r.confirmed}`);
    if (!r.confirmed) {
      lines.push('', `  This was a DRY-RUN. Re-run with --confirm to actually pin.`);
    } else {
      lines.push('', `  Pinned to IPFS. CID is permanent — distribute via your marketplace registry.`);
    }
    return { code: 0, lines };
  } catch (e) {
    lines.push(`  FAIL: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 1, lines };
  }
}
