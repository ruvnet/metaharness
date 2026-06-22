import { useMemo, useState } from 'react';
import { Download, Loader2, Package } from 'lucide-react';
import { HostGuide } from './HostGuide';
import {
  HOSTS,
  buildScaffold,
  downloadBlob,
  findTemplate,
  templatesByCategory,
  totalBytes,
  validateHarnessName,
  zipFilesUnder,
} from '../generator';
import type { GenFile, HarnessConfig, HostId, TemplateId } from '../generator';
import { DEFAULT_PRIMITIVES, SAFE_MCP_POLICY, DEFAULT_MODELS, DEFAULT_DARWIN, MODEL_CATALOG, MUTATION_SURFACES } from '../generator';
import type { McpMode, McpPolicy, ModelId, MutationSurface } from '../generator';
import { Chip, Field, Section, SegTabs } from './ui';
import { FileTree } from './FileTree';
import { CatalogPicker } from './CatalogPicker';

const DEFAULT_TEMPLATE = 'vertical:coding';

function defaultsFor(template: TemplateId): Pick<HarnessConfig, 'agents' | 'skills' | 'commands'> {
  const t = findTemplate(template)!;
  return { agents: t.defaultAgents, skills: t.defaultSkills, commands: t.defaultCommands };
}

const INITIAL: HarnessConfig = {
  name: 'my-harness',
  description: findTemplate(DEFAULT_TEMPLATE)?.harnessDesc ?? 'My AI agent harness',
  hosts: ['claude-code'],
  template: DEFAULT_TEMPLATE,
  memory: 'agentdb',
  routing: '3-tier',
  marketplace: 'powered-by',
  models: DEFAULT_MODELS,
  darwin: DEFAULT_DARWIN,
  primitives: DEFAULT_PRIMITIVES,
  mcpPolicy: SAFE_MCP_POLICY,
  ...defaultsFor(DEFAULT_TEMPLATE),
};

