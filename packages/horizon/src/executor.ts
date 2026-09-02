// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { Classification } from './guard.js';

export interface PolicyReceipt {
  verdict: Classification['verdict'];
  reasons: string[];
  authorized: boolean;
  approvalRequired: boolean;
  approved: boolean;
}

/** Observed evidence from one tool execution. Never model-authored. */
export interface ToolExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  artifactDigest: string;
  policyReceipt: PolicyReceipt;
}

export interface ToolExecutionRequest {
  command: string;
  classification: Classification;
  approved: boolean;
}

export interface ToolExecutor {
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

export interface NodeToolExecutorOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Minimal explicit environment. The parent environment is not inherited. */
  env?: Record<string, string>;
  digestExclude?: string[];
}

const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'target', 'dist'];

export async function digestWorkspace(root: string, excludes = DEFAULT_EXCLUDES): Promise<string> {
  const base = resolve(root);
  const hash = createHash('sha256');
  const excluded = new Set(excludes);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const rel = relative(base, path).replaceAll('\\', '/');
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        hash.update(`link\0${rel}\0${await readlink(path)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`dir\0${rel}\0`);
        await walk(path);
      } else if (stat.isFile()) {
        hash.update(`file\0${rel}\0${stat.mode & 0o777}\0`);
        hash.update(await readFile(path));
        hash.update('\0');
      }
    }
  }

  await walk(base);
  return `sha256:${hash.digest('hex')}`;
}

function makePolicyReceipt(c: Classification, approved: boolean): PolicyReceipt {
  const approvalRequired = c.verdict === 'gate';
  return {
    verdict: c.verdict,
    reasons: [...c.reasons],
    authorized: c.verdict === 'allow' || (approvalRequired && approved),
    approvalRequired,
    approved: c.verdict === 'allow' || approved,
  };
}

/** Real, bounded subprocess execution behind CommandGuard authorization. */
export class NodeToolExecutor implements ToolExecutor {
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: Record<string, string>;
  private readonly excludes: string[];

  constructor(options: NodeToolExecutorOptions) {
    this.cwd = resolve(options.cwd);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.env = { PATH: process.env.PATH ?? '', ...options.env };
    this.excludes = options.digestExclude ?? DEFAULT_EXCLUDES;
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const policyReceipt = makePolicyReceipt(request.classification, request.approved);
    const started = performance.now();
    if (!policyReceipt.authorized) {
      return {
        stdout: '',
        stderr: `execution denied: ${policyReceipt.reasons.join('; ') || policyReceipt.verdict}`,
        exitCode: 126,
        durationMs: Math.round(performance.now() - started),
        artifactDigest: await digestWorkspace(this.cwd, this.excludes),
        policyReceipt,
      };
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const exitCode = await new Promise<number>((resolveExit) => {
      const child = spawn(request.command, [], {
        cwd: this.cwd,
        env: this.env,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current) >= this.maxOutputBytes) return current;
        const room = this.maxOutputBytes - Buffer.byteLength(current);
        return current + chunk.subarray(0, room).toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, Buffer.from(chunk)); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, Buffer.from(chunk)); });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* process already exited */ }
      }, this.timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timer);
        stderr = append(stderr, Buffer.from(error.message));
        resolveExit(127);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolveExit(timedOut ? 124 : (code ?? 1));
      });
    });

    return {
      stdout,
      stderr: stderr + (timedOut ? '\nexecution timed out' : ''),
      exitCode,
      durationMs: Math.round(performance.now() - started),
      artifactDigest: await digestWorkspace(this.cwd, this.excludes),
      policyReceipt,
    };
  }
}

export class UnavailableToolExecutor implements ToolExecutor {
  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    return {
      stdout: '',
      stderr: 'tool executor unavailable',
      exitCode: 127,
      durationMs: 0,
      artifactDigest: 'sha256:unavailable',
      policyReceipt: makePolicyReceipt(request.classification, false),
    };
  }
}
