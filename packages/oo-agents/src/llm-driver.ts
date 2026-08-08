// @metaharness/oo-agents — a real-LLM ModelDriver.
//
// WHY this exists: the package ships a deterministic ScriptedDriver for tests
// and simulation, and the header comments elsewhere say "real LLM drivers are
// host wiring, out of scope here." That is true for MODEL ROUTING — the kernel
// owns which model answers, its keys, streaming, retries-over-the-wire, etc.
// But the SHAPE of a real driver — how the assembled AgenticContext becomes a
// prompt, how one cell of cellscript is coaxed out of a free-form completion,
// and how a malformed completion is recovered — is package concern, not host
// concern, and it is testable without a network. LlmDriver captures exactly
// that shape while staying model-agnostic:
//
//   The injected `complete` function is the ONLY model seam. It is an async
//   (prompt: string) => Promise<string>. The kernel supplies the real one
//   (routing to whatever model it chose); this package never imports an SDK,
//   never reads an API key, never touches the network. Swap in MockCompletion
//   and the exact same driver runs deterministically offline. This keeps the
//   "dependency-free at runtime, Node builtins only" rule intact: nothing here
//   reaches past the seam.
//
// Determinism note: LlmDriver contains NO Date.now / Math.random. Its only
// nondeterminism is whatever the injected `complete` returns; with a scripted
// completion the whole driver is a pure function of its inputs.

import { AgenticContext, DriverStep, ModelDriver } from './agent.js';
import { renderContext } from './driver.js';

/** The one and only model seam: given a fully-rendered prompt, return the
 *  model's raw completion text. The kernel implements this against the real
 *  model it routed to; tests implement it with MockCompletion. Async because a
 *  real model call is I/O; the sandbox capabilities stay synchronous (async
 *  work lives out here in the driver, per the package's design). */
export type CompletionFn = (prompt: string) => Promise<string>;

export interface LlmDriverOptions {
  /** How many extra completions to request when a completion yields no
   *  extractable code before giving up. Default 2 (so 3 attempts total). This
   *  is the in-driver recovery for a chatty/empty model turn; it is distinct
   *  from the runtime's typed-contract auto-retry, which lives in Runtime. */
  maxNoCodeRetries?: number;
}

/** The strict instruction appended to every rendered context. It tells the
 *  model the contract of THIS package's loop: emit exactly one cell of
 *  cellscript, and nothing else. Kept as a named constant so tests can assert
 *  it is present and so the wording is reviewed in one place. */
export const CELL_INSTRUCTION = [
  '',
  'INSTRUCTION: Emit EXACTLY ONE cell of cellscript to run next — no prose,',
  'no explanation, no multiple cells. Read state via self.field and call',
  'capabilities via self.method(...). When you have the answer, finish the',
  'cell with return_result(value) matching the RETURN CONTRACT. Wrap the cell',
  'in a single ```cellscript fenced block.',
].join('\n');

/** A ModelDriver backed by a real (or mock) text-completion model.
 *
 *  Each `next()`:
 *    1. renders the running AgenticContext with the shared renderContext(),
 *       so an LLM driver and the ScriptedDriver agree on what the model sees;
 *    2. appends CELL_INSTRUCTION;
 *    3. calls the injected completion seam;
 *    4. extracts one cell of code from the completion (fenced or plain);
 *    5. on no extractable code, re-asks with an added nudge, bounded by
 *       maxNoCodeRetries, then throws an actionable error.
 */
export class LlmDriver implements ModelDriver {
  private readonly maxNoCodeRetries: number;

  constructor(
    private readonly complete: CompletionFn,
    options: LlmDriverOptions = {},
  ) {
    this.maxNoCodeRetries = options.maxNoCodeRetries ?? 2;
  }

  /** Build the exact prompt string the model receives for this context. Split
   *  out from next() so tests can assert renderContext's output is embedded. */
  buildPrompt(ctx: AgenticContext): string {
    return renderContext(ctx) + '\n' + CELL_INSTRUCTION;
  }

  async next(ctx: AgenticContext): Promise<DriverStep> {
    const basePrompt = this.buildPrompt(ctx);
    let prompt = basePrompt;
    let lastCompletion = '';

    // attempt 0 is the real ask; attempts 1..maxNoCodeRetries are recoveries.
    for (let attempt = 0; attempt <= this.maxNoCodeRetries; attempt++) {
      lastCompletion = await this.complete(prompt);
      const code = extractCode(lastCompletion);
      if (code !== null) {
        return { kind: 'cell', code };
      }
      // No runnable code came back — add a sharper nudge and try again. We keep
      // the base prompt (full context) and append the failure so the model can
      // correct, mirroring the runtime's feed-the-error-back philosophy.
      prompt =
        basePrompt +
        '\n\nYOUR LAST REPLY HAD NO RUNNABLE CELL. Reply with ONLY a single' +
        ' ```cellscript fenced code block and nothing else.';
    }

    throw new Error(
      `LlmDriver: no extractable cell after ${this.maxNoCodeRetries + 1} attempts; ` +
        `last completion was: ${JSON.stringify(truncate(lastCompletion, 200))}`,
    );
  }
}

