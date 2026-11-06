# @metaharness/kernel

## 0.1.4

- Publish the contributor-install repair from #442 for registry consumers: unavailable native packages are optional peers rather than automatically resolved optional dependencies. This avoids invalid npm 11 clean-install locks.
- Preserve native → WASM → JavaScript backend discovery. Native binaries remain explicit opt-ins when available; this release does not publish native platform packages.
- Correct repository provenance to `ruvnet/metaharness`.

Verify a built tarball with `node scripts/kernel-consumer-smoke.mjs`: ordinary npm install, clean npm ci, and actual kernel loading. After publication, repeat with `--registry` to fetch the exact version from npm. Existing 0.1.3 manifests cannot be rewritten.

Existing projects locked to 0.1.3 should run `npm install @metaharness/kernel@^0.1.4` after publication to refresh their lockfile before `npm ci`.
