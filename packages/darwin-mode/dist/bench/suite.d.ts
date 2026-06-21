import type { BenchSuite, BenchmarkTask } from './types.js';
/** Stable SHA-256 over the canonicalised task list. */
export declare function hashTasks(tasks: BenchmarkTask[]): string;
/** Build a hash-pinned suite from a task list. */
export declare function makeSuite(id: string, version: string, tasks: BenchmarkTask[]): BenchSuite;
/** Recompute the hash and compare it to the recorded one. */
export declare function verifySuite(suite: BenchSuite): {
    ok: boolean;
    expected: string;
    actual: string;
};
/** Load a suite from disk and verify its hash (throws on tamper). */
export declare function loadSuite(file: string): Promise<BenchSuite>;
/** Persist a suite as pretty JSON, creating the parent directory. */
export declare function saveSuite(file: string, suite: BenchSuite): Promise<void>;
//# sourceMappingURL=suite.d.ts.map