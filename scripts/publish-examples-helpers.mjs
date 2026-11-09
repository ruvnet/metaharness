// SPDX-License-Identifier: MIT
//
// iter 136 — helpers for writing per-target example packages.
//
// Used by:
//   - the in-session Workflow output → scripts/write-example-packages.mjs
//   - scripts/publish-examples-batch.mjs (next iter)
//
// One pure function per concern; no side effects here. Caller wires
// files to disk + invokes npm.

export function packageJsonFor(target, description) {
  // bin command name must be a valid filename — no scope/slash. Use a
  // string bin so npm installs the command under the package's unscoped
  // name (`devops`, `hermes`, …) and `npx @metaharness/<name>` runs it.
  const keywords = [
    'metaharness',
    'agent-harness',
    'agent-harness-generator',
    target.name,
    target.kind, // 'host' | 'vertical'
    target.host,
    'ai-agent',
    'mcp',
    'npx',
    'scaffold',
  ];
  return JSON.stringify({
    name: `@metaharness/${target.name}`,
    version: '0.1.0',
    description,
    homepage: 'https://ruv.io',
    repository: {
      type: 'git',
      url: 'git+https://github.com/ruvnet/metaharness.git',
      directory: `examples-packages/${target.name}`,
    },
    bugs: { url: 'https://github.com/ruvnet/metaharness/issues' },
    license: 'MIT',
    author: 'rUv <ruv@ruv.net>',
    type: 'module',
    bin: './bin/scaffold.mjs',
    files: ['bin/**', 'README.md', 'LICENSE'],
    scripts: {
      // Sanity-only: syntax-check the bin without running a real scaffold.
      smoke: 'node --check bin/scaffold.mjs',
    },
    keywords: [...new Set(keywords)],
    publishConfig: { access: 'public' },
    engines: { node: '>=20.0.0' },
  }, null, 2) + '\n';
}

export const LICENSE_MIT = `MIT License

Copyright (c) 2026 rUv

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
