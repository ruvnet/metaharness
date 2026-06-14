// SPDX-License-Identifier: MIT
//
// @ruvnet/agent-harness-generator — library/core API for the harness generator.
//
// The actual implementation lives in the `openharness` package (which is the
// published CLI). This package re-exports the JS API surface so consumers can
// import it cleanly without depending on the CLI's `bin` entry:
//
//     import { scaffold, validateHarnessName, HOSTS, TEMPLATES }
//       from '@ruvnet/agent-harness-generator';
//
// Why split? Per the user's iter-108 naming directive:
//   - `openharness`                     — the CLI, what users run (`npx openharness`)
//   - `@ruvnet/agent-harness-generator` — the library, what code imports
//
// One source of truth (openharness), two published names. The wrapper has no
// implementation of its own — if you find yourself adding logic here, that
// logic belongs in openharness and gets re-exported.

export {
  // Core scaffold pipeline.
  scaffold,
  parseArgs,
  main,
  detectRufloProject,
  templateDir,
  // Catalog surface.
  HOSTS,
  TEMPLATES,
  loadCatalog,
  formatCatalog,
  // Rendering primitives.
  render,
  extractVarReferences,
  validateHarnessName,
  walkTemplate,
  asFileMap,
  writeAtomic,
  // Manifest + fingerprinting (used by `harness compare`).
  emptyManifest,
  sha256,
  fingerprintFiles,
  diffFingerprints,
} from 'openharness';

export type {
  Host,
  TemplateId,
  CatalogEntry,
  CliArgs,
  ScaffoldOptions,
  ScaffoldResult,
  TemplateVars,
} from 'openharness';
