#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { main } from './index.js';

// #73: propagate main()'s exit code. `main()` returns a numeric code from every
// command path (0 on success, non-zero on failure); historically this value was
// discarded, so EVERY subcommand exited 0 and a failed command looked green in
// CI/scripts. Set process.exitCode (not process.exit) so buffered stdout/stderr
// still flushes before the process ends. `learn` sets process.exitCode itself and
// also returns the same code (PR #72), so this assignment is idempotent for it.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err: unknown) => {
    // Expected failures throw an Error with a clean message — print that, no
    // raw stack. Unknown throwables get stringified.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
