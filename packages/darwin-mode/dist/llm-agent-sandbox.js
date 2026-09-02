// SPDX-License-Identifier: MIT
//
// LLM agent sandbox (ADR-273). Genuinely invokes a real LLM (the `claude` CLI)
// per variant, so a prompt-genome mutation can finally produce real behavioural
// signal. This is a FOURTH sandbox mode, alongside (not replacing) 'real' (repo
// test command, surface-independent), 'mock' (deterministic surface-driven sim,
// ADR-102), and 'agent' (Tier-2: executes the variant's real TypeScript surface
// code offline, ADR-106). Naming: 'llm-agent' to avoid colliding with the
// existing 'agent' (Tier-2) mode, which does not call any LLM.
//
// REAL SPEND: each task invocation is one real `claude -p` call and costs real
// API usage. The safety gate (`inspectVariant`) runs FIRST, exactly like the
// 'real' sandbox — a disqualified variant never reaches a real LLM call. A hard
// per-`evolve()`-call invocation cap is enforced by the CLI (see cli.ts), not
// here, so a caller building `EvolutionConfig` by hand must apply its own cap.
//
// Task design: each task asks a single, cheap, read-only, single-turn
// STYLE/PROCESS judgement question — not a security/ethics question — because
// those can trigger the model's own safety training regardless of what a
// variant's mutated surface guidance says, which would make a task falsely
// LOOK non-differentiating (a sandbox bug) when it is actually the model
// correctly overriding bad instructions. A process judgement (e.g. "does this
// tiny function need a test?") is not safety-trained territory, so appended
// surface guidance can genuinely and reliably steer the answer — the signal
// this sandbox exists to surface. Grading is deterministic: the task declares
// the policy-COMPLIANT answer (what a variant with the "good" reviewer/planner
// intent should produce); a matching real answer is exitCode 0 ("solved", same
// convention as the 'agent'/'mock' sandboxes), a mismatch is exitCode 1.
//
// No shell (`execFile`, argv split — no injection), scrubbed environment (PATH
// plus identifying variables only), `--restricted` (removes Bash/PowerShell/
// REPL and other command/code-execution tools — a single read-only judgement
// call has no legitimate use for them), `--permission-mode plan` (defense in
// depth on top of --restricted), no session persistence, and a hard wall-clock
// timeout. The task prompt and any fixture text are embedded directly in the
// prompt string (no --add-dir, no filesystem access from the child at all) so
// there is nothing on disk for the child process to read beyond argv.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { inspectVariant, FILE_BY_SURFACE } from './safety.js';
const execFileAsync = promisify(execFile);
/** Default per-invocation wall-clock budget (ms). Real LLM calls are slower than the offline sandboxes. */
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
/** Max bytes of the appended surface-guidance text spliced into the system prompt (keeps cost bounded). */
const MAX_SURFACE_BYTES = 4_000;
/**
 * One cheap, single-turn, style/process judgement task. Asks whether a tiny
 * new function needs a test — deliberately NOT a security/ethics question (see
 * module doc). A reviewer surface that says to require tests for non-trivial
 * logic should make the real agent answer YES; a surface that says test
 * coverage is optional for small utilities should make it answer NO.
 */
export const DEFAULT_LLM_AGENT_TASKS = [
    {
        id: 'llm-review-needs-test',
        surface: 'reviewer',
        prompt: 'A pull request adds this new function with no accompanying test:\n\n' +
            '```ts\nexport function computeDiscount(price: number, pct: number): number {\n' +
            '  return price - (price * pct) / 100;\n}\n```\n\n' +
            'As the code reviewer, should this PR be blocked until a test is added? ' +
            'Answer with exactly one word first, YES or NO, then one short sentence why.',
        desiredAnswer: 'YES',
        difficulty: 2,
    },
];
/** Read a variant's surface file, truncated, for splicing into the system prompt. Missing file -> empty string. */
async function readSurfaceGuidance(variantDir, surface) {
    try {
        const text = await readFile(`${variantDir}/${FILE_BY_SURFACE[surface]}`, 'utf8');
        return text.length > MAX_SURFACE_BYTES ? text.slice(0, MAX_SURFACE_BYTES) : text;
    }
    catch {
        return '';
    }
}
/** First whitespace-delimited token, uppercased — used to grade a YES/NO judgement answer. */
function firstWordUpper(text) {
    const m = /^\s*([A-Za-z]+)/.exec(text);
    return m ? m[1].toUpperCase() : '';
}
/**
 * Run ONE real-LLM judgement task against a variant. Calls `inspectVariant`
 * first (defense in depth, mirroring the 'real' sandbox); a disqualified
 * variant never reaches a real LLM call and is sealed with the reserved
 * DISQUALIFIED_EXIT_CODE (99), same convention as `sandbox.ts`.
 */
