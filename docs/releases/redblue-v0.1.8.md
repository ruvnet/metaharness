# @metaharness/redblue 0.1.8: `redblue defense`

Package: `@metaharness/redblue@0.1.8` only.

## New

- `redblue defense <replay|verify|benchmark|help>` adds the blue side: replay ARTEX findings or identity and edge telemetry against a baseline and a candidate detection policy, simulate a session quarantine, and verify the result with a MetaHarness receipt. It forwards to `@metaharness/artex-defense`, now a dependency (exact `0.1.0`), loaded only when the subcommand runs. Errors from that package are already sanitized and are printed with a `redblue defense:` prefix.
- README: a "Defense replay" section with an animated pipeline diagram, a CLI line, and six new keywords.

No change to the attack, patch, retest, report or HackerOne commands. `create-agent-harness` still pins redblue `0.1.7`, so `metaharness redblue defense` arrives with its next release.
