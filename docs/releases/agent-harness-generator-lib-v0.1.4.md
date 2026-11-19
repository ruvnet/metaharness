# @ruvnet/agent-harness-generator 0.1.4: scaffold() works across filesystems

Package: `@ruvnet/agent-harness-generator@0.1.4` only.

## Fix

- 0.1.3 pinned `metaharness` 0.1.5, whose `writeAtomic()` staged the scaffold in the OS
  temp directory and then renamed it into place. When the target was on a different
  filesystem (a tmpfs `/tmp`, a second disk, another Windows drive), the documented
  `scaffold()` call failed with
  `EXDEV: cross-device link not permitted, rename '/tmp/create-agent-harness-…' -> './my-bot'`.
  `metaharness` fixed this in GH #42 (stage next to the target, copy fallback on EXDEV).
- The dependency is now pinned to `metaharness` 0.4.22, exact. Every name this package
  re-exports is still exported there.
- Cold install grows from about 8.5 MB (0.1.3) to about 31.6 MB of `node_modules`, because
  `metaharness` 0.4.22 depends on `@metaharness/avo`, `darwin`, `flywheel`, `redblue`,
  `turn-credit` and `weight-eft`.

## Metadata (ADR-356)

- `homepage` is `https://ruv.io`; `repository` points at `https://github.com/ruvnet/metaharness.git`
  with `directory: packages/agent-harness-generator-lib` (the old `agent-harness-generator`
  repository URL redirected there); `bugs` points at the metaharness issue tracker.
- Description is 162 characters and states the package's one job.
- README opens with the one job, supported environments, a quickstart whose output was
  captured from a clean install of the packed 0.1.4 tarball, and a link to `metaharness`.
  The earlier README content is kept under "Reference"; its example now reads
  `result.paths` (the field `scaffold()` returns) instead of `result.files`.

No API changes in this package.
