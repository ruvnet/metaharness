// SPDX-License-Identifier: MIT
// ADR-171: Darwin mode — a first-class, read-only showcase of the evolutionary
// harness: the thesis, the BATCH-VERIFIED SWE-bench Lite ladder, the execution
// boundary, and the mutation surfaces. Numbers are measured (RESULTS.md), not
// projected; CIs are Wilson 95%.
import { Dna, ShieldCheck, GitBranch, Cpu } from 'lucide-react';
import { Section } from './ui';
import { MUTATION_SURFACES, MODEL_CATALOG } from '../generator';

// Batch-verified ladder (SWE-bench Lite, n=300). Single source for the chart.
const LADDER: { label: string; pct: number; ci?: string; note: string }[] = [
  { label: 'Single-shot baseline', pct: 7.7, note: 'frozen model, no loop' },
  { label: '+ repair loop', pct: 15.3, note: 'pytest feedback (ADR-144)' },
  { label: 'v4-pro single-shot+repair', pct: 29.3, ci: '24.5–34.7', note: 'stronger cheap base (ADR-151)' },
  { label: '2-tier escalation', pct: 40.3, note: 'cheap + Scholar' },
  { label: '3-tier (headline)', pct: 58.3, ci: '52.7–63.8', note: 'cheap + Scholar + Sage (ADR-154)' },
  { label: 'Agentic full-300 (max-15)', pct: 34.7, ci: '29.5–40.2', note: 'ReAct loop, ~$0.03/inst (E1)' },
  { label: 'Agentic + max-30 + anti-thrash', pct: 46.3, ci: '40.8–52.0', note: '+35 tail recovered (E4/ADR-169)' },
  { label: '+ Scholar on tail', pct: 50.7, ci: '45.0–56.3', note: '2-tier on agentic base (E5)' },
];

export function DarwinPanel() {
  const max = 65;
  return (
    <div className="space-y-6">
      <Section
        title="Darwin · evolutionary harness"
        desc="Freeze the model, evolve the harness. The loop mutates policy surfaces, gates every variant before it runs, executes the test suite in a scrubbed sandbox, scores the trace, and keeps only what measurably beats its parent. Configure & ship it from the Create-harness tab."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: Dna, t: 'Frozen model, evolving harness', d: 'gains come from the scaffold (planner, retry, tool policy…), not finetuning' },
            { icon: ShieldCheck, t: 'Gate-first execution', d: 'a disqualified variant never runs (exit 99); no-shell execFile + scrubbed env' },
            { icon: GitBranch, t: 'Score → select → repeat', d: 'only batch-verified resolve-rate is authoritative; in-loop drifts 1.5–5×' },
          ].map(({ icon: Icon, t, d }) => (
            <div key={t} className="rounded-lg border border-slate-800/60 p-3">
              <div className="flex items-center gap-2 text-slate-200"><Icon size={14} className="text-brand-glow" /> <span className="text-sm font-medium">{t}</span></div>
              <p className="mt-1 text-xs text-slate-400">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Measured ladder — SWE-bench Lite (n=300, Wilson 95% CI)" desc="Real batch-eval numbers only. The agentic arc (E1→E5) is the current frontier; the 3-tier 58.3% is the headline.">
        <div className="space-y-1.5">
          {LADDER.map((r) => (
            <div key={r.label} className="flex items-center gap-3">
              <div className="w-56 shrink-0 text-xs text-slate-300">{r.label}</div>
              <div className="relative h-5 flex-1 overflow-hidden rounded bg-slate-900/60">
                <div className="absolute inset-y-0 left-0 rounded bg-brand-glow/30" style={{ width: `${(r.pct / max) * 100}%` }} />
                <div className="absolute inset-y-0 left-2 flex items-center text-[11px] font-mono text-slate-200">
                  {r.pct.toFixed(1)}%{r.ci ? ` [${r.ci}]` : ''}
                </div>
              </div>
              <div className="hidden w-52 shrink-0 text-[11px] text-slate-500 sm:block">{r.note}</div>
            </div>
          ))}
        </div>
      </Section>

      <div className="grid gap-6 sm:grid-cols-2">
        <Section title="Mutation surfaces (ADR-071)" desc="The only files a variant may evolve. Everything else is frozen.">
          <div className="flex flex-wrap gap-2">
            {MUTATION_SURFACES.map((s) => (
              <span key={s} className="rounded-md border border-slate-800/60 px-2 py-1 text-xs text-slate-300">{s}</span>
            ))}
          </div>
        </Section>
        <Section title="Model tiers" desc="The escalation ladder is a blend of cheap → frontier. Pick each tier in Create-harness → Models.">
          <div className="space-y-1.5">
            {[['Barbarian', 'deepseek/deepseek-v4-pro'], ['Scholar', 'anthropic/claude-sonnet-4'], ['Sage', 'anthropic/claude-opus-4']].map(([tier, id]) => {
              const m = MODEL_CATALOG.find((x) => x.id === id);
              return (
                <div key={tier} className="flex items-center gap-2 text-xs">
                  <Cpu size={12} className="text-brand-glow" />
                  <span className="w-20 text-slate-300">{tier}</span>
                  <span className="text-slate-400">{m?.label}</span>
                  <span className="text-slate-600">— {m?.note}</span>
                </div>
              );
            })}
          </div>
        </Section>
      </div>
    </div>
  );
}
