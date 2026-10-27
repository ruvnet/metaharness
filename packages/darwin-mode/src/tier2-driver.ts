// SPDX-License-Identifier: MIT
//
// Tier-2 agent driver (ADR-106). Runs in a CHILD process launched with
// `node --experimental-strip-types`, so it can import the variant's real surface
// `.ts` modules and execute their ACTUAL logic — not regex-extracted parameters
// (Tier 1, ADR-102). It drives a deterministic agent loop calling the surfaces'
// real exports and prints a JSON trace to stdout.
//
//   argv[2] = variant directory (contains the 7 surface .ts files)
//   argv[3] = task JSON: { prompt, files, buggyFile, classification, failAttempts, backoffMs }
//
// Standalone: imports ONLY the variant surfaces + node builtins (no package
// imports), so the child needs nothing from dist except this file. Deterministic
// (durationMs derived from the loop, not wall-clock) ⇒ reproducible.

interface AgentTask {
  prompt: string;
  files: string[];
  buggyFile: string;
  classification: 'transient' | 'repairable' | 'unknown';
  failAttempts: number;
  backoffMs: number;
}

async function main(): Promise<void> {
  const variantDir = process.argv[2];
  const task: AgentTask = JSON.parse(process.argv[3]);
  const log: string[] = [];

  // Import the variant's REAL surface modules (types stripped by the flag).
  const planner = await import(`${variantDir}/planner.ts`);
  const ctxb = await import(`${variantDir}/context_builder.ts`);
  const retry = await import(`${variantDir}/retry_policy.ts`);
  const tools = await import(`${variantDir}/tool_policy.ts`);

  // The agent must produce a plan that ends in verification.
  const plan = (planner.createPlan?.(task.prompt) ?? []) as Array<{ kind: string }>;
  const planOk = plan.length > 0 && plan.some((s) => s.kind === 'verify');
  log.push(`plan: ${plan.length} steps, verify=${planOk}`);

  // REAL toolPolicy: the policy's own contract is "cheap gates (lint/build)
  // before the expensive test run" (see tool_policy.ts's ORDER comment). A
  // policy that doesn't end its schedule on `test` — whether it reorders
  // test earlier or drops/filters kinds down to a degenerate schedule that
  // never reaches test last at all — forgoes the chance for a cheap gate to
  // catch the failure first, so it costs one extra verification attempt.
  // `order[order.length - 1]` is `undefined` for an empty schedule, which
  // correctly never equals `'test'` — a degenerate policy is penalized, not
  // silently treated as compliant.
  const order = (tools.orderKinds?.(['lint', 'test', 'build']) ?? []) as string[];
  const misorderPenalty = order[order.length - 1] !== 'test' ? 1 : 0;
  log.push(`tools: ${order.join('>')} misorderPenalty=${misorderPenalty}`);

  const maxA = (retry.maxAttempts ?? 3) as number;
  let solved = false;
  let attemptsUsed = 0;
  let ctxLen = 0;
  for (let attempt = 0; ; attempt++) {
    attemptsUsed = attempt + 1;
    // REAL contextBuilder: ranks files by overlap and slices to its window. The
    // bug is "located" only if the buggy file survives into the returned window.
    const ctx = (ctxb.buildContext?.(task.prompt, task.files) ?? []) as Array<{ path: string }>;
    ctxLen = ctx.length;
    const located = ctx.some((c) => c.path === task.buggyFile);
    log.push(`attempt ${attempt}: ctx=${ctx.length} located=${located}`);
    if (planOk && located && attempt >= task.failAttempts + misorderPenalty) {
      solved = true;
      log.push('verify: PASS');
      break;
    }
    // REAL retryPolicy decides persistence given the failure classification.
    const d = (retry.decideRetry?.(attempt, task.classification) ?? { retry: false, reason: 'no decideRetry' }) as {
      retry: boolean;
      reason: string;
    };
    if (!d.retry || attempt + 1 >= maxA) {
      log.push(`stop: ${d.reason}`);
      break;
    }
  }

  const durationMs = attemptsUsed * task.backoffMs + ctxLen;
  process.stdout.write(JSON.stringify({ solved, attemptsUsed, durationMs, log: log.join('\n') }));
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ solved: false, attemptsUsed: 0, durationMs: 0, log: `ERR ${(e as Error)?.message ?? e}` }));
});
