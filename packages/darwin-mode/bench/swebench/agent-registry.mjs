// SPDX-License-Identifier: MIT
// Open-Fugu / SWE-Conductor — the Agent Registry (ADR-176 / ADR-178-draft).
// A swappable pool of worker models with VERIFIED OpenRouter slugs/pricing and, crucially,
// **measured** role-fit from this repo's own conformant SWE-bench ablation (LEARNINGS §10-13) —
// not vendor benchmark claims. The Conductor routes by these facts.
//
// Pricing = OpenRouter $/M (in/out), verified 2026-06-22/23. `measured` = our gold-graded results;
// `role` = what the ablation says it's actually good/bad for here. Keep this honest: if we didn't
// measure it, mark measured:null and treat as a hypothesis.

export const REGISTRY = {
  'deepseek/deepseek-v4-flash': {
    inPerM: 0.09, outPerM: 0.18,
    roles: ['interactive-coder', 'test-critic'],
    measured: 'BEST cheap interactive coder: 36% conformant single-traj @ ~$0.005/inst (LEARNINGS §13); '
      + '75% repro-validity as Test-Critic; only 12-16% under MCTS+self-repro (architecture, not model).',
    pick: 'primary interactive coder + cheap repro author',
  },
  'anthropic/claude-opus-4.8': {
    inPerM: 5.0, outPerM: 25.0,
    roles: ['judge', 'sniper', 'reasoner'],
    measured: '33% as best-of-3 MCTS coder @ $3.49/inst (ADR-174); single repro-gated sniper added 0 gold '
      + '(LEARNINGS §12) — use for best-of-k coding or as a SELECTION judge, never a single gated shot.',
    pick: 'final selection / hardest-tail reasoning (expensive — reserve)',
  },
  'minimax/minimax-m2.7': {
    inPerM: 0.25, outPerM: 1.0,
    roles: ['alt-coder'],
    measured: 'patch-model swap moved nothing vs DeepSeek at 2.2x cost (LEARNINGS §11). Deprioritized.',
    pick: 'alternate coder — no measured edge; skip unless DeepSeek underperforms a future task',
  },
  'qwen/qwen3-coder-30b-a3b-instruct': {
    inPerM: 0.07, outPerM: 0.27,
    roles: [],
    measured: '0-4% in our scaffold (LEARNINGS §11) — does NOT transfer from EntroPO\'s harness. AVOID as coder.',
    pick: 'AVOID (measured catastrophic here)',
  },
  'deepseek/deepseek-v3.2': {
    inPerM: 0.23, outPerM: 0.34,
    roles: ['interactive-coder?'],
    measured: null,
    pick: 'untested interactive candidate (cheapest reasoning tier) — pilot before trusting',
  },
  'anthropic/claude-haiku-4.5': {
    inPerM: 1.0, outPerM: 5.0,
    roles: ['fast-tool', 'judge?'],
    measured: null,
    pick: 'untested mid-tier — candidate fast judge / structurer',
  },
  'nvidia/nemotron-3-super-120b-a12b:free': {
    inPerM: 0.0, outPerM: 0.0,
    roles: ['test-critic?'],
    measured: '38% repro-validity (below DeepSeek 75%); :free tier rate-limits under load. Deprioritized.',
    pick: 'free but weak + rate-limited; not for production scale',
  },
};

/** Pick the cheapest registry model whose roles include `role` and that isn't marked AVOID. */
export function pickForRole(role, { excludeAvoid = true } = {}) {
  const cands = Object.entries(REGISTRY)
    .filter(([, m]) => m.roles.includes(role) && !(excludeAvoid && /AVOID/.test(m.pick)))
    .sort((a, b) => (a[1].inPerM + a[1].outPerM) - (b[1].inPerM + b[1].outPerM));
  return cands.length ? cands[0][0] : null;
}

export function costPerM(slug) { const m = REGISTRY[slug]; return m ? { in: m.inPerM, out: m.outPerM } : null; }
