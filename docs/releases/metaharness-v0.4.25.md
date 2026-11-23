# metaharness 0.4.25: inspected directories stay data only

Package: `metaharness@0.4.25` only.

## Security fixes

- `harness diag <dir>` and `harness validate <dir>` no longer import `@metaharness/kernel` from the inspected directory's `node_modules`. The kernel version is still read from `<dir>` as JSON data; the backend probe uses the kernel this CLI ships with (#531).
- `analyze`, `analyze-repo` and `from-repo` no longer follow symlinks in the analyzed repo. High-signal files are read only when they are regular files, and `repo-profile.json` / `harness-plan.json` are not written through a symlink, special file or hard link (#531).

## Tests

New regression tests in `diag-backend.test.ts` and `analyze-repo.test.ts`; each fails without the fix.

No API changes.
