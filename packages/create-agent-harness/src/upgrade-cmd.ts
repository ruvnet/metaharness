// SPDX-License-Identifier: MIT
//
// `harness upgrade [path] [--apply] [--conflict=inline|rej]` CLI subcommand.
//
// Re-renders the harness's template against the current generator
// version, computes the drift plan vs the manifest's recorded
// fingerprints, and either prints the plan (dry-run default) or
// applies it.
//
// Conflict handling:
//   --conflict=inline (default)  write Git-style conflict markers in-place
//   --conflict=rej               write the upstream version to `<file>.rej`

import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { planUpgrade, formatPlan, applyPlan, requiresConfigRejection } from './upgrade.js';
import { asFileMap } from './walker.js';
import { templateDir, renderScaffold, type Host } from './index.js';
import {
  validateFieldMemoryManifest,
} from './field-memory-scaffold.js';
import { createHash } from 'node:crypto';
import type { TemplateVars } from './renderer.js';

export type SubcommandResult = { code: number; lines: string[] };

interface ManifestShape {
  template: string;
  vars: TemplateVars;
  files: Record<string, string>;
  generator_version?: string;
  field_memory?: unknown;
  hosts?: Host[];
  features?: { darwin: boolean; sessions: boolean };
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

/**
 * `harness upgrade [path] [--apply] [--conflict=inline|rej]`
 */
export async function upgradeCmd(args: string[]): Promise<SubcommandResult> {
  const positional = args.filter(a => !a.startsWith('--'));
  const dir = resolve(positional[0] ?? process.cwd());
  const apply = args.includes('--apply');
  const conflictStyle = args.find(a => a.startsWith('--conflict='))?.slice('--conflict='.length) as 'inline' | 'rej' | undefined ?? 'inline';

  const lines: string[] = [`harness upgrade — ${dir} ${apply ? '(APPLY)' : '(DRY-RUN)'}`];

  if (!['inline', 'rej'].includes(conflictStyle)) {
    lines.push(`  --conflict=${conflictStyle} unsupported (use inline or rej)`);
    return { code: 2, lines };
  }

  const manifestPath = join(dir, '.harness', 'manifest.json');
  if (!existsSync(manifestPath)) {
    lines.push(`  no .harness/manifest.json at ${dir} — not a generated harness`);
    return { code: 1, lines };
  }

  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  } catch (e) {
    lines.push(`  manifest is not valid JSON: ${e instanceof Error ? e.message : e}`);
    return { code: 1, lines };
  }

  // Re-render the template that produced this harness, with the same vars,
  // to get the LATEST expected file map.
  const tdir = templateDir(manifest.template);
  if (!existsSync(tdir)) {
    lines.push(`  template "${manifest.template}" not found at ${tdir}`);
    lines.push(`  (the create-agent-harness package may have evolved the template id)`);
    return { code: 1, lines };
  }

  if (manifest.field_memory !== undefined) {
    const error = validateFieldMemoryManifest(manifest.field_memory);
    if (error) {
      lines.push(`  manifest field_memory block is invalid: ${error}; refusing to drop or reinterpret the overlay`);
      return { code: 1, lines };
    }
  }
  // Legacy manifests predate feature flags; recover opt-ins from the installed package.
  let legacyDarwin = false;
  if (!manifest.features) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8'));
      legacyDarwin = !!pkg.devDependencies?.['@metaharness/darwin'];
    } catch { /* no optional overlay can be inferred */ }
  }
  const { rendered } = await renderScaffold({
    name: String(manifest.vars.name), template: manifest.template,
    description: String(manifest.vars.description ?? 'My AI agent harness'),
    host: manifest.vars.host as Host, hosts: manifest.hosts,
    targetDir: dir, force: false, generatorVersion: manifest.generator_version ?? 'unknown',
    darwin: manifest.features?.darwin ?? legacyDarwin,
    sessions: manifest.features?.sessions ?? ('src/sessions/log.ts' in manifest.files),
    fieldMemory: manifest.field_memory !== undefined,
  });
  const upstreamFiles = asFileMap(rendered);
  const upstreamFingerprints: Record<string, string> = {};
  for (const [path, content] of Object.entries(upstreamFiles)) {
    upstreamFingerprints[path] = sha256(content);
  }

  const plan = await planUpgrade(dir, upstreamFingerprints);
  lines.push('');
  for (const planLine of formatPlan(plan).split('\n')) lines.push('  ' + planLine);

  const total = plan.added.length + plan.removed.length + plan.changed.length;
  if (total === 0) {
    lines.push('', '  No drift — harness is up-to-date with the template.');
    return { code: 0, lines };
  }
  const conflicts = plan.changed.filter(c => c.kind === 'conflict');
  const conflictDescription = conflictStyle === 'rej' ? '.rej files'
    : conflicts.some(c => requiresConfigRejection(c.path))
      ? 'inline markers (structured configuration uses a .rej file)' : 'inline markers';

  if (!apply) {
    lines.push('', `  DRY-RUN: re-run with --apply to apply this plan.`);
    if (conflicts.length > 0) {
      lines.push(`  ${conflicts.length} conflict(s) will use ${conflictDescription}.`);
    }
    return { code: 0, lines };
  }

  // APPLY
  const modified = await applyPlan(dir, plan, upstreamFiles, { conflictStyle });
  lines.push('', `  Modified ${modified.length} file(s).`);
  if (conflicts.length > 0) {
    lines.push(`  ${conflicts.length} conflict(s) written using ${conflictDescription} — review manually.`);
    return { code: 1, lines };  // non-zero so CI flags unresolved conflicts
  }
  lines.push('  Clean apply — no conflicts.');
  return { code: 0, lines };
}
