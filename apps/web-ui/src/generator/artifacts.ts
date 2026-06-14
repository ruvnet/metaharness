// SPDX-License-Identifier: MIT
//
// Builders for *individual* Claude-ready artifacts: a skill (SKILL.md with YAML
// frontmatter in its own folder), an agent card, and a slash-command markdown.
// These are exactly the shapes Claude desktop / claude.ai accept when you drop
// a folder into the skills directory, so the UI's "download single artifact"
// path produces drop-in files.

import type { CatalogItem, GenFile } from './types';

/** YAML-frontmatter SKILL.md — the Claude skill format. */
export function buildSkillFile(item: CatalogItem): GenFile {
  const frontmatter = ['---', `name: ${item.id}`, `description: ${yamlInline(item.description)}`, '---', ''].join('\n');
  const body = `# ${item.id}\n\n${item.body}\n`;
  return { path: `${item.id}/SKILL.md`, content: frontmatter + body };
}

/** Agent card — markdown with a small frontmatter block. */
export function buildAgentFile(item: CatalogItem): GenFile {
  const frontmatter = [
    '---',
    `name: ${item.id}`,
    `description: ${yamlInline(item.description)}`,
    ...(item.tags?.length ? [`tags: [${item.tags.join(', ')}]`] : []),
    '---',
    '',
  ].join('\n');
  const body = `# ${titleCase(item.name)} agent\n\n${item.body}\n`;
  return { path: `${item.id}.md`, content: frontmatter + body };
}

/** Slash-command markdown — Claude Code reads .claude/commands/<id>.md. */
export function buildCommandFile(item: CatalogItem): GenFile {
  const frontmatter = ['---', `description: ${yamlInline(item.description)}`, '---', ''].join('\n');
  const body = `${item.body}\n`;
  return { path: `${item.id}.md`, content: frontmatter + body };
}

export function buildArtifact(kind: 'agent' | 'skill' | 'command', item: CatalogItem): GenFile {
  switch (kind) {
    case 'skill':
      return buildSkillFile(item);
    case 'agent':
      return buildAgentFile(item);
    case 'command':
      return buildCommandFile(item);
  }
}

/** Escape a string for safe single-line YAML. */
function yamlInline(s: string): string {
  if (/[:#{}[\],&*!|>'"%@`]/.test(s) || s.includes('\n')) {
    return JSON.stringify(s);
  }
  return s;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
