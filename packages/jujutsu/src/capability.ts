// SPDX-License-Identifier: MIT
//
// JujutsuCapability — the MetaHarness-facing facade over agentic-jujutsu's
// lock-free op-log / agent-coordination / trajectory / signing primitives.
//
// Honest capability reporting (kernel ethos): `probe()` tells you exactly which
// pieces are live. Construction NEVER half-loads — `create()` throws a typed
// CapabilityUnavailableError if the native addon is absent so callers can
// degrade explicitly. The native addon further needs the `jj` (Jujutsu) CLI
// for op-log/branch/diff calls; trajectory + coordination + signing work
// without it.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadAgenticJujutsu, loadAgenticow } from './loader.js';
import {
  CapabilityUnavailableError,
  type CapabilityReport,
  type JujutsuConfig,
  type OpDescriptor,
  type TrajectorySummary,
} from './types.js';

/** Minimal structural view of agentic-jujutsu's JjWrapper we depend on. */
interface RawWrapper {
  getConfig(): { jjPath: string; repoPath: string };
  getStats(): string;
  getOperations(limit: number): OpDescriptor[];
  getUserOperations(limit: number): OpDescriptor[];
  startTrajectory(task: string): string;
  addToTrajectory(): void;
  finalizeTrajectory(successScore: number, critique?: string | null): void;
  getSuggestion(task: string): string;
  getLearningStats(): string;
  getPatterns(): string;
  queryTrajectories(task: string, limit: number): string;
  registerAgent(agentId: string, agentType: string): Promise<void>;
  enableAgentCoordination(): Promise<void>;
  registerAgentOperation(agentId: string, operationId: string, files: string[]): Promise<string>;
  checkAgentConflicts(operationId: string, operationType: string, files: string[]): Promise<string>;
  getCoordinationStats(): Promise<string>;
  getCoordinationTips(): Promise<string[]>;
  branchCreate(name: string, revision?: string | null): Promise<unknown>;
  branchDelete(name: string): Promise<unknown>;
  undo(): Promise<unknown>;
  execute(args: string[]): Promise<unknown>;
}

interface RawModule {
  JjWrapper: new () => RawWrapper;
  QuantumSigner: unknown;
}

function asModule(m: unknown): RawModule | null {
  if (m && typeof (m as RawModule).JjWrapper === 'function') return m as RawModule;
  return null;
}

/** Probe which removable augmentations are live — never throws. */
export async function probe(config: JujutsuConfig = {}): Promise<CapabilityReport> {
  const notes: string[] = [];
  const mod = asModule(loadAgenticJujutsu());
  const opLog = mod !== null;
  if (!opLog) notes.push('agentic-jujutsu native addon not loadable (not installed or no prebuilt binary for this platform).');

  let jjPath = config.jjPath;
  if (opLog && !jjPath) {
    try {
      jjPath = new mod!.JjWrapper().getConfig().jjPath;
    } catch {
      /* ignore */
    }
  }
  const jjCli = resolveJjCli(jjPath);
  if (opLog && !jjCli) notes.push('jj (Jujutsu) CLI not found — op-log/branch/diff calls will fail; trajectory + coordination + signing still work.');

  const memory = (await loadAgenticow()) !== null;
  if (!memory) notes.push('agenticow not loadable — memory-branch side of the bridge is unavailable.');

  // agenticow@0.2.0 + @ruvector/rvf-node@0.2.0 (rvf-runtime PRs #617 + #618):
  // fork({nativeAnn:true}) creates a real COW child whose query() routes through
  // the Rust dual-graph ANN merge. AgenticowQueryProvider.nativeAnn = true.
  // recall@10 = 1.0000 verified (1200-vector L2, efSearch=300, Jun 2026).
  let annAcrossBranch = false;
  if (memory) {
    try {
      // agenticow@0.2.0+ adds the nativeAnn getter to AgenticMemory.prototype.
      // Detect it via the loaded module's prototype (avoids package.json subpath
      // restriction that blocks require('agenticow/package.json') in ESM).
      const cowMod = (await loadAgenticow()) as { AgenticMemory?: { prototype?: Record<string, unknown> } } | null;
      if (cowMod?.AgenticMemory?.prototype && 'nativeAnn' in cowMod.AgenticMemory.prototype) {
        annAcrossBranch = true;
      }
    } catch {
      /* agenticow version < 0.2.0 or not installed — native ANN not available */
    }
    if (!annAcrossBranch) {
      notes.push('agenticow < 0.2.0 detected — native ANN-across-branch unavailable; exact read-through in use.');
    }
  }

  return { opLog, memory, jjCli, annAcrossBranch, notes };
}

