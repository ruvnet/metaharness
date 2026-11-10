# @metaharness/agntcy 0.1.3: installs from npm without the Buf registry

Package: `@metaharness/agntcy@0.1.3` only.

## Fix

- Up to 0.1.2, `npm install @metaharness/agntcy` failed with
  `404 '@buf/agntcy_dir.bufbuild_es@2.16.0-…' is not in this registry` unless the
  consumer first added `@buf:registry=https://buf.build/gen/npm/v1/` to `.npmrc`. The
  required `agntcy-dir` SDK depends on a package only the Buf registry serves.
- The Directory SDK is now an optional dependency. `agntcy-dir`, `@bufbuild/protobuf` and
  `@buf/agntcy_dir.bufbuild_es` (the last two were imported directly by `oasf/publish.ts`
  but never declared) are `optionalDependencies`, and `publishToDirectory()` loads them
  with `import()` when it runs. A plain install now succeeds, and identity, OASF
  projection, observability and CASA work without the SDK.
- Without the SDK, `publishToDirectory()` returns `{ published: false, reason }`, and the
  reason names the `.npmrc` line and the install command. With the SDK installed,
  behaviour is unchanged.
- On Node 20, npm also skips the optional SDK because `@connectrpc/connect-node` declares
  Node >=22; install it explicitly to publish from Node 20. The SDK-driven test suites in
  this repo now run only where the SDK is installed.
- The installed-artifact release smoke now also installs the tarball in a directory with
  no `.npmrc` and runs the CASA path, so this cannot regress silently.
- README: the `.npmrc` step moved from the quickstart into a "Directory publishing
  (optional)" section; the quickstart output was captured from a clean install of the
  packed 0.1.3 tarball with no `.npmrc`. Adds a small animated flow diagram.

- `PublishTarget.config` is now typed by a structural `DirectoryConfig` interface (the
  fields this package reads from the SDK's `Config`), so the package builds and its `.d.ts`
  files type-check without the SDK installed. A real `agntcy-dir` `Config` instance is still
  what you pass.

No API changes. Directory publishing still needs the SDK and the Buf registry line.
