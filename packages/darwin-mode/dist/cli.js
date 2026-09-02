#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Darwin Mode CLI. Verbs:
//
//   metaharness-darwin evolve <repo> [--generations N] [--children N]
//                                    [--concurrency N] [--seed N]
//                                    [--bench <suite.json>] [--tie faster]
//   metaharness-darwin bench create <repo> [--out <suite.json>]
//   metaharness-darwin bench verify <suite.json>
//
// Writes a self-describing `.metaharness/` work tree under the repo and prints a
// leaderboard + the winner's lineage. Dependency-free.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evolve } from './evolve.js';
import { RuvllmMutator } from './ruvllm-mutator.js';
import { profileRepo } from './repo_profiler.js';
import { loadSuite, makeSuite, saveSuite, verifySuite } from './bench/suite.js';
import { runBenchmark, renderReport } from './security/index.js';
import { evolveNumeric } from './numeric-evolve.js';
import { ShellEvaluator } from './numeric-evaluator.js';
function flag(name, fallback) {
    const i = process.argv.indexOf(name);
    return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
function num(name, fallback) {
    const v = Number(flag(name, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
}
function printReport(result) {
    const scored = result.records
        .filter((r) => r.score)
        .sort((a, b) => (b.score?.finalScore ?? 0) - (a.score?.finalScore ?? 0));
    process.stdout.write('\nDarwin Mode — leaderboard\n');
    for (const r of scored.slice(0, 10)) {
        const s = r.score;
        const tag = r.variant.id === result.winner?.variant.id ? ' ◀ winner' : '';
        process.stdout.write(`  ${s.finalScore.toFixed(3)}  ${r.variant.id}` +
            `  [${r.variant.mutationSurface}]  safety=${s.safetyScore.toFixed(2)}` +
            `  pass=${s.testPassRate.toFixed(2)}${tag}\n`);
    }
    if (result.winner) {
        process.stdout.write(`\nWinner: ${result.winner.variant.id}\n`);
        process.stdout.write(`Lineage: ${result.winnerLineage.join(' → ')}\n`);
        const base = result.baseline.score?.finalScore ?? 0;
        const win = result.winner.score?.finalScore ?? 0;
        process.stdout.write(`Delta over baseline: ${(win - base >= 0 ? '+' : '')}${(win - base).toFixed(3)}\n`);
    }
    else {
        process.stdout.write('\nNo scored variants.\n');
    }
}
/** `bench create <repo>` / `bench verify <suite.json>` (ADR-076). */
async function runBench() {
    const sub = process.argv[3];
    if (sub === 'create') {
        const repoRoot = resolve(process.argv[4] ?? process.cwd());
        const profile = await profileRepo(repoRoot);
        const out = resolve(flag('--out', resolve(repoRoot, '.metaharness/bench.json')));
        // A scaffold task pinned to the repo's own test command. Hidden/regression
        // commands are placeholders to be replaced with human-curated held-out tests.
        const task = {
            id: 'task-0001',
            repo: repoRoot,
            commit: 'WORKDIR',
            title: 'Repo native smoke task',
            prompt: 'Keep the repository test suite green.',
            publicTestCommand: profile.testCommand,
            hiddenTestCommand: profile.testCommand,
            regressionTestCommand: profile.testCommand,
            timeoutMs: 300000,
            maxCostUsd: 2,
            allowedMutationFiles: [],
            blockedFiles: ['.env', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.github/workflows'],
            successCriteria: ['public test passes', 'hidden test passes', 'regression suite passes'],
            difficulty: 1,
            tags: ['smoke', 'repo-native'],
        };
        const suite = makeSuite('repo-native', '0.1.0', [task]);
        await saveSuite(out, suite);
        process.stdout.write(`Wrote suite (${suite.tasks.length} task, hash ${suite.taskHash.slice(0, 12)}…): ${out}\n`);
        return;
    }
    if (sub === 'verify') {
        const file = resolve(process.argv[4] ?? '');
        const suite = await loadSuite(file); // throws on tamper
        const check = verifySuite(suite);
        process.stdout.write(`Suite ${suite.id}@${suite.version}: ${suite.tasks.length} tasks, hash ${check.ok ? 'OK' : 'MISMATCH'} (${check.actual.slice(0, 12)}…)\n`);
        return;
    }
    process.stderr.write('usage: metaharness-darwin bench <create|verify> …\n');
    process.exit(1);
}
function printNumericReport(result) {
    const scored = result.records
        .filter((r) => r.score)
        .sort((a, b) => (b.score?.primary ?? -Infinity) - (a.score?.primary ?? -Infinity));
    process.stdout.write('\nDarwin Mode (numeric genome) — leaderboard\n');
    for (const r of scored.slice(0, 10)) {
        const s = r.score;
        const tag = r.variant.id === result.winner?.variant.id ? ' ◀ winner' : '';
        const genomeStr = Object.entries(r.variant.genome)
            .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toPrecision(4) : v}`)
            .join(' ');
        process.stdout.write(`  primary=${s.primary.toFixed(4)}  ${r.variant.id}  regressed=${s.regressed}  {${genomeStr}}${tag}\n`);
    }
    if (result.winner) {
        process.stdout.write(`\nWinner: ${result.winner.variant.id}\n`);
        process.stdout.write(`Lineage: ${result.winnerLineage.join(' → ')}\n`);
        const base = result.baseline.score?.primary ?? 0;
        const win = result.winner.score?.primary ?? 0;
        process.stdout.write(`Delta over baseline: ${(win - base >= 0 ? '+' : '')}${(win - base).toFixed(4)}\n`);
    }
    else {
        process.stdout.write('\nNo scored variants.\n');
    }
}
/**
 * `evolve-numeric <repo> --genome <spec.json> --evaluator "<cmd> [args...]"`
 * (ADR-272). A second, parallel genome kind alongside the seven-surface prompt
 * kind above: a bounded vector of named numeric parameters (e.g. ML training
 * hyperparameters), mutated by bounded perturbation/crossover instead of code
 * generation, and scored by the caller-supplied `--evaluator` command instead
 * of the built-in sandbox — Darwin Mode never trains or scores anything itself
 * for this kind, it only ever shells out to that command once per candidate.
 */
async function runEvolveNumeric() {
    const repoRoot = resolve(process.argv[3] ?? process.cwd());
    const workRoot = resolve(repoRoot, '.metaharness-numeric');
    const genomePath = flag('--genome', '');
    if (!genomePath) {
        process.stderr.write('evolve-numeric requires --genome <spec.json>\n');
        process.exit(1);
        return;
    }
    const genomeSpec = JSON.parse(await readFile(resolve(genomePath), 'utf8'));
    const evaluatorCmd = flag('--evaluator', '');
    if (!evaluatorCmd) {
        process.stderr.write('evolve-numeric requires --evaluator "<command> [args...]"\n');
        process.exit(1);
        return;
    }
    // Simple whitespace split — the evaluator is a fixed, operator-supplied
    // command (never untrusted input), matching how `--mutator`/`--ruvllm-url`
    // are already taken as trusted CLI flags elsewhere in this file.
    const evaluatorArgv = evaluatorCmd.split(/\s+/).filter(Boolean);
    const result = await evolveNumeric({
        genomeSpec,
        evaluator: new ShellEvaluator({ command: evaluatorArgv, cwd: repoRoot, timeoutMs: num('--evaluator-timeout-ms', 120_000) }),
        generations: num('--generations', 3),
        childrenPerGeneration: num('--children', 4),
        concurrency: num('--concurrency', 4),
        seed: num('--seed', 0),
        mutationSigma: (() => {
            const v = Number(flag('--sigma', '0.2'));
            return Number.isFinite(v) ? v : 0.2;
        })(),
        crossover: process.argv.includes('--crossover'),
        workRoot,
    });
    printNumericReport(result);
    process.stdout.write(`\nArtifacts: ${workRoot}\n`);
}
/** `security bench` (ADR-155, Darwin Shield). Runs DARWIN-SHIELD-BENCH. */
function runSecurity() {
    const sub = process.argv[3];
    if (sub !== 'bench') {
        process.stderr.write('usage: metaharness-darwin security bench [--population N] [--cycles N] [--seed N]\n');
        process.exit(1);
    }
    const report = runBenchmark({
        population: num('--population', 16),
        cycles: num('--cycles', 50),
        seed: num('--seed', 0),
    });
    process.stdout.write(renderReport(report));
    process.stdout.write(`\nOverall: ${report.passed ? 'PASS' : 'FAIL'}\n`);
    if (!report.passed)
        process.exit(1);
}
async function main() {
    const command = process.argv[2];
    if (command === 'security') {
        runSecurity();
        return;
    }
    if (command === 'bench') {
        await runBench();
        return;
    }
    if (command === 'evolve-numeric') {
        await runEvolveNumeric();
        return;
    }
    if (command !== 'evolve') {
        process.stderr.write('usage: metaharness-darwin <evolve|evolve-numeric|bench|security> …\n' +
            '  evolve <repo> [--generations N] [--children N] [--concurrency N] [--seed N] [--bench <suite.json>] [--tie faster] [--selection quality-diversity|behavioral-diversity|niche-steering|clade|pareto] [--crossover] [--epistasis] [--risk-budget N] [--fdr Q] [--curriculum] [--sandbox real|mock|agent] [--mutator deterministic|ruvllm] [--ruvllm-url URL] [--ruvllm-model M]\n' +
            '  evolve-numeric <repo> --genome <spec.json> --evaluator "<cmd> [args...]" [--generations N] [--children N] [--concurrency N] [--seed N] [--sigma F] [--crossover] [--evaluator-timeout-ms N]   (ADR-272, numeric genome kind)\n' +
            '  bench create <repo> [--out <suite.json>]\n' +
            '  bench verify <suite.json>\n' +
            '  security bench [--population N] [--cycles N] [--seed N]   (ADR-155 Darwin Shield)\n');
        process.exit(1);
    }
    const repoRoot = resolve(process.argv[3] ?? process.cwd());
    const workRoot = resolve(repoRoot, '.metaharness');
    // Opt-in graded promotion (ADR-076/087): --bench <suite.json> loads a
    // hash-verified suite (throws on tamper) and routes promotion through the
    // statistical gate. --tie faster opts into efficiency tie-breaking (ADR-086).
    const benchPath = flag('--bench', '');
    const benchSuite = benchPath ? await loadSuite(resolve(benchPath)) : undefined;
    const tieBreaker = flag('--tie', 'insertion') === 'faster' ? 'faster' : 'insertion';
    const selRaw = flag('--selection', 'score');
    const selection = selRaw === 'quality-diversity' ||
        selRaw === 'behavioral-diversity' ||
        selRaw === 'niche-steering' ||
        selRaw === 'clade' ||
        selRaw === 'pareto'
        ? selRaw
        : 'score';
    const crossover = process.argv.includes('--crossover');
    const epistasis = process.argv.includes('--epistasis');
    const riskArg = flag('--risk-budget', '');
    const riskBudgetTotal = riskArg === '' ? undefined : num('--risk-budget', 0);
    const fdrArg = flag('--fdr', '');
    const fdrQ = fdrArg === '' ? undefined : num('--fdr', 0.05);
    const curriculum = process.argv.includes('--curriculum');
    const sbRaw = flag('--sandbox', 'real');
    const sandboxMode = sbRaw === 'mock' || sbRaw === 'agent' ? sbRaw : 'real';
    // ADR-099/102: 'real' (the default — no --sandbox flag passed) scores every
    // variant by the target repo's own test command, which none of the mutated
    // harness surfaces are wired into. That makes the trace surface-independent:
    // every variant lands on the identical score (measured: nicheEntropy=0,
    // finalScore flat at 0.985) and evolution has no selection pressure to act
    // on. This is documented in the README, but a first run of `evolve` with no
    // flags gives no signal at the point it actually matters — say so here.
    if (sandboxMode === 'real') {
        process.stderr.write("note: --sandbox real (the default) scores variants by this repo's own test\n" +
            'command, which cannot distinguish between mutated harness surfaces — every\n' +
            'variant will score identically and evolution will not converge on anything\n' +
            '(see README "The evaluation substrate", ADR-099/102). Pass --sandbox mock\n' +
            '(fast, deterministic) or --sandbox agent (executes the real surface code)\n' +
            'for genuine evolutionary signal.\n');
    }
    // ADR-259: pluggable mutator backend. Default = deterministic (no network, no key).
    // --mutator ruvllm routes mutations to a local `ruvllm serve` endpoint (fully local,
    // air-gapped, zero API cost). The OpenRouter LLM mutator stays library-only.
    const mutatorRaw = flag('--mutator', 'deterministic');
    const generator = mutatorRaw === 'ruvllm'
        ? new RuvllmMutator({ baseUrl: flag('--ruvllm-url', '') || undefined, model: flag('--ruvllm-model', '') || undefined })
        : undefined;
    const result = await evolve({
        repoRoot,
        workRoot,
        generations: num('--generations', 3),
        childrenPerGeneration: num('--children', 4),
        concurrency: num('--concurrency', 4),
        seed: num('--seed', 0),
        promotionDelta: 0.05,
        tasks: [
            'run repository test suite',
            'verify generated harness safety',
            'check trace quality',
        ],
        ...(benchSuite ? { benchSuite } : {}),
        ...(riskBudgetTotal !== undefined ? { riskBudgetTotal } : {}),
        ...(fdrQ !== undefined ? { fdrQ } : {}),
        ...(curriculum ? { curriculum } : {}),
        ...(sandboxMode !== 'real' ? { sandboxMode } : {}),
        ...(generator ? { generator } : {}),
        tieBreaker,
        selection,
        crossover,
        epistasis,
    });
    printReport(result);
    process.stdout.write(`\nArtifacts: ${workRoot}\n`);
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map