function resolveJjCli(jjPath?: string): boolean {
  if (jjPath && existsSync(jjPath)) return true;
  try {
    execFileSync(jjPath || 'jj', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True iff the agentic-jujutsu native addon is loadable. */
export function jujutsuAvailable(): boolean {
  return asModule(loadAgenticJujutsu()) !== null;
}

/**
 * Typed facade over a single JjWrapper instance. Groups the raw N-API surface
 * into op-log / coordination / trajectory namespaces and parses the JSON-string
 * returns into objects. JSON-returning getters are typed `unknown` — the shapes
 * are agentic-jujutsu's and we do not re-declare them all.
 */
export class JujutsuCapability {
  private constructor(private readonly w: RawWrapper) {}

  /** Construct against the live native addon. Throws if unavailable. */
  static create(): JujutsuCapability {
    const mod = asModule(loadAgenticJujutsu());
    if (!mod) throw new CapabilityUnavailableError('agentic-jujutsu');
    return new JujutsuCapability(new mod.JjWrapper());
  }

  /** Escape hatch to the raw wrapper for advanced callers. */
  get raw(): RawWrapper {
    return this.w;
  }

  // ---- op-log (needs jj CLI at runtime) -----------------------------------
  recentOps(limit = 50): OpDescriptor[] {
    return this.w.getOperations(limit);
  }
  userOps(limit = 50): OpDescriptor[] {
    return this.w.getUserOperations(limit);
  }
  stats(): unknown {
    return JSON.parse(this.w.getStats());
  }

  // ---- trajectory / ReasoningBank (no jj CLI needed) ----------------------
  startTrajectory(task: string): string {
    return this.w.startTrajectory(task);
  }
  addToTrajectory(): void {
    this.w.addToTrajectory();
  }
  finalizeTrajectory(successScore: number, critique?: string): TrajectorySummary {
    const id = ''; // wrapper does not return the id from finalize; caller tracks startTrajectory()
    this.w.finalizeTrajectory(successScore, critique ?? null);
    return { trajectoryId: id, successScore, critique, opCount: this.w.getUserOperations(1000).length };
  }
  suggestion(task: string): unknown {
    return safeJson(this.w.getSuggestion(task));
  }
  learningStats(): unknown {
    return JSON.parse(this.w.getLearningStats());
  }
  patterns(): unknown {
    return safeJson(this.w.getPatterns());
  }
  queryTrajectories(task: string, limit = 10): unknown {
    return safeJson(this.w.queryTrajectories(task, limit));
  }

  // ---- lock-free agent coordination (QuantumDAG) --------------------------
  async enableCoordination(): Promise<void> {
    await this.w.enableAgentCoordination();
  }
  async registerAgent(agentId: string, agentType: string): Promise<void> {
    await this.w.registerAgent(agentId, agentType);
  }
  async registerOperation(agentId: string, operationId: string, files: string[]): Promise<unknown> {
    return safeJson(await this.w.registerAgentOperation(agentId, operationId, files));
  }
  async checkConflicts(operationId: string, operationType: string, files: string[]): Promise<unknown> {
    return safeJson(await this.w.checkAgentConflicts(operationId, operationType, files));
  }
  async coordinationStats(): Promise<unknown> {
    return safeJson(await this.w.getCoordinationStats());
  }
  async coordinationTips(): Promise<string[]> {
    return this.w.getCoordinationTips();
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Pass-through to agentic-jujutsu's QuantumSigner (ML-DSA-65). Null if absent. */
export function quantumSigner(): unknown | null {
  return asModule(loadAgenticJujutsu())?.QuantumSigner ?? null;
}
