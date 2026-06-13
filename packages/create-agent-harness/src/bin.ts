#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { main } from './index.js';

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
