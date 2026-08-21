// SPDX-License-Identifier: MIT

import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Classification, ToolExecutor } from '@metaharness/horizon';
import { digestWorkspace } from '@metaharness/horizon';
import type { EnvironmentAdapter, EvaluatorSuite } from './ports.js';
import type { ActionObservation, Candidate, EvaluationResult, VariationAction, VariationState } from './types.js';

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function allowedClassification(command: string): Classification {
  return {
    verdict: 'allow',
    segments: [{ text: command, exe: command.trim().split(/\s+/)[0] ?? '', verdict: 'allow', reason: 'authorized by immutable AVO policy' }],
    reasons: ['authorized by immutable AVO policy'],
  };
}

export interface RepositoryEnvironmentOptions {
  version: string;
  seedBranchId: string;
  seedPath: string;
  branchesRoot: string;
  executorFor(cwd: string): ToolExecutor;
  maxInspectBytes?: number;
}

/** Real repository workspace adapter; all writes stay inside copied branches. */
export class RepositoryEnvironmentAdapter implements EnvironmentAdapter {
  readonly version: string;
  private readonly branches = new Map<string, string>();
  private readonly undo = new Map<string, Array<{ path: string; content: string; existed: boolean }>>();
  private branchCounter = 0;

  constructor(private readonly options: RepositoryEnvironmentOptions) {
    this.version = options.version;
    this.branches.set(options.seedBranchId, resolve(options.seedPath));
  }

  async fork(parent: Candidate): Promise<{ branchId: string; workspaceDigest: string }> {
    const source = this.must(parent.branchId);
    let branchId: string;
    let destination: string;
    do {
      branchId = `${parent.id.replaceAll('/', '-')}-b${++this.branchCounter}`;
      destination = resolve(this.options.branchesRoot, branchId);
    } while (existsSync(destination));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: false, force: false, errorOnExist: true });
    this.branches.set(branchId, destination);
    this.undo.set(branchId, []);
    return { branchId, workspaceDigest: await digestWorkspace(destination) };
  }

  async execute(action: VariationAction, state: Readonly<VariationState>): Promise<ActionObservation> {
    const root = this.must(state.currentBranchId);
    const started = performance.now();
    if (action.kind === 'inspect') {
      const path = this.path(root, action.path);
      const content = await readFile(path, 'utf8');
      return this.observation(root, started, true, content.slice(0, this.options.maxInspectBytes ?? 256_000));
    }
    if (action.kind === 'search') {
      const matches: string[] = [];
      const roots = action.paths?.length ? action.paths.map((path) => this.path(root, path)) : [root];
      for (const searchRoot of roots) await this.searchFiles(searchRoot, root, action.query, matches);
      return this.observation(root, started, true, matches.slice(0, 500).join('\n'));
    }
    if (action.kind === 'hypothesize' || action.kind === 'consultMemory') {
      return this.observation(root, started, true, `${action.kind} recorded`);
    }
    if (action.kind === 'edit') {
      const path = this.path(root, action.path);
      let previous = '';
      let existed = true;
      try { previous = await readFile(path, 'utf8'); } catch { existed = false; }
      this.undo.get(state.currentBranchId)?.push({ path, content: previous, existed });
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, action.content, 'utf8');
      return this.observation(root, started, true, `wrote ${relative(root, path)}`);
    }
    if (action.kind === 'execute') {
      const result = await this.options.executorFor(root).execute({
        command: action.command,
        classification: allowedClassification(action.command),
        approved: true,
      });
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        costUsd: 0,
        workspaceDigest: result.artifactDigest,
        data: { policyReceipt: result.policyReceipt },
        failureSignature: result.exitCode === 0 ? undefined : `exit:${result.exitCode}:${result.stderr.slice(-160)}`,
      };
    }
    if (action.kind === 'revert') {
      const stack = this.undo.get(state.currentBranchId) ?? [];
      const previous = stack.pop();
      if (!previous) return this.observation(root, started, false, '', 'nothing to revert');
      if (previous.existed) await writeFile(previous.path, previous.content, 'utf8');
      else await rm(previous.path, { force: true });
      return this.observation(root, started, true, `reverted ${relative(root, previous.path)}`);
    }
    if (action.kind === 'commit') {
      return this.observation(root, started, true, action.summary);
    }
    return this.observation(root, started, false, '', `${action.kind} is controlled by the operator`);
  }

  async quarantine(branchId: string, reason: string): Promise<void> {
    const root = this.must(branchId);
    await writeFile(join(root, '.avo-quarantined'), `${reason}\n`, 'utf8');
  }

  pathForBranch(branchId: string): string {
    return this.must(branchId);
  }

  private path(root: string, requested: string): string {
    const path = resolve(root, requested);
    if (!within(root, path)) throw new Error(`avo: path escapes bounded workspace: ${requested}`);
    const segments = relative(root, path).split(sep).filter(Boolean);
    let cursor = resolve(root);
    for (const segment of segments) {
      cursor = join(cursor, segment);
      // lstat directly: existsSync follows symlinks, so a DANGLING symlink
      // (target missing) would bypass the guard and fail later as ENOENT.
      let stats;
      try {
        stats = lstatSync(cursor);
      } catch {
        stats = undefined;
      }
      if (stats?.isSymbolicLink()) {
        throw new Error(`avo: symbolic links are not traversable in bounded workspaces: ${requested}`);
      }
    }
    return path;
  }

  private must(branchId: string): string {
    let root = this.branches.get(branchId);
    if (!root) {
      const recovered = resolve(this.options.branchesRoot, branchId);
      if (within(this.options.branchesRoot, recovered) && existsSync(recovered)) {
        root = recovered;
        this.branches.set(branchId, root);
        this.undo.set(branchId, []);
      }
    }
    if (!root) throw new Error(`avo: unknown repository branch ${branchId}`);
    return root;
  }

  private async observation(root: string, started: number, ok: boolean, stdout = '', stderr = ''): Promise<ActionObservation> {
    return {
      ok,
      stdout,
      stderr,
      exitCode: ok ? 0 : 1,
      durationMs: Math.round(performance.now() - started),
      costUsd: 0,
      workspaceDigest: await digestWorkspace(root),
      failureSignature: ok ? undefined : stderr,
    };
  }

  private async searchFiles(path: string, root: string, query: string, matches: string[]): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['.git', 'node_modules', 'target', 'dist'].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) await this.searchFiles(child, root, query, matches);
      else if (entry.isFile()) {
        let text: string;
        try { text = await readFile(child, 'utf8'); } catch { continue; }
        text.split('\n').forEach((line, index) => {
          if (line.includes(query)) matches.push(`${relative(root, child)}:${index + 1}:${line.slice(0, 300)}`);
        });
      }
    }
  }
}

