# metaharness 0.4.23: exact pins for the @metaharness/* dependencies

Package: `metaharness@0.4.23` only.

## Fix

metaharness 0.4.22 declared its own scoped packages as 0.x caret ranges. A 0.x caret only matches patches inside one minor line, so `^0.1.4` kept every install on `@metaharness/avo` 0.1.5 after avo 0.2.x was published. Each dependency is now an exact pin to its current release:

| Dependency | 0.4.22 range | 0.4.23 pin |
|---|---|---|
| `@metaharness/avo` | `^0.1.4` (resolved 0.1.5) | `0.2.1` |
| `@metaharness/darwin` | `^0.13.0` | `0.13.1` |
| `@metaharness/flywheel` | `^0.1.1` | `0.1.14` |
| `@metaharness/redblue` | `^0.1.6` | `0.1.7` |
| `@metaharness/turn-credit` | `^0.1.0` | `0.1.1` |
| `@metaharness/weight-eft` | `^0.1.0` | `0.1.3` |

All six remain required `dependencies`. No dependency was added.

## Compatibility

`metaharness avo|flywheel|redblue|weight-eft|turn-credit` call `dispatch(sub, args)` from each package's `/cli` export. That signature is unchanged in every pinned version; the avo `/cli` module is byte-identical between 0.1.5 and 0.2.1 (0.2.x adds the `claim-gate` library export). `@metaharness/darwin` is not imported at runtime; it supplies the `metaharness-darwin` bin. Scaffolded harnesses still get `@metaharness/darwin` `^0.13.0` as a devDependency.

## Tests

`__tests__/pinned-deps.test.ts` checks that each of the six is an exact pin in `dependencies`, that the installed copy has exactly that version, and runs `main([verb])` for each delegated verb against the real package.

No API changes.
