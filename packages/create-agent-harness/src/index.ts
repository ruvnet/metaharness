// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { walkTemplate, asFileMap } from './walker.js';
import { writeAtomic } from './writer.js';
import { emptyManifest, fingerprintFiles, sha256 } from './manifest.js';
import { validateHarnessName } from './renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Templates live at packages/create-agent-harness/templates/, one level above dist/.
const TEMPLATES_ROOT = resolve(__dirname, '..', 'templates');

/**
 * Resolve `@ruflo/kernel`'s version at scaffold time so we can stamp it into
 * `manifest.meta.kernel_version` (ADR-027 diagnostic). Falls through three
 * lookup paths because the create-agent-harness package can run:
 *   - from a workspace checkout (`packages/kernel-js/package.json`)
 *   - from an installed npm tree (resolve `@ruflo/kernel/package.json`)
 *   - from the prebuilt dist with neither sibling (fall back to 'unknown')
 *
 * We never throw — a missing kernel version downgrades the meta block to
 * `kernel_version: undefined`, which `harness doctor` already handles as
 * a WARN line. The CLI must keep generating harnesses even if the local
 * kernel install is broken.
 */
function resolveKernelVersion(): string | undefined {
  const candidates = [
    // Workspace layout: packages/create-agent-harness/dist/ → ../../kernel-js/package.json
    resolve(__dirname, '..', '..', 'kernel-js', 'package.json'),
    // Installed layout: sibling node_modules/@ruflo/kernel/package.json
    resolve(__dirname, '..', '..', '@ruflo', 'kernel', 'package.json'),
    // Fallback: top-level node_modules
    resolve(__dirname, '..', '..', '..', '@ruflo', 'kernel', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { version?: string };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      }
    } catch {
      // Try next candidate
    }
  }
  return undefined;
}

const KERNEL_VERSION = resolveKernelVersion();

export const HOSTS = ['claude-code', 'codex', 'pi-dev', 'hermes', 'openclaw', 'rvm'] as const;
export type Host = (typeof HOSTS)[number];

export const TEMPLATES = [
  'minimal',
  'vertical:devops',
  'vertical:support',
  'vertical:trading',
  'vertical:legal',
  'vertical:research',
  'vertical:coding',
  'vertical:business',
  'vertical:crm',
  'vertical:marketing',
  'vertical:advertising',
  'vertical:ai',
  'vertical:agentics',
  'vertical:ruview',
  'vertical:health',
  'vertical:education',  // iter 80 (milestone)
  'vertical:sales',      // iter 87
  'vertical:exotic',
] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export interface CatalogEntry {
  id: string;
  category: string;
  name: string;
  domain: string;
  description: string;
  quickStart: string;
  tags: string[];
  generate: boolean;
  agentCount: number;
  skillCount: number;
  commandCount: number;
}

/** Read the canonical template catalog shipped at templates/catalog.json. */
export function loadCatalog(): CatalogEntry[] {
  const p = join(TEMPLATES_ROOT, 'catalog.json');
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as { templates?: CatalogEntry[] };
    return parsed.templates ?? [];
  } catch {
    return [];
  }
}

/** Render the catalog as a human-readable table for `--list`. */
export function formatCatalog(entries: CatalogEntry[]): string[] {
  const lines: string[] = ['Available templates:', ''];
  let category = '';
  for (const e of entries) {
    if (e.category !== category) {
      category = e.category;
      lines.push(`  ${category}`);
    }
    const counts = `${e.agentCount}a/${e.skillCount}s/${e.commandCount}c`;
    lines.push(`    ${e.id.padEnd(22)} ${counts.padEnd(10)} ${e.quickStart}`);
  }
  lines.push('', `Scaffold with: create-agent-harness <name> --template <id>`);
  return lines;
}

export interface CliArgs {
  name?: string;
  template?: string;
  templatePackage?: string;
  hosts?: string[];
  yes?: boolean;
  force?: boolean;
  description?: string;
  fromExisting?: string;
  list?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a === '--template' || a === '-t') {
      out.template = argv[++i];
    } else if (a === '--template-package') {
      out.templatePackage = argv[++i];
    } else if (a === '--host' || a === '-h') {
      const v = argv[++i];
      if (v) (out.hosts ??= []).push(v);
    } else if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (a === '--force' || a === '-f') {
      out.force = true;
    } else if (a === '--description' || a === '-d') {
      out.description = argv[++i];
    } else if (a === '--from-existing') {
      out.fromExisting = argv[++i] ?? process.cwd();
    } else if (a === '--list' || a === '--templates') {
      out.list = true;
    } else if (!a.startsWith('-') && !out.name) {
      out.name = a;
    }
  }
  return out;
}

/**
 * Resolve a template id to its on-disk directory. The "minimal" template
 * lives at templates/minimal; vertical templates use ":" as the separator
 * in their id and "_" as the on-disk separator (e.g. vertical:devops ->
 * templates/vertical_devops).
 */
export function templateDir(id: string): string {
  return join(TEMPLATES_ROOT, id.replace(':', '_'));
}

export interface ScaffoldOptions {
  name: string;
  template: string;
  host: Host;
  description?: string;
  targetDir: string;
  force?: boolean;
  generatorVersion: string;
}

export interface ScaffoldResult {
  paths: string[];
  manifestPath: string;
  unresolved: string[];
}

/**
 * Run the full scaffold pipeline:
 *   1. Validate the name
 *   2. Walk the template dir + render
 *   3. Compute fingerprints
 *   4. Build .harness/manifest.json
 *   5. Atomically write everything to targetDir
 *
 * Returns the list of paths written + the manifest path + any unresolved
 * template variables (should be empty for a clean run).
 */
export async function scaffold(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const nameCheck = validateHarnessName(opts.name);
  if (!nameCheck.valid) {
    throw new Error(`invalid harness name: ${nameCheck.reason}`);
  }
  const dir = templateDir(opts.template);
  if (!existsSync(dir)) {
    throw new Error(`unknown template: ${opts.template} (expected at ${dir})`);
  }

  const vars = {
    name: opts.name,
    description: opts.description ?? 'My AI agent harness',
    host: opts.host,
  };
  const rendered = await walkTemplate(dir, vars, { strict: false });
  const fileMap = asFileMap(rendered);

  // iter 58: stamp kernel_version at scaffold time (ADR-027 diagnostic).
  // surface defaults to 'cli' inside emptyManifest; we override only
  // kernel_version here so the web-UI port can still set surface='web-ui'.
  const manifest = emptyManifest(opts.template, opts.generatorVersion, {
    meta: KERNEL_VERSION ? { kernel_version: KERNEL_VERSION } : {},
  });
  manifest.vars = vars;
  manifest.hosts = [opts.host];
  manifest.files = fingerprintFiles(fileMap);
  // Self-hash the manifest itself so `harness upgrade` can detect a hand-
  // edited manifest.
  const manifestJson = JSON.stringify(manifest, null, 2);

  rendered.push({
    path: '.harness/manifest.json',
    content: manifestJson,
    rendered: false,
    unresolved: [],
  });
  // Also record the manifest's own hash inside the manifest file's directory
  // sibling (`.harness/manifest.sha256`) so a corrupt download is obvious.
  rendered.push({
    path: '.harness/manifest.sha256',
    content: sha256(manifestJson) + '\n',
    rendered: false,
    unresolved: [],
  });

  const paths = await writeAtomic(opts.targetDir, rendered, { force: opts.force });
  return {
    paths,
    manifestPath: join(opts.targetDir, '.harness', 'manifest.json'),
    unresolved: rendered.flatMap(f => f.unresolved),
  };
}

/** Try to detect an existing ruflo project at the given path. */
export function detectRufloProject(dir: string): {
  found: boolean;
  signals: string[];
} {
  const signals: string[] = [];
  if (existsSync(join(dir, 'CLAUDE.md'))) signals.push('CLAUDE.md');
  if (existsSync(join(dir, '.claude'))) signals.push('.claude/');
  if (existsSync(join(dir, '.claude-flow'))) signals.push('.claude-flow/');
  if (existsSync(join(dir, '.mcp.json'))) signals.push('.mcp.json');
  return { found: signals.length >= 2, signals };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.list) {
    for (const line of formatCatalog(loadCatalog())) console.log(line);
    return 0;
  }

  if (args.fromExisting !== undefined) {
    const root = args.fromExisting || process.cwd();
    const d = detectRufloProject(root);
    if (d.found) {
      console.log(`Detected ruflo project at ${root}`);
      console.log(`Signals: ${d.signals.join(', ')}`);
      console.log('Eject mode will lift agents/skills/commands into a renamed harness.');
      console.log('(Full eject pipeline lands in iter 5.)');
      return 0;
    } else {
      console.log(`No ruflo project detected at ${root}`);
      console.log(`Signals seen: ${d.signals.length === 0 ? 'none' : d.signals.join(', ')}`);
      return 1;
    }
  }

  if (!args.name) {
    console.log('Usage: npx create-agent-harness <name> [--template <id>] [--host claude-code|codex|pi-dev|hermes] [--description "..."] [--force]');
    console.log('       npx create-agent-harness --from-existing [./path]');
    console.log('');
    console.log(`Templates: ${TEMPLATES.join(', ')}`);
    console.log(`Hosts: ${HOSTS.join(', ')}`);
    return 2;
  }

  const host = (args.hosts?.[0] ?? 'claude-code') as Host;
  if (!HOSTS.includes(host)) {
    console.error(`Unknown host: ${host}. Choose from: ${HOSTS.join(', ')}`);
    return 2;
  }

  const template = args.template ?? 'minimal';
  const targetDir = resolve(process.cwd(), args.name);

  try {
    const result = await scaffold({
      name: args.name,
      template,
      host,
      description: args.description,
      targetDir,
      force: args.force,
      generatorVersion: '0.1.0',
    });
    console.log(`Scaffolded ${args.name} into ${targetDir}`);
    console.log(`Files: ${result.paths.length}`);
    console.log(`Manifest: ${result.manifestPath}`);
    if (result.unresolved.length > 0) {
      console.log(`Warning: unresolved vars in template: ${result.unresolved.join(', ')}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export type { TemplateVars } from './renderer.js';
export { render, extractVarReferences, validateHarnessName } from './renderer.js';
export { walkTemplate, asFileMap } from './walker.js';
export { writeAtomic } from './writer.js';
export { emptyManifest, sha256, fingerprintFiles, diffFingerprints } from './manifest.js';
