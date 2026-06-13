// SPDX-License-Identifier: MIT
//
// AST-aware identifier rename for TypeScript template files.
//
// Why not just Mustache? Templates that are valid TS need to be PARSEABLE
// — Mustache's {{var}} is a syntax error in TS, so we can't use it inside
// .ts files without first wrapping in identifiers. Babel + traverse would
// give us perfect rename safety, but adds ~600 KB to the create-agent-
// harness install for one feature.
//
// Compromise: a token-boundary-aware regex rename that runs on the source
// AFTER Mustache rendering. We treat identifier characters [A-Za-z0-9_$]
// the way TS does — only rename inside word boundaries, never partial-
// word matches, and respect string-literal boundaries when the matching
// identifier is referenced.

export interface RenameRule {
  /** Source identifier (must match /^[A-Za-z_$][A-Za-z0-9_$]*$/). */
  from: string;
  /** Target identifier. */
  to: string;
}

const ID_CHAR = /[A-Za-z0-9_$]/;

/**
 * Rename identifiers in TS source, respecting word boundaries.
 *
 * Skips matches that:
 *   - are part of a longer word (e.g. renaming `foo` does NOT touch `foobar`)
 *   - are object property accesses on the LEFT side of a dot (e.g.
 *     `obj.foo` is left alone — that's a property of an object, not the
 *     identifier we're renaming)
 *
 * Does NOT skip matches inside string literals — string occurrences are
 * intentionally renamed too, since the harness's CLI references its own
 * name in lots of error messages and prompts.
 */
export function renameIdentifiers(source: string, rules: RenameRule[]): string {
  let out = source;
  for (const rule of rules) {
    if (!isValidIdentifier(rule.from)) {
      throw new Error(`renameIdentifiers: invalid 'from' identifier: ${rule.from}`);
    }
    if (!isValidIdentifier(rule.to)) {
      throw new Error(`renameIdentifiers: invalid 'to' identifier: ${rule.to}`);
    }
    out = renameOne(out, rule.from, rule.to);
  }
  return out;
}

function isValidIdentifier(s: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
}

function renameOne(source: string, from: string, to: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    // Try to find the next occurrence of `from`.
    const idx = source.indexOf(from, i);
    if (idx === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, idx);

    // Check the character before — if it's an identifier char, this is a
    // partial-word match, skip it.
    const prev = idx > 0 ? source[idx - 1] : '';
    // Check the character after.
    const after = source[idx + from.length] ?? '';

    const isWordBoundaryStart = !ID_CHAR.test(prev);
    const isWordBoundaryEnd = !ID_CHAR.test(after);
    const isPropertyAccess = prev === '.';

    if (isWordBoundaryStart && isWordBoundaryEnd && !isPropertyAccess) {
      out += to;
    } else {
      out += from;
    }
    i = idx + from.length;
  }
  return out;
}

/**
 * Rename across a file map, returning a NEW map. Convenience wrapper for
 * applying rules across many files.
 */
export function renameFileMap(files: Record<string, string>, rules: RenameRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    out[path] = renameIdentifiers(content, rules);
  }
  return out;
}
