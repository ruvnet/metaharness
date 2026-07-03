// SPDX-License-Identifier: MIT
//
// ADR-228 §3 — the executor GENOME: the cheap executor's operating policy as a flat
// `components: dict[str,str]` of named TEXT components (GEPA's native candidate format — zero
// adapter impedance with `gepa.optimize(seed_candidate=dict[str,str], ...)`).
//
// TypeScript port of bench/swebench/gepa/genome.mjs (the in-repo reference implementation, which
// stays authoritative for the SWE-bench harness). Behavior-preserving: the seed genome reassembles
// byte-identical to the bench prompt builders — enforced by __tests__/gepa-genome.test.ts.
//
// Genome field → component key(s) (ADR-228 §3 table):
//   executor_prompt    executor_preamble, protocol_reminder
//   tool_policy        tool_ls .. tool_submit (the seven {"tool":…} description lines)
//   retrieval_policy   retrieval_policy
//   edit_policy        edit_policy
//   test_policy        test_policy
//   escalation_policy  tool_advise, escalation_policy
//   verifier_prompt    verifier_prompt
//
// `{{ext}}` / `{{glob}}` placeholders preserve the ADR-192 polyglot templating. Components with
// empty-string values are OFF (the solo/D0 seed has empty escalation_policy + verifier_prompt).
// Non-mutable structure (tool order, joining rules) lives in code, not in the candidate — GEPA
// mutates component TEXT only (ADR-228 §6: no architecture search in run 1).

/** Lineage/provenance metadata carried by a genome. */
export interface GenomeMeta {
  id?: string;
  parent?: string | null;
  source?: string;
  notes?: string;
  /** The component name changed by the mutation that produced this genome. */
  mutated?: string;
}

/** A GEPA candidate: named TEXT components (dict[str,str]) + lineage metadata. */
export interface Genome {
  version?: number;
  meta?: GenomeMeta;
  components: Record<string, string>;
}

/** Substitute the polyglot placeholders. */
export function renderComponent(text: string, ext = 'py', glob = '*.py'): string {
  return String(text).replaceAll('{{ext}}', ext).replaceAll('{{glob}}', glob);
}

/** Tool rendering order — structure, not genome (a mutation cannot reorder or add tools in run 1). */
export const TOOL_ORDER = ['ls', 'read', 'grep', 'edit', 'line_edit', 'run_tests', 'submit'] as const;

/**
 * The SEED genome — extracted verbatim (placeholders aside) from the bench prompt builders
 * (buildAgenticSystem / buildAdvisedSystem / buildAdvisorSystem). DO NOT edit these strings by
 * hand: the byte-equivalence test will fail if they drift from agentic-loop.mjs / advisor-loop.mjs.
 */
export const SEED_GENOME: Genome = {
  version: 1,
  meta: {
    id: 'seed-agentic-v1',
    parent: null,
    source: 'extracted from agentic-loop.mjs buildAgenticSystem + advisor-loop.mjs (ADR-228 §3)',
    notes: 'escalation/verifier components present but OFF in solo (D0) rendering unless enabled',
  },
  components: {
    executor_preamble:
      'You are an autonomous bug-fixing agent working inside a real repository. Each turn, output EXACTLY '
      + 'ONE JSON object on a single line — a tool call — and NOTHING else (no prose, no markdown, no XML). '
      + 'Do NOT use <invoke> XML syntax. Do NOT prefix with >>>. Just the raw JSON object. Tools:',
    tool_ls: '{"tool":"ls","dir":"path/"}            list a directory',
    tool_read: '{"tool":"read","path":"f.{{ext}}","start":1,"end":80}  read a file (range optional; omit for whole file)',
    tool_grep: '{"tool":"grep","pattern":"reg","glob":"{{glob}}"}     search the repo (glob optional)',
    tool_edit: '{"tool":"edit","path":"f.{{ext}}","search":"<exact lines incl. indentation>","replace":"<new lines>"}  apply a search/replace edit',
    tool_line_edit: '{"tool":"line_edit","path":"f.{{ext}}","start":12,"end":15,"replace":"<new text for lines 12-15>"}  replace an inclusive LINE RANGE (robust — line numbers come from `read`)',
    tool_run_tests: '{"tool":"run_tests"}                   run the failing tests against your current edits; returns the trace',
    tool_submit: '{"tool":"submit"}                      finalize your patch and stop',
    retrieval_policy:
      'Strategy: explore (read/grep/ls) to locate the fix, make minimal edit(s), run_tests, iterate on '
      + 'the trace, then submit once tests pass.',
    edit_policy:
      'PREFER line_edit (use the line numbers from `read`) — it is far '
      + 'more reliable than search/replace, which must match the file character-for-character. If an `edit` fails '
      + 'to match, switch to line_edit.',
    test_policy: 'Never edit test files.',
    protocol_reminder: 'Output ONE JSON action per turn.',
    // Advisor-mode components (buildAdvisedSystem / buildAdvisorSystem). OFF unless rendered with
    // { advised: true } — the solo/D0 genome ignores them, byte-matching buildAgenticSystem.
    tool_advise:
      '{"tool":"advise","question":"<what you are unsure about — the plan, the root cause, or whether your fix is right>"}  '
      + 'consult your STRONG read-only advisor; it sees your full transcript + current diff and replies with guidance',
    escalation_policy:
      'You are a fast agent with a STRONG senior ADVISOR on call. The advisor cannot run tools or edit — it only '
      + 'critiques. Consult it when uncertain about the plan, the root cause, or fix correctness — never for mechanical '
      + 'steps you can just do. Its reply is guidance; YOU still choose and execute every action. Your final submit is '
      + 'automatically reviewed by the advisor.',
    verifier_prompt:
      'You are a READ-ONLY senior engineer reviewing an autonomous junior bug-fixing agent mid-task. You will '
      + 'receive: the problem statement, the agent\'s full action/observation transcript, the current working-tree diff, '
      + 'and a PHASE tag. You cannot execute tools or edit files, and you must NOT output JSON tool calls — reply in '
      + 'plain prose, ≤300 words: (1) is the diagnosis/root-cause right? (2) is the diff correct, minimal, '
      + 'non-test-touching? (3) the exact next 1-3 actions (file, line, what to change — e.g. which .{{ext}} file). '
      + 'Reference only files present in the transcript or diff. If PHASE is pre-submit, your FIRST line must be '
      + 'exactly `VERDICT: APPROVE` or `VERDICT: REVISE — <one-line reason>`.',
  },
};

