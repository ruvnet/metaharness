// SPDX-License-Identifier: MIT
//
// Optional binary detection — the skip-when-absent pattern from darwin-mode's
// semgrep oracle. The pure core never shells out; benches use these to decide
// whether to run the real tool or skip gracefully. Env overrides let CI point at
// a specific binary (INFRACOST_BIN / CHECKOV_BIN / TERRAFORM_BIN).

import { execFileSync } from 'node:child_process';

function probe(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

export function infracostBin(): string {
  return process.env.INFRACOST_BIN || 'infracost';
}
export function checkovBin(): string {
  return process.env.CHECKOV_BIN || 'checkov';
}
export function terraformBin(): string {
  return process.env.TERRAFORM_BIN || 'terraform';
}

export function infracostAvailable(): boolean {
  return probe(infracostBin(), ['--version']);
}
export function checkovAvailable(): boolean {
  return probe(checkovBin(), ['--version']);
}
export function terraformAvailable(): boolean {
  return probe(terraformBin(), ['version']);
}