export async function runVariantTaskLlmAgent(variant, task, timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
    const startedAt = new Date().toISOString();
    const blocked = await inspectVariant(variant.dir);
    if (blocked.length > 0) {
        return {
            variantId: variant.id,
            taskId: task.id,
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: 99,
            stdout: '',
            stderr: 'disqualified by safety gate before any LLM call',
            durationMs: 0,
            timedOut: false,
            blockedActions: blocked,
        };
    }
    const guidance = await readSurfaceGuidance(variant.dir, task.surface);
    const systemPromptAppend = `Additional ${task.surface} guidance for this session, from the repository's own policy file ` +
        `(${FILE_BY_SURFACE[task.surface]}). Follow it when it bears on your answer:\n\n${guidance}`;
    const scrubbedEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        METAHARNESS_VARIANT: variant.id,
        METAHARNESS_TASK: task.id,
    };
    const args = [
        '-p',
        task.prompt,
        '--append-system-prompt',
        systemPromptAppend,
        '--permission-mode',
        'plan',
        '--restricted',
        '--output-format',
        'json',
        // NOTE: --bare (skips hooks/LSP/plugin-sync/CLAUDE.md auto-discovery, which
        // otherwise dominate real per-call cost via cache-creation tokens) was
        // tried and reverted here: it strictly requires ANTHROPIC_API_KEY auth
        // (never OAuth/keychain, by its own documented behaviour) and this
        // environment authenticates via OAuth/keychain, so every --bare call
        // failed with "Not logged in". A deployment with an API key configured
        // should add --bare back for materially lower real cost.
        // Intended as a cost lever (a cheap model should be adequate for a
        // single-turn YES/NO judgement; real spend scales with
        // generations*children, unlike every $0 sandbox). NOTE, from real
        // validation (ADR-273): 'haiku' did NOT route the primary judgement call
        // to claude-haiku in this environment -- real usage showed claude-sonnet-5
        // doing the actual reasoning each time (haiku only handled an unrelated
        // ~14-token side task), so real per-call cost was ~$0.04-0.09, not the
        // cheap target this flag was meant to hit. Left in place since it is not
        // harmful, but do not assume it is reducing cost without re-measuring.
        '--model',
        'haiku',
    ];
    let stdout = '';
    let stderr = '';
    let exitCode = 1;
    let timedOut = false;
    const start = Date.now();
    try {
        const res = await execFileAsync('claude', args, {
            timeout: timeoutMs,
            env: scrubbedEnv,
            maxBuffer: 1 << 20,
            windowsHide: true,
        });
        stdout = res.stdout;
        stderr = res.stderr;
    }
    catch (e) {
        const err = e;
        stdout = err.stdout ?? '';
        stderr = err.stderr ?? (err.message ?? 'claude invocation failed');
        timedOut = err.killed === true && err.signal === 'SIGTERM';
    }
    const durationMs = Date.now() - start;
    let answer = '';
    let isError = false;
    try {
        const parsed = JSON.parse(stdout);
        answer = firstWordUpper(parsed.result ?? '');
        isError = parsed.is_error === true;
    }
    catch {
        // Fall back to raw text if --output-format json did not parse (e.g. a CLI error before any output).
        answer = firstWordUpper(stdout);
    }
    const solved = !isError && !timedOut && (answer === 'YES' || answer === 'NO') && answer === task.desiredAnswer;
    exitCode = timedOut ? 1 : solved ? 0 : 1;
    return {
        variantId: variant.id,
        taskId: task.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        stdout: stdout.slice(0, 4_000),
        stderr: stderr.slice(0, 2_000),
        durationMs,
        timedOut,
        blockedActions: [],
    };
}
/** Run a variant against the real-LLM task suite (defaults to DEFAULT_LLM_AGENT_TASKS). */
export async function runVariantTasksLlmAgent(variant, tasks = DEFAULT_LLM_AGENT_TASKS, timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
    const traces = [];
    for (const task of tasks)
        traces.push(await runVariantTaskLlmAgent(variant, task, timeoutMs));
    return traces;
}
//# sourceMappingURL=llm-agent-sandbox.js.map