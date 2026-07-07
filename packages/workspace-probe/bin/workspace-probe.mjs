#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { runCli } from '../dist/cli.js';
runCli(process.argv.slice(2)).then((code) => process.exit(code));
