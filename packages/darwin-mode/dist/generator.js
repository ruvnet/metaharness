// SPDX-License-Identifier: MIT
//
// Baseline generator (ADR-070 §generate) — turns a RepoProfile into the root
// "baseline" harness variant: a directory holding exactly the seven approved
// mutation-surface files (ADR-071). Every emitted file is pure policy logic and
// passes the safety inspection by construction.
//
// Dependency-free (Node built-ins only).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_BY_SURFACE } from './safety.js';
import { contextBuilderTemplate, memoryPolicyTemplate, plannerTemplate, retryPolicyTemplate, reviewerTemplate, scorePolicyTemplate, toolPolicyTemplate, } from './templates.js';
/**
 * Generate the baseline harness variant from a repo profile. Writes the seven
 * mutation-surface files (filenames per FILE_BY_SURFACE) into
 * `<workRoot>/variants/baseline/`, creating directories as needed, and returns
 * the variant descriptor. Generation 0, no parent.
 */
export async function generateBaselineHarness(profile, workRoot) {
    const dir = join(workRoot, 'variants', 'baseline');
    await mkdir(dir, { recursive: true });
    // Surface filename -> source text. Filenames come from the safety allowlist so
    // the generator and inspector can never drift apart.
    const files = {
        [FILE_BY_SURFACE.planner]: plannerTemplate(profile),
        [FILE_BY_SURFACE.contextBuilder]: contextBuilderTemplate(),
        [FILE_BY_SURFACE.reviewer]: reviewerTemplate(),
        [FILE_BY_SURFACE.retryPolicy]: retryPolicyTemplate(),
        [FILE_BY_SURFACE.toolPolicy]: toolPolicyTemplate(),
        [FILE_BY_SURFACE.memoryPolicy]: memoryPolicyTemplate(),
        [FILE_BY_SURFACE.scorePolicy]: scorePolicyTemplate(),
    };
    for (const [name, source] of Object.entries(files)) {
        await writeFile(join(dir, name), source, 'utf8');
    }
    return {
        id: 'baseline',
        parentId: null,
        generation: 0,
        dir,
        mutationSurface: 'planner',
        mutationSummary: 'baseline generated from repo profile',
        createdAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=generator.js.map