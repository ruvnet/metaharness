import { useState } from 'react';
import { Boxes, Github, HelpCircle, Sparkles, Gauge, Route, ShieldCheck } from 'lucide-react';
import { HarnessBuilder } from './components/HarnessBuilder';
import { ArtifactBuilder } from './components/ArtifactBuilder';
import { RepoImporter } from './components/RepoImporter';
import { VerifyPanel } from './components/VerifyPanel';
import { DarwinPanel } from './components/DarwinPanel';
import { SegTabs } from './components/ui';
import { OnboardingModal, clearOnboardingDismissal } from './components/OnboardingModal';
import type { HarnessConfig } from './generator';

type Mode = 'repo' | 'harness' | 'artifact' | 'verify' | 'darwin';

export default function App() {
  const [mode, setMode] = useState<Mode>('harness');
  const [seed, setSeed] = useState<HarnessConfig | undefined>(undefined);
  // Bump to force-remount HarnessBuilder when a repo plan seeds a new config.
  const [seedKey, setSeedKey] = useState(0);
  // iter 106 — onboarding modal state (undefined → modal decides from localStorage)
  const [forceOnboarding, setForceOnboarding] = useState<boolean | undefined>(undefined);

  function useRepoPlan(cfg: HarnessConfig) {
    setSeed(cfg);
    setSeedKey((k) => k + 1);
    setMode('harness');
  }

  function reopenOnboarding() {
    // Clear the localStorage flag so future visits see the modal again,
    // and force-open it for the current session.
    clearOnboardingDismissal();
    setForceOnboarding(true);
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <a
            href="https://github.com/ruvnet/metaharness"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-300 transition hover:border-ink-600 hover:text-white"
          >
            <Github size={14} /> ruvnet/metaharness
          </a>
          <div className="flex items-center gap-2">
            <a
              href="cost-pareto.html"
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-700/50 bg-emerald-900/20 px-3 py-1.5 text-xs text-emerald-300 transition hover:border-emerald-600 hover:text-emerald-200"
              aria-label="SWE-bench Lite cost-Pareto leaderboard"
            >
              <Gauge size={14} /> <span className="hidden sm:inline">Cost-Pareto Leaderboard</span>
            </a>
            <button
              onClick={reopenOnboarding}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-300 transition hover:border-ink-600 hover:text-white"
              aria-label="Reopen onboarding tour"
            >
              <HelpCircle size={14} /> <span className="hidden sm:inline">Tour</span>
            </button>
            <div className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex">
              <Sparkles size={14} className="text-brand-glow" /> 100% client-side
            </div>
          </div>
        </div>

        <div className="flex flex-col items-start gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand/10 px-3 py-1 text-xs font-medium text-brand-glow">
              <Boxes size={13} /> Meta-harness · the agent harness supply chain
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              MetaHarness <span className="text-brand-glow">Studio</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
              Turn any GitHub repo — or a blank slate — into a governed, branded, multi-host AI agent harness. Recommend
              agents, skills, commands, MCP tools, and policy; emit a signed-ready, npm-publishable runtime. No backend,
              no install.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[
                { icon: Gauge, title: 'Score any repo', desc: 'harness fit · $/run · scaffold-ready' },
                { icon: Route, title: 'Cost-optimal routing', desc: 'cheap model, frontier quality' },
                { icon: ShieldCheck, title: 'Default-deny tools', desc: 'auditable · witness-signed' },
              ].map(({ icon: Icon, title, desc }) => (
                <span
                  key={title}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800/50 px-2.5 py-1 text-xs text-slate-300"
                  title={desc}
                >
                  <Icon size={13} className="text-brand-glow" />
                  <span className="font-medium text-slate-200">{title}</span>
                  <span className="hidden text-slate-500 sm:inline">— {desc}</span>
                </span>
              ))}
            </div>
          </div>
          <SegTabs
            value={mode}
            onChange={(m) => setMode(m as Mode)}
            options={[
              { id: 'repo', label: 'Repo → Harness' },
              { id: 'harness', label: 'Create harness' },
              { id: 'artifact', label: 'Skill / Agent / Command' },
              { id: 'verify', label: 'Verify' },
              { id: 'darwin', label: 'Darwin' },
            ]}
          />
        </div>
      </header>

      <main>
        {mode === 'repo' && <RepoImporter onUse={useRepoPlan} />}
        {mode === 'harness' && <HarnessBuilder key={seedKey} seed={seed} />}
        {mode === 'artifact' && <ArtifactBuilder />}
        {mode === 'verify' && <VerifyPanel />}
        {mode === 'darwin' && <DarwinPanel />}
      </main>

      <OnboardingModal
        forceOpen={forceOnboarding}
        onClose={() => setForceOnboarding(undefined)}
        onStart={(point) => {
          setMode(point as Mode);
          setForceOnboarding(undefined);
        }}
      />


      <footer className="mt-12 border-t border-ink-700/60 pt-6 text-xs text-slate-500">
        <p>
          Built on <a className="text-slate-300 hover:text-white" href="https://www.npmjs.com/package/@metaharness/kernel">@metaharness/kernel</a> — a
          Rust → WASM + NAPI-RS kernel. Output is byte-compatible with the <code className="text-slate-300">create-agent-harness</code> CLI.
          MCP is one selectable, default-deny primitive. Drop generated <code className="text-slate-300">SKILL.md</code> folders straight
          into Claude desktop or claude.ai. <span className="text-slate-400">Embeddings recommend · rules generate · tests prove.</span>
        </p>
      </footer>
    </div>
  );
}
