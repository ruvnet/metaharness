// SPDX-License-Identifier: MIT

import { loadKernel } from '@ruflo/kernel';

export interface CliArgs {
  name?: string;
  template?: string;
  hosts?: string[];
  yes?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--template' || a === '-t') {
      out.template = argv[++i];
    } else if (a === '--host' || a === '-h') {
      const v = argv[++i];
      if (v) (out.hosts ??= []).push(v);
    } else if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (!a.startsWith('-') && !out.name) {
      out.name = a;
    }
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const kernel = await loadKernel();
  const info = kernel.kernelInfo();
  console.log(`create-agent-harness — kernel ${info.version} (${kernel.backend})`);
  if (!args.name) {
    console.log('Usage: npx create-agent-harness <name> [--template <id>] [--host claude-code|codex|pi-dev|hermes]');
    return 2;
  }
  console.log(`Would scaffold: ${args.name} (template=${args.template ?? 'minimal'})`);
  return 0;
}