export interface EvaluatorCommand {
  id: string;
  command: string;
  protected?: boolean;
  weight?: number;
}

export interface CommandEvaluatorOptions {
  version: string;
  branchPath(branchId: string): string;
  executorFor(cwd: string): ToolExecutor;
  commands: EvaluatorCommand[];
}

/** Command-backed evaluator suite: scoring consumes only observed process receipts. */
export class CommandEvaluatorSuite implements EvaluatorSuite {
  readonly version: string;
  constructor(private readonly options: CommandEvaluatorOptions) { this.version = options.version; }

  async evaluate(branchId: string, parent?: EvaluationResult): Promise<EvaluationResult> {
    const cwd = this.options.branchPath(branchId);
    const evidence: Record<string, unknown> = {};
    let passedWeight = 0;
    let totalWeight = 0;
    let wallTimeMs = 0;
    let violations = 0;
    let protectedTestsPassed = true;
    let failureSignature: string | undefined;
    for (const spec of this.options.commands) {
      const result = await this.options.executorFor(cwd).execute({
        command: spec.command,
        classification: allowedClassification(spec.command),
        approved: true,
      });
      evidence[spec.id] = result;
      const weight = spec.weight ?? 1;
      totalWeight += weight;
      wallTimeMs += result.durationMs;
      if (!result.policyReceipt.authorized) violations += 1;
      if (result.exitCode === 0) passedWeight += weight;
      else {
        if (spec.protected) protectedTestsPassed = false;
        failureSignature ??= `${spec.id}:exit:${result.exitCode}:${result.stderr.slice(-120)}`;
      }
    }
    const quality = totalWeight === 0 ? 0 : passedWeight / totalWeight;
    return {
      evaluatorVersion: this.version,
      correct: quality === 1,
      safe: violations === 0,
      replayable: true,
      noRegression: parent === undefined || quality >= parent.quality,
      budgetValid: true,
      quality,
      costUsd: 0,
      wallTimeMs,
      policyViolations: violations,
      protectedTestsPassed,
      evidence,
      failureSignature,
    };
  }
}
