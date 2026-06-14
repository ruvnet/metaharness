import { describe, expect, it } from 'vitest';
import { buildArtifact, buildSkillFile } from '../artifacts';
import { AGENTS, COMMANDS, SKILLS } from '../catalog';

describe('artifacts', () => {
  it('skill file is a SKILL.md in its own folder with valid frontmatter', () => {
    const s = SKILLS[0]!;
    const f = buildSkillFile(s);
    expect(f.path).toBe(`${s.id}/SKILL.md`);
    expect(f.content.startsWith('---\n')).toBe(true);
    expect(f.content).toContain(`name: ${s.id}`);
    expect(f.content).toContain('description:');
    // Body heading present.
    expect(f.content).toContain(`# ${s.id}`);
  });

  it('escapes colons in descriptions to keep YAML valid', () => {
    const f = buildArtifact('skill', {
      id: 'x',
      name: 'X',
      description: 'has: a colon',
      body: 'b',
    });
    expect(f.content).toContain('description: "has: a colon"');
  });

  it('agent file carries tags when present', () => {
    const a = AGENTS.find((x) => x.tags?.length)!;
    const f = buildArtifact('agent', a);
    expect(f.path).toBe(`${a.id}.md`);
    expect(f.content).toContain('tags: [');
  });

  it('command file has description frontmatter only', () => {
    const c = COMMANDS[0]!;
    const f = buildArtifact('command', c);
    expect(f.path).toBe(`${c.id}.md`);
    expect(f.content).toContain('description:');
    expect(f.content).not.toContain('name:');
  });
});