function toggle<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export function HarnessBuilder({ seed }: { seed?: HarnessConfig }) {
  const [cfg, setCfg] = useState<HarnessConfig>(seed ?? INITIAL);
  const [selectedPath, setSelectedPath] = useState('README.md');
  const [busy, setBusy] = useState(false);

  const nameCheck = validateHarnessName(cfg.name);
  const files = useMemo<GenFile[]>(() => (nameCheck.valid ? buildScaffold(cfg) : []), [cfg, nameCheck.valid]);
  const selected = files.find((f) => f.path === selectedPath) ?? files[0];

  function patch(p: Partial<HarnessConfig>) {
    setCfg((c) => ({ ...c, ...p }));
  }

  function pickTemplate(id: TemplateId) {
    const t = findTemplate(id);
    patch({ template: id, description: t?.harnessDesc ?? cfg.description, ...defaultsFor(id) });
  }

  async function download() {
    if (!nameCheck.valid) return;
    setBusy(true);
    try {
      const blob = await zipFilesUnder(cfg.name, files);
      downloadBlob(blob, `${cfg.name}.zip`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* ---- Left: configuration ---- */}
      <div className="space-y-5">
        <Section title="Identity" desc="Your harness ships to npm under this name.">
          <div className="space-y-4">
            <Field label="Harness name" hint={nameCheck.valid ? 'kebab-case, npm-publishable' : nameCheck.reason}>
              <input
                className={`input ${nameCheck.valid ? '' : 'border-red-500/70 focus:border-red-500 focus:ring-red-500/30'}`}
                value={cfg.name}
                spellCheck={false}
                aria-invalid={!nameCheck.valid}
                aria-label="Harness name"
                onChange={(e) => patch({ name: e.target.value.trim() })}
              />
            </Field>
            <Field label="Description">
              <input
                className="input"
                value={cfg.description}
                aria-label="Description"
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>
        </Section>

        <Section title="Hosts" desc="Where the harness runs. Pick one or more.">
          <div className="flex flex-wrap gap-2">
            {HOSTS.map((h) => (
              <Chip
                key={h.id}
                title={h.shape}
                active={cfg.hosts.includes(h.id)}
                onClick={() => patch({ hosts: toggle<HostId>(cfg.hosts, h.id) })}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: h.color }} />
                {h.name}
              </Chip>
            ))}
          </div>
        </Section>

        <Section
          title="Quick-start template"
          desc="Pick a vertical to jump-start — it pre-fills the brand description, agents, skills, and commands."
        >
          <div className="max-h-[460px] space-y-4 overflow-auto pr-1 scroll-thin">
            {templatesByCategory().map((group) => (
              <div key={group.category}>
                <div className="field-label">{group.category}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      data-testid={`tpl-${t.id}`}
                      onClick={() => pickTemplate(t.id)}
                      className={`rounded-lg border p-3 text-left transition ${
                        cfg.template === t.id
                          ? 'border-brand bg-brand/10 shadow-[0_0_0_1px_rgba(124,92,255,0.4)]'
                          : 'border-ink-700 bg-ink-800/50 hover:border-ink-600'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-white">{t.name}</span>
                        {!t.generate && (
                          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                            curated
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-slate-400">{t.quickStart}</div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Compose" desc="Search and toggle the agents, skills, and slash-commands to include — grouped by domain.">
          <div className="space-y-4">
            <CatalogPicker
              label="Agents" kind="agent" selected={cfg.agents}
              onToggle={(id) => patch({ agents: toggle(cfg.agents, id) })}
              onClear={() => patch({ agents: [] })}
            />
            <CatalogPicker
              label="Skills" kind="skill" selected={cfg.skills}
              onToggle={(id) => patch({ skills: toggle(cfg.skills, id) })}
              onClear={() => patch({ skills: [] })}
            />
            <CatalogPicker
              label="Commands" kind="command" selected={cfg.commands}
              onToggle={(id) => patch({ commands: toggle(cfg.commands, id) })}
              onClear={() => patch({ commands: [] })}
            />
          </div>
        </Section>

        <Section title="Kernel options">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Memory">
              <select className="input" value={cfg.memory} onChange={(e) => patch({ memory: e.target.value as HarnessConfig['memory'] })}>
                <option value="agentdb">AgentDB</option>
                <option value="sqlite">SQLite</option>
                <option value="in-memory">In-memory</option>
              </select>
            </Field>
            <Field label="Routing">
              <select className="input" value={cfg.routing} onChange={(e) => patch({ routing: e.target.value as HarnessConfig['routing'] })}>
                <option value="3-tier">3-tier</option>
                <option value="single-tier">Single-tier</option>
              </select>
            </Field>
            <Field label="Marketplace">
              <select className="input" value={cfg.marketplace} onChange={(e) => patch({ marketplace: e.target.value as HarnessConfig['marketplace'] })}>
                <option value="powered-by">Powered-by</option>
                <option value="independent">Independent</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section
          title="Models"
          desc={cfg.routing === '3-tier'
            ? 'Pick the model for each escalation tier — cheap base → Scholar → Sage (ADR-154).'
            : 'Single-tier: one model handles every task. Switch ROUTING to 3-tier to escalate.'}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              cfg.routing === '3-tier'
                ? ([['barbarian', 'Barbarian · base'], ['scholar', 'Scholar · mid'], ['sage', 'Sage · frontier']] as const)
                : ([['barbarian', 'Model']] as const)
            ).map(([tier, label]) => (
              <Field key={tier} label={label}>
                <select
                  className="input"
                  value={cfg.models[tier]}
                  onChange={(e) => patch({ models: { ...cfg.models, [tier]: e.target.value as ModelId } })}
                >
                  {MODEL_CATALOG.map((m) => (
                    <option key={m.id} value={m.id}>{m.label} — {m.note}</option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        </Section>

        <Section
          title="Darwin · self-evolution"
          desc="Frozen model, evolving harness (ADR-070/170). The loop mutates policy surfaces, gates each variant, and keeps what scores higher. Off by default."
        >
          <div className="space-y-4">
            <Chip
              active={cfg.darwin.enabled}
              onClick={() => patch({ darwin: { ...cfg.darwin, enabled: !cfg.darwin.enabled } })}
            >
              {cfg.darwin.enabled ? 'Evolution ON' : 'Evolution OFF'}
            </Chip>
            {cfg.darwin.enabled && (
              <>
                <Field label="Mutation surfaces" hint="The only files a variant may change (ADR-071).">
                  <div className="flex flex-wrap gap-2">
                    {MUTATION_SURFACES.map((s) => (
                      <Chip
                        key={s}
                        active={cfg.darwin.surfaces.includes(s)}
                        onClick={() => patch({ darwin: { ...cfg.darwin, surfaces: toggle(cfg.darwin.surfaces, s as MutationSurface) } })}
                      >
                        {s}
                      </Chip>
                    ))}
                  </div>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Generations">
                    <select
                      className="input"
                      value={cfg.darwin.generations}
                      onChange={(e) => patch({ darwin: { ...cfg.darwin, generations: Number(e.target.value) } })}
                    >
                      {[5, 10, 25, 50].map((g) => <option key={g} value={g}>{g} generations</option>)}
                    </select>
                  </Field>
                  <Field label="Sandbox tier" hint="mock = $0 deterministic; real = execFile; agent = ReAct loop.">
                    <select
                      className="input"
                      value={cfg.darwin.sandbox}
                      onChange={(e) => patch({ darwin: { ...cfg.darwin, sandbox: e.target.value as HarnessConfig['darwin']['sandbox'] } })}
                    >
                      <option value="mock">mock ($0)</option>
                      <option value="real">real (execFile)</option>
                      <option value="agent">agent (ReAct)</option>
                    </select>
                  </Field>
                </div>
              </>
            )}
          </div>
        </Section>

        <Section
          title="Primitives"
          desc="MCP is one selectable primitive — not the whole product. Toggle what the harness ships."
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ['cli', 'CLI'],
                  ['memory', 'Memory namespace'],
                  ['learning', 'Learning loop'],
                  ['witness', 'Witness signing'],
                  ['releaseGates', 'Release gates'],
                ] as const
              ).map(([k, label]) => (
                <Chip
                  key={k}
                  active={cfg.primitives[k]}
                  onClick={() => patch({ primitives: { ...cfg.primitives, [k]: !cfg.primitives[k] } })}
                >
                  {label}
                </Chip>
              ))}
            </div>

            <div className="rounded-lg border border-ink-700 bg-ink-900/50 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-white">MCP server</div>
                  <div className="text-xs text-slate-400">stdio (local) for desktop · Streamable HTTP (remote) for hosted/team</div>
                </div>
                <SegTabs<McpMode>
                  value={cfg.primitives.mcp}
                  onChange={(m) => patch({ primitives: { ...cfg.primitives, mcp: m } })}
                  options={[
                    { id: 'off', label: 'Off' },
                    { id: 'local', label: 'Local' },
                    { id: 'remote', label: 'Remote' },
                  ]}
                />
              </div>

              {cfg.primitives.mcp !== 'off' && (
                <div className="mt-3 border-t border-ink-700 pt-3">
                  <div className="field-label flex items-center gap-2">
                    Security policy
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300">
                      default-deny
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ['allowNetwork', 'Allow network'],
                        ['allowShell', 'Allow shell'],
                        ['allowFileWrite', 'Allow file write'],
                        ['requireApprovalForDangerous', 'Approve dangerous'],
                        ['auditLog', 'Audit log'],
                      ] as const
                    ).map(([k, label]) => (
                      <Chip
                        key={k}
                        active={cfg.mcpPolicy[k]}
                        title={k === 'requireApprovalForDangerous' || k === 'auditLog' ? 'safe default ON' : 'off by default — opt in'}
                        onClick={() => patch({ mcpPolicy: { ...cfg.mcpPolicy, [k]: !cfg.mcpPolicy[k] } as McpPolicy })}
                      >
                        {label}
                      </Chip>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    Emits <code className="text-slate-300">src/mcp/*</code> (server, tools, resources, prompts, policy, audit
                    {cfg.primitives.mcp === 'remote' ? ', auth' : ''}) + a scannable{' '}
                    <code className="text-slate-300">.harness/mcp-policy.json</code>.
                  </p>
                </div>
              )}
            </div>
          </div>
        </Section>
      </div>

      {/* ---- Right: live preview ---- */}
      <div className="space-y-5 lg:sticky lg:top-5 lg:self-start">
        <Section
          title="Generated harness"
          desc={`${files.length} files · ${(totalBytes(files) / 1024).toFixed(1)} KB uncompressed`}
          right={
            <button data-testid="download-harness" className="btn btn-primary" onClick={download} disabled={!nameCheck.valid || busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              Download .zip
            </button>
          }
        >
          {nameCheck.valid ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
              <div className="card overflow-hidden bg-ink-900/60">
                <FileTree files={files} selected={selected?.path ?? ''} onSelect={(f) => setSelectedPath(f.path)} />
              </div>
              <div className="card overflow-hidden bg-ink-950/80">
                <div className="border-b border-ink-700 px-3 py-2 font-mono text-xs text-slate-400">{selected?.path}</div>
                <pre className="scroll-thin max-h-[420px] overflow-auto p-3 text-[12px] leading-relaxed text-slate-200">
                  <code>{selected?.content}</code>
                </pre>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              <Package size={16} /> Fix the harness name to preview the scaffold.
            </div>
          )}
        </Section>

        {nameCheck.valid && <HostGuide hosts={cfg.hosts} />}
      </div>
    </div>
  );
}

