#!/usr/bin/env node

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadMechanismFixture } from './fixture.js';
import { createDefaultManifest } from './manifest.js';
import { FileBrokerModelDriver, ScriptedMechanismDriver } from './model-driver.js';
import { runMechanismBenchmark } from './runner.js';
import type { DriverFactory } from './types.js';

interface Arguments {
  readonly command: 'run' | 'manifest' | 'help';
  readonly driver: 'scripted' | 'file';
  readonly fixturePath?: string;
  readonly brokerDirectory?: string;
  readonly outputPath?: string;
  readonly visibleModelLabel?: string;
  readonly modelId?: string;
  readonly generatedAt?: string;
  readonly pretty: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  arc-agi-3-bench run [--driver scripted|file] [--fixture PATH] [--out PATH]',
    '  arc-agi-3-bench manifest [--driver scripted|file] [--fixture PATH]',
    '',
    'File broker options:',
    '  --broker-dir PATH        Directory containing requests/, responses/, and archive/',
    '  --visible-model LABEL    Operator-declared UI/provider label',
    '  --model-id ID            Operator-declared model identity',
    '',
    'Other options:',
    '  --generated-at ISO       Override report timestamp (useful for reproducibility tests)',
    '  --compact                Emit compact JSON',
    '  --help                   Show this help',
    '',
    'The file driver uses no OpenAI SDK or API key. Copy each request JSON to a manual',
    'ChatGPT conversation and save the exact typed response at responses/<requestId>.json.',
  ].join('\n');
}

function parseArguments(argv: readonly string[]): Arguments {
  const first = argv[0] ?? 'run';
  if (first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', driver: 'scripted', pretty: true };
  }
  if (first !== 'run' && first !== 'manifest') {
    throw new Error(`unknown command ${first}`);
  }
  let driver: Arguments['driver'] = 'scripted';
  let fixturePath: string | undefined;
  let brokerDirectory: string | undefined;
  let outputPath: string | undefined;
  let visibleModelLabel: string | undefined;
  let modelId: string | undefined;
  let generatedAt: string | undefined;
  let pretty = true;
  const values = argv.slice(1);
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index]!;
    if (flag === '--compact') {
      pretty = false;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      return { command: 'help', driver, pretty };
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    switch (flag) {
      case '--driver':
        if (value !== 'scripted' && value !== 'file') {
          throw new Error('--driver must be scripted or file');
        }
        driver = value;
        break;
      case '--fixture': fixturePath = resolve(value); break;
      case '--broker-dir': brokerDirectory = resolve(value); break;
      case '--out': outputPath = resolve(value); break;
      case '--visible-model': visibleModelLabel = value; break;
      case '--model-id': modelId = value; break;
      case '--generated-at':
        if (Number.isNaN(Date.parse(value))) throw new Error('--generated-at must be an ISO timestamp');
        generatedAt = new Date(value).toISOString();
        break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  if (driver === 'file' && brokerDirectory === undefined && first === 'run') {
    throw new Error('--broker-dir is required for the file driver');
  }
  return {
    command: first,
    driver,
    ...(fixturePath === undefined ? {} : { fixturePath }),
    ...(brokerDirectory === undefined ? {} : { brokerDirectory }),
    ...(outputPath === undefined ? {} : { outputPath }),
    ...(visibleModelLabel === undefined ? {} : { visibleModelLabel }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    pretty,
  };
}

async function emitJson(value: unknown, options: Arguments): Promise<void> {
  const encoded = `${JSON.stringify(value, null, options.pretty ? 2 : undefined)}\n`;
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    const temporary = `${options.outputPath}.partial`;
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, options.outputPath);
  }
  process.stdout.write(encoded);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const loaded = await loadMechanismFixture(options.fixturePath);
  const fileDriver = options.driver === 'file';
  const manifest = createDefaultManifest({
    fixtureSuiteId: loaded.suite.suiteId,
    fixtureSuiteHash: loaded.suiteHash,
    model: fileDriver ? {
      driver: 'file-broker-v1',
      visibleModelLabel: options.visibleModelLabel ?? 'operator-declared-chatgpt',
      modelId: options.modelId ?? 'operator-declared-chatgpt',
      modelSeed: null,
      temperature: null,
      reasoningEffort: null,
      operatorDeclaredIdentity: true,
    } : undefined,
  });
  if (options.command === 'manifest') {
    await emitJson(manifest, options);
    return;
  }
  const driverFactory: DriverFactory = fileDriver
    ? () => new FileBrokerModelDriver({ directory: options.brokerDirectory! })
    : () => new ScriptedMechanismDriver();
  const report = await runMechanismBenchmark({
    suite: loaded.suite,
    manifest,
    driverFactory,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  await emitJson(report, options);
  if (!report.acceptance.passed) process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`arc-agi-3-bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
