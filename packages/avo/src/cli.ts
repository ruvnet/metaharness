// SPDX-License-Identifier: MIT
//
// @metaharness/avo CLI — a thin dispatch surface for the ADR-271 flywheel-gate receipt contract, wired
// into the metaharness core as `metaharness avo <...>`. Matches the core subcommand contract exactly:
// `dispatch(cmd, args) -> { lines, code }` (the same shape @metaharness/flywheel/cli returns).
import { readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import {
  receiptsToGateInput,
  submitToFlywheelGate,
  gateTrustedKey,
  type GateSigner,
  type AvoRunSummary,
} from './flywheelGate.js';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Load a stable signer from a PKCS#8 PEM, or generate an ephemeral one. An ephemeral key is fine for
 *  `gate-build`, but a `gate-submit` with it earns FAIL_INSUFFICIENT_RECEIPTS until its
 *  `gateTrustedKey` is registered in the gateway allowlist (#118). */
function loadSigner(pemPath?: string): GateSigner {
  if (pemPath) {
    const privateKey = createPrivateKey(readFileSync(pemPath, 'utf8'));
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

const HELP = [
  'avo — governed autonomous variation runtime (ADR-251) + flywheel-gate contract (ADR-271)',
  'subcommands:',
  '  trusted-key [--signer priv.pem] [--out priv.pem]',
  '      print the base64 SPKI-DER key to register in the gateway FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON allowlist',
  '      (--out persists the private key; without --signer a fresh ephemeral key is generated)',
  '  gate-build  <run-summary.json> [--signer priv.pem]',
  '      build + sign the five gate receipts from an AvoRunSummary and print the GateInput (offline, no network)',
  '  gate-submit <run-summary.json> --base-url URL [--api-key-env ENV] [--signer priv.pem]',
  '      submit the signed receipts to POST <URL>/v1/flywheel/gate and print the governed verdict',
];

export async function dispatch(cmd: string, args: string[]): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  switch (cmd) {
    case 'trusted-key': {
      const signer = loadSigner(flag(args, '--signer'));
      const out = flag(args, '--out');
      if (out) {
        writeFileSync(out, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
        lines.push(`saved private key -> ${out}`);
      }
      lines.push('# register this in the gateway FLYWHEEL_TRUSTED_PUBLIC_KEYS_JSON allowlist:');
      lines.push(gateTrustedKey(signer));
      return { lines, code: 0 };
    }
    case 'gate-build':
    case 'gate-submit': {
      const summaryPath = args.find((a) => !a.startsWith('--'));
      if (!summaryPath) {
        lines.push(`usage: avo ${cmd} <run-summary.json> [--signer priv.pem]${cmd === 'gate-submit' ? ' --base-url URL [--api-key-env ENV]' : ''}`);
        return { lines, code: 2 };
      }
      let summary: AvoRunSummary;
      try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as AvoRunSummary;
      } catch (e) {
        lines.push(`could not read run summary "${summaryPath}": ${e instanceof Error ? e.message : String(e)}`);
        return { lines, code: 2 };
      }
      const signer = loadSigner(flag(args, '--signer'));
      const gateInput = receiptsToGateInput(summary, signer);
      if (cmd === 'gate-build') {
        lines.push(JSON.stringify(gateInput, null, 2));
        return { lines, code: 0 };
      }
      const baseUrl = flag(args, '--base-url');
      if (!baseUrl) {
        lines.push('gate-submit requires --base-url <gateway base URL>');
        return { lines, code: 2 };
      }
      const keyEnv = flag(args, '--api-key-env') ?? 'COGNITUM_API_KEY';
      const apiKey = process.env[keyEnv];
      if (!apiKey) {
        lines.push(`the api key env var "${keyEnv}" is not set (needs a cog_ key holding the flywheel:gate scope)`);
        return { lines, code: 2 };
      }
      try {
        const out = await submitToFlywheelGate(gateInput, { baseUrl, apiKey });
        lines.push(`verdict: ${out.verdict}`);
        if (out.reasons && out.reasons.length) lines.push(`reasons: ${out.reasons.join(' | ')}`);
        lines.push(`signer key (register in the allowlist if this is refused as untrusted): ${gateTrustedKey(signer)}`);
        return { lines, code: typeof out.verdict === 'string' && out.verdict.startsWith('PASS') ? 0 : 1 };
      } catch (e) {
        lines.push(`gate submission failed: ${e instanceof Error ? e.message : String(e)}`);
        return { lines, code: 1 };
      }
    }
    default:
      lines.push(...HELP);
      return { lines, code: cmd ? 1 : 0 };
  }
}