/** Extract one cell of cellscript from a raw model completion.
 *
 *  Handles, in priority order:
 *    - fenced blocks: ```lang\n...\n``` (any/no language tag) — the FIRST
 *      fenced block wins, which is the "emit ONE cell" contract even when a
 *      chatty model appends extra blocks;
 *    - plain code: no fence at all — the whole trimmed completion is the cell,
 *      provided it contains something that looks like code (see looksLikeCode).
 *
 *  Returns null when nothing runnable can be found, which drives the retry.
 *  Kept a pure free function (no `this`) so it is trivially unit-testable and
 *  reusable by any future driver. */
export function extractCode(completion: string): string | null {
  // A fence is three backticks, an optional language token, a newline, the
  // body, then a closing fence of three backticks. Non-greedy body so the
  // FIRST complete block is taken. `[\s\S]` matches across newlines without
  // relying on the (non-portable) dotAll flag semantics.
  const fenceRe = /```[^\n`]*\n([\s\S]*?)```/;
  const fenced = fenceRe.exec(completion);
  if (fenced) {
    const body = fenced[1].replace(/\s+$/, '');
    if (body.trim().length > 0) return body;
    // Empty fenced block — fall through to plain handling / null.
  }

  const trimmed = completion.trim();
  if (trimmed.length === 0) return null;

  // No usable fence: accept the raw text only if it plausibly IS code, so a
  // pure-prose refusal ("I cannot help with that") drives the retry instead of
  // being fed to the VM as a guaranteed syntax error.
  if (looksLikeCode(trimmed)) return trimmed;
  return null;
}

/** Heuristic: does this text look like a cellscript cell rather than prose?
 *  Deliberately permissive — a false positive just becomes a VM syntax error
 *  the model sees next turn, whereas a false negative wastes a retry. We look
 *  for the loop's signature call, an assignment/self access, or call syntax. */
function looksLikeCode(text: string): boolean {
  return (
    text.includes('return_result(') ||
    text.includes('self.') ||
    /\blet\s+\w+\s*=/.test(text) ||
    /\bprint\s*\(/.test(text) ||
    /\w+\s*\([^)]*\)/.test(text)
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** A deterministic, scripted CompletionFn for tests and simulation.
 *
 *  WHY: it lets the SAME LlmDriver code path run offline with zero network and
 *  zero nondeterminism, so tests exercise prompt-building, code-extraction, and
 *  the no-code retry without ever touching a model. It maps a zero-based call
 *  count to a canned completion string.
 *
 *  Two response forms:
 *    - string: the completion returned for that call index;
 *    - (prompt, i) => string: computed from the prompt (e.g. to assert the
 *      rendered context is present, or to branch on prior-cell output).
 *
 *  When calls run past the end of the script, the LAST response repeats — a
 *  convenience so a "keep returning the final answer" model is one entry, not
 *  N. Pass `strict: true` to instead throw when the script is exhausted. */
export class MockCompletion {
  private i = 0;
  /** Every prompt this mock has been asked, in order — tests assert on these
   *  to prove renderContext / CELL_INSTRUCTION reached the model seam. */
  readonly prompts: string[] = [];

  constructor(
    private readonly responses: Array<string | ((prompt: string, i: number) => string)>,
    private readonly strict = false,
  ) {
    if (responses.length === 0) throw new Error('MockCompletion needs at least one response');
  }

  /** The number of times the seam has been invoked so far. */
  get calls(): number {
    return this.i;
  }

  /** The CompletionFn to hand to an LlmDriver. Bound so it can be passed by
   *  reference (`new LlmDriver(mock.fn)`). */
  fn: CompletionFn = async (prompt: string): Promise<string> => {
    this.prompts.push(prompt);
    const idx = this.i++;
    if (idx >= this.responses.length) {
      if (this.strict) throw new Error(`MockCompletion exhausted at call ${idx}`);
    }
    const pick = this.responses[Math.min(idx, this.responses.length - 1)];
    return typeof pick === 'function' ? pick(prompt, idx) : pick;
  };
}
