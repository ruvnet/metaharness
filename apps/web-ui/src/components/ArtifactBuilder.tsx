import { useMemo, useState } from 'react';
import { Download, FileDown } from 'lucide-react';
import { AGENTS, COMMANDS, SKILLS, buildArtifact, downloadBlob, toKebabCase, zipFiles } from '../generator';
import type { CatalogItem } from '../generator';
import { Chip, Field, Section, SegTabs } from './ui';

type Kind = 'skill' | 'agent' | 'command';

const CATALOG: Record<Kind, CatalogItem[]> = { skill: SKILLS, agent: AGENTS, command: COMMANDS };

const BLURB: Record<Kind, string> = {
  skill: 'A Claude skill — a SKILL.md folder with YAML frontmatter. Drop it into your Claude skills directory.',
  agent: 'An agent card — frontmatter + system prompt, ready to register in a harness or paste into a sub-agent.',
  command: 'A slash-command body — Claude Code reads these from .claude/commands/<id>.md.',
};

export function ArtifactBuilder() {
  const [kind, setKind] = useState<Kind>('skill');
  const [pickedId, setPickedId] = useState<string>(SKILLS[0]!.id);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState({ id: 'my-skill', name: 'My Skill', description: 'What it does', body: 'Steps the model should follow.' });

  const item: CatalogItem = useMemo(() => {
    if (custom) {
      const id = toKebabCase(draft.id) || 'untitled';
      return { id, name: draft.name || id, description: draft.description, body: draft.body };
    }
    return CATALOG[kind].find((i) => i.id === pickedId) ?? CATALOG[kind][0]!;
  }, [custom, draft, kind, pickedId]);

  const file = useMemo(() => buildArtifact(kind, item), [kind, item]);

  function onKind(k: Kind) {
    setKind(k);
    setPickedId(CATALOG[k][0]!.id);
  }

  async function downloadZip() {
    const blob = await zipFiles([file]);
    downloadBlob(blob, `${item.id}-${kind}.zip`);
  }

  function downloadMd() {
    const blob = new Blob([file.content], { type: 'text/markdown' });
    downloadBlob(blob, file.path.replace('/', '-'));
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Section title="Artifact type" desc={BLURB[kind]}>
          <SegTabs
            value={kind}
            onChange={(k) => onKind(k as Kind)}
            options={[
              { id: 'skill', label: 'Skill' },
              { id: 'agent', label: 'Agent' },
              { id: 'command', label: 'Command' },
            ]}
          />
        </Section>

        <Section
          title="Source"
          desc="Start from a curated item, or author your own."
          right={
            <SegTabs
              value={custom ? 'custom' : 'catalog'}
              onChange={(v) => setCustom(v === 'custom')}
              options={[
                { id: 'catalog', label: 'Catalog' },
                { id: 'custom', label: 'Author' },
              ]}
            />
          }
        >
          {custom ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="id" hint="kebab-case file/folder name">
                  <input className="input font-mono" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} aria-label="id" />
                </Field>
                <Field label="name">
                  <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="name" />
                </Field>
              </div>
              <Field label="description">
                <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="description" />
              </Field>
              <Field label="body" hint="Markdown — the instructions the model follows.">
                <textarea
                  className="input min-h-[160px] font-mono"
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  aria-label="body"
                />
              </Field>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {CATALOG[kind].map((it) => (
                <Chip key={it.id} title={it.description} active={pickedId === it.id} onClick={() => setPickedId(it.id)}>
                  {it.name}
                </Chip>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="space-y-5 lg:sticky lg:top-5 lg:self-start">
        <Section
          title="Preview"
          desc={file.path}
          right={
            <div className="flex gap-2">
              <button data-testid="download-md" className="btn btn-ghost" onClick={downloadMd}>
                <FileDown size={16} /> .md
              </button>
              <button data-testid="download-artifact" className="btn btn-primary" onClick={downloadZip}>
                <Download size={16} /> .zip
              </button>
            </div>
          }
        >
          <div className="card overflow-hidden bg-ink-950/80">
            <div className="border-b border-ink-700 px-3 py-2 font-mono text-xs text-slate-400">{file.path}</div>
            <pre className="scroll-thin max-h-[520px] overflow-auto p-3 text-[12px] leading-relaxed text-slate-200">
              <code>{file.content}</code>
            </pre>
          </div>
        </Section>
      </div>
    </div>
  );
}