const REQUIRED_COMPONENTS = [
  'executor_preamble', 'tool_ls', 'tool_read', 'tool_grep', 'tool_edit', 'tool_line_edit',
  'tool_run_tests', 'tool_submit', 'retrieval_policy', 'edit_policy', 'test_policy', 'protocol_reminder',
];

/** Validate a genome object. Returns a list of problems ([] = valid). */
export function validateGenome(genome: unknown): string[] {
  const problems: string[] = [];
  if (!genome || typeof genome !== 'object') return ['genome is not an object'];
  const g = genome as Genome;
  if (!g.components || typeof g.components !== 'object') return ['genome.components missing'];
  for (const k of REQUIRED_COMPONENTS) {
    if (typeof g.components[k] !== 'string' || !g.components[k].trim()) problems.push(`component ${k} missing or empty`);
  }
  for (const [k, v] of Object.entries(g.components)) {
    if (typeof v !== 'string') problems.push(`component ${k} is not a string (GEPA candidates are dict[str,str])`);
  }
  return problems;
}

/**
 * Reassemble the executor SYSTEM PROMPT from a genome. `advised: true` renders the advisor-mode
 * prompt (advise tool line inserted before submit + escalation framing appended) — byte-identical
 * to buildAdvisedSystem for the seed; default renders the solo/D0 prompt — byte-identical to
 * buildAgenticSystem for the seed. Pure; never mutates the genome (verified-contract rule 3).
 */
export function buildSystemFromGenome(
  genome: Genome, ext = 'py', glob = '*.py', { advised = false }: { advised?: boolean } = {},
): string {
  const c = genome.components;
  const r = (t: string) => renderComponent(t, ext, glob);
  const toolLines = TOOL_ORDER.map((n) => r(c[`tool_${n}`]));
  if (advised && c.tool_advise) toolLines.splice(TOOL_ORDER.indexOf('submit'), 0, r(c.tool_advise));
  const strategy = [c.retrieval_policy, c.edit_policy, c.test_policy, c.protocol_reminder]
    .filter((s) => s && s.trim()).map(r).join(' ');
  let system = r(c.executor_preamble) + '\n' + toolLines.map((l) => l + '\n').join('') + strategy;
  if (advised && c.escalation_policy) system += '\n\n' + r(c.escalation_policy);
  return system;
}

/** Render the advisor/verifier system prompt from the genome (advisor-arm genomes only). */
export function buildAdvisorSystemFromGenome(genome: Genome, ext = 'py'): string {
  return renderComponent(genome.components.verifier_prompt || '', ext, '');
}

/** Deep-clone a genome and apply a single-component text mutation (fresh object, never in-place). */
export function mutateComponent(
  genome: Genome, componentName: string, newText: string,
  { id, notes }: { id?: string; notes?: string } = {},
): Genome {
  if (!(componentName in genome.components)) throw new Error(`unknown component: ${componentName}`);
  return {
    ...genome,
    meta: { ...genome.meta, id: id || `${genome.meta?.id || 'genome'}+${componentName}`, parent: genome.meta?.id || null, mutated: componentName, notes: notes || genome.meta?.notes },
    components: { ...genome.components, [componentName]: String(newText) },
  };
}

/** Load + validate a genome JSON file (readFileSync injected — keeps this module dependency-free). */
export function loadGenome(readFileSync: (path: string, encoding: 'utf8') => string, path: string): Genome {
  const genome = JSON.parse(readFileSync(path, 'utf8')) as Genome;
  const problems = validateGenome(genome);
  if (problems.length) throw new Error(`invalid genome ${path}: ${problems.join('; ')}`);
  return genome;
}
