import type { RepoProfile } from './types.js';
/**
 * Profile a repository at `root`. Walks the tree (skipping node_modules, .git,
 * .metaharness, dist), collects source/doc/json files, reads package.json if
 * present for tooling, and flags risk files. Never throws on an unreadable tree.
 */
export declare function profileRepo(root: string): Promise<RepoProfile>;
//# sourceMappingURL=repo_profiler.d.ts.map