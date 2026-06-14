// SPDX-License-Identifier: MIT
//
// Mustache-style {{var}} renderer + harness-name validation. Ported verbatim
// (behaviour-for-behaviour) from packages/create-agent-harness/src/renderer.ts
// so the browser output is byte-identical to what the CLI would emit. Keep the
// two in sync — there is a parity test in __tests__/render.test.ts.

export interface TemplateVars {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Render a Mustache-style template by substituting {{var}} occurrences.
 * Unresolved vars are left in place and reported, matching the CLI contract.
 */
export function render(
  template: string,
  vars: TemplateVars,
): { output: string; unresolved: string[] } {
  const unresolved = new Set<string>();
  const output = template.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (match, name: string) => {
      const v = vars[name];
      if (v === undefined) {
        unresolved.add(name);
        return match;
      }
      return String(v);
    },
  );
  return { output, unresolved: Array.from(unresolved).sort() };
}

/** Extract every {{var}} reference from a template. */
export function extractVarReferences(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)) {
    seen.add(m[1]!);
  }
  return Array.from(seen).sort();
}

/**
 * Validate that a harness name is npm-publishable. Mirrors npm's own rules
 * plus the kebab-case + leading-letter rule generated harnesses inherit.
 */
export function validateHarnessName(name: string): { valid: boolean; reason?: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { valid: false, reason: 'name must be a non-empty string' };
  }
  if (name.length > 214) {
    return { valid: false, reason: 'name must be <= 214 chars (npm limit)' };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { valid: false, reason: 'name must be kebab-case, leading lowercase letter, [a-z0-9-]' };
  }
  if (name.includes('--')) {
    return { valid: false, reason: 'name must not contain consecutive hyphens' };
  }
  if (name.endsWith('-')) {
    return { valid: false, reason: 'name must not end with a hyphen' };
  }
  return { valid: true };
}

/** PascalCase a kebab/space-delimited identifier (for class/exports). */
export function toPascalCase(input: string): string {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** kebab-case any free-form label so it is a safe file/dir name. */
export function toKebabCase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}
