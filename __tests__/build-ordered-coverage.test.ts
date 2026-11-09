// SPDX-License-Identifier: MIT
//
// `npm run build` only compiles the packages listed in scripts/build-ordered.mjs
// PHASES. A package with a build script that is missing from PHASES is never
// compiled, so the release workflow packs it without dist/ (this is how
// @metaharness/aws-finops@0.1.0 reached npm with no entry point).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const script = readFileSync(join(root, 'scripts', 'build-ordered.mjs'), 'utf8');
const phases = script.slice(script.indexOf('const PHASES'), script.indexOf('];', script.indexOf('const PHASES')));

describe('build-ordered PHASES', () => {
  const dirs = readdirSync(join(root, 'packages')).filter((d) => {
    const f = join(root, 'packages', d, 'package.json');
    return existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).scripts?.build;
  });
  for (const d of dirs) {
    it(`builds packages/${d}`, () => {
      expect(phases).toContain(`'${d}'`);
    });
  }
});
