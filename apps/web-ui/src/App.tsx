import { useState } from 'react';
import { Boxes, Github, Sparkles } from 'lucide-react';
import { HarnessBuilder } from './components/HarnessBuilder';
import { ArtifactBuilder } from './components/ArtifactBuilder';
import { RepoImporter } from './components/RepoImporter';
import { VerifyPanel } from './components/VerifyPanel';
import { SegTabs } from './components/ui';
import type { HarnessConfig } from './generator';

type Mode = 'repo' | 'harness' | 'artifact' | 'verify';

export default function App() {
  const [mode, setMode] = useState<Mode>('harness');
  const [seed, setSeed] = useState<HarnessConfig | undefined>(undefined);
  // Bump to force-remount HarnessBuilder when a repo plan seeds a new config.
  const [seedKey, setSeedKey] = useState(0);

  function useRepoPlan(cfg: HarnessConfig) {
    setSeed(cfg);
    setSeedKey((k) => k + 1);
    setMode('harness');
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <a
            href="https://github.com/ruvnet/agent-harness-generator"
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-1.5 text-xs text-slate-300 transition hover:border-ink-600 hover:text-white"
          >
            <Github size={14} /> ruvnet/agent-harness-generator
          </a>
          <div className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex">
            <Sparkles size={14} className="text-brand-glow" /> 100% client-side · nothing leaves your browser
          </div>
        </div>

        <div className="flex flex-col items-start gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand/10 px-3 py-1 text-xs font-medium text-brand-glow">
              <Boxes size={13} /> Meta-harness · the agent harness supply chain
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Agent Harness <span className="text-brand-glow">Studio</span>
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
              Turn any GitHub repo — or a blank slate — into a governed, branded, multi-host AI agent harness. Recommend
              agents, skills, commands, MCP tools, and policy; emit a signed-ready, npm-publishable runtime. No backend,
              no install.
            </p>
          </div>
          <SegTabs
            value={mode}
            onChange={(m) => setMode(m as Mode)}
            options={[
              { id: 'repo', label: 'Repo → Harness' },
              { id: 'harness', label: 'Create harness' },
              { id: 'artifact', label: 'Skill / Agent / Command' },
              { id: 'verify', label: 'Verify' },
            ]}
          />
        </div>
      </header>

      <main>
        {mode === 'repo' && <RepoImporter onUse={useRepoPlan} />}
        {mode === 'harness' && <HarnessBuilder key={seedKey} seed={seed} />}
        {mode === 'artifact' && <ArtifactBuilder />}
        {mode === 'verify' && <VerifyPanel />}
      </main>

      <footer className="mt-12 border-t border-ink-700/60 pt-6 text-xs text-slate-500">
        <p>
          Built on <a className="text-slate-300 hover:text-white" href="https://www.npmjs.com/package/@ruflo/kernel">@ruflo/kernel</a> — a
          Rust → WASM + NAPI-RS kernel. Output is byte-compatible with the <code className="text-slate-300">create-agent-harness</code> CLI.
          MCP is one selectable, default-deny primitive. Drop generated <code className="text-slate-300">SKILL.md</code> folders straight
          into Claude desktop or claude.ai. <span className="text-slate-400">Embeddings recommend · rules generate · tests prove.</span>
        </p>
      </footer>
    </div>
  );
}
