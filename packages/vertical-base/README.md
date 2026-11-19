# @metaharness/vertical-base

<!-- ruv-seo:start (ADR-356) -->

The shared contract for MetaHarness vertical packs: the `VerticalPack` and `VerticalManifest` types plus `readVerticalManifest`, `validateVerticalManifest` and `verifyTemplateFilesPresent`, so a pack author can check a manifest before publishing.

**Supported environments:** Node.js 20+ on Linux, macOS and Windows. ESM only (`import`, not `require`). Pure JavaScript, no native build step.

## Quickstart

```bash
mkdir demo && cd demo && npm init -y >/dev/null
npm install @metaharness/vertical-base
cat > quickstart.mjs <<'EOF'
import { validateVerticalManifest } from '@metaharness/vertical-base';
const manifest = {
  id: 'my-vertical', description: 'My custom vertical',
  files: [{ src: 'CLAUDE.md.tmpl', dst: 'CLAUDE.md', render: true }],
  vars: [{ name: 'name', prompt: 'Harness name', default: 'my-bot' }],
};
validateVerticalManifest(manifest);
console.log('valid:', manifest.id);
try { validateVerticalManifest({ ...manifest, files: [{ src: 'a.tmpl', dst: 'a' }] }); }
catch (e) { console.log('rejected:', e.message); }
EOF
node quickstart.mjs
```

Expected output:

```text
valid: my-vertical
rejected: manifest.files entry "a.tmpl" missing render flag
```

**Next:** [`@metaharness/vertical-trading`](https://www.npmjs.com/package/@metaharness/vertical-trading) — a pack built on this contract.

**Where it fits:** `@metaharness/vertical-trading` depends on it and loads its manifest with `readVerticalManifest`. Note: the export names are `readVerticalManifest` / `validateVerticalManifest`; the older notes below call them `loadVerticalPack` / `validateManifest`.
<!-- ruv-seo:end -->

## Reference

Shared contract for [`@metaharness/vertical-*`](https://github.com/ruvnet/agent-harness-generator) packs — the type-only / runtime-helper module that every standalone vertical pack consumes so the generator can load them uniformly.

## What it is

Per [ADR-013](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-013-vertical-packs-publishing.md), vertical packs (trading, legal, research, …) are **published as standalone npm packages** so each can be owned by a domain expert without touching `create-agent-harness`. This module is the contract those packs implement.

```
@metaharness/vertical-base               <- shared contract (this package)
  ↑
  ├── @metaharness/vertical-trading      <- standalone pack, ships independently
  ├── @metaharness/vertical-legal        <- standalone pack
  ├── @metaharness/vertical-research     <- standalone pack
  └── ...                          <- third-party packs implement the same interface
```

## What's exported

| Export | Purpose |
|---|---|
| `VerticalPack` (type) | Top-level interface each pack default-exports |
| `VerticalManifest` (type) | Single template's manifest shape (`vars`, `files`, `agents`, `skills`, `commands`, …) |
| `TemplateVar` / `TemplateFileEntry` | Building blocks for manifests |
| `loadVerticalPack(modulePath)` | Runtime loader the CLI uses to ingest external packs |
| `validateManifest(m)` | Pre-publish + load-time sanity check |

## Authoring a new vertical pack

```ts
// my-pack/src/index.ts
import type { VerticalPack } from '@metaharness/vertical-base';

const pack: VerticalPack = {
  id: 'my-vertical',
  displayName: 'My Custom Vertical',
  templates: [
    {
      id: 'my-template',
      vars: [{ name: 'name', prompt: 'Harness name', default: 'my-bot' }],
      files: [
        { src: 'templates/CLAUDE.md', dst: 'CLAUDE.md', render: true },
      ],
      agents: [ /* ... */ ],
      skills: [ /* ... */ ],
      commands: [ /* ... */ ],
    },
  ],
};

export default pack;
```

Then publish as `@your-scope/vertical-my-vertical` and users can load it:

```bash
npx create-agent-harness my-bot --vertical @your-scope/vertical-my-vertical
```

## Why a separate package?

- **Independent ownership** — domain experts publish without PRing the generator
- **Independent cadence** — a vertical can bump without touching the kernel
- **Cleaner attack surface** — the generator never executes pack code at scaffold time; it only reads manifests
- **Lock-step versioning** — packs declare `peerDependencies` on `@metaharness/vertical-base` so breaking-shape changes are visible at install time

## See also

- [ADR-013 — Vertical packs publishing](https://github.com/ruvnet/agent-harness-generator/blob/main/docs/adrs/ADR-013-vertical-packs-publishing.md)
- [`@metaharness/vertical-trading`](https://www.npmjs.com/package/@metaharness/vertical-trading) — reference implementation
- [`create-agent-harness`](https://www.npmjs.com/package/create-agent-harness) — consumer

## License

MIT
