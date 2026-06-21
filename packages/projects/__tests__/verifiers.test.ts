// SPDX-License-Identifier: MIT
//
// Tests for verifiers.ts (language-agnostic proof VERIFIER registry).
//
// Deterministic and process-free: these exercise only the pure builders
// (detection, extraction, driver/argv construction). Actual subprocess execution
// lives in benches, not here.

import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  extractCode,
  verifierFor,
  type Language,
} from '../src/verifiers.js';

describe('detectLanguage', () => {
  it('classifies python snippets as python', () => {
    expect(detectLanguage('def f(x):\n    return x + 1')).toBe('python');
    expect(detectLanguage('import os\nprint(os.getcwd())')).toBe('python');
    expect(detectLanguage('for i in range(3):\n    print(i)')).toBe('python');
  });

  it('classifies javascript snippets as javascript', () => {
    expect(detectLanguage('function f(x) { return x + 1; }')).toBe('javascript');
    expect(detectLanguage('const f = (x) => x + 1;')).toBe('javascript');
    expect(detectLanguage("const x = require('fs');")).toBe('javascript');
    expect(detectLanguage('console.log("hi");')).toBe('javascript');
  });

  it('defaults to python with no clear signal', () => {
    expect(detectLanguage('x = 1\ny = 2')).toBe('python');
    expect(detectLanguage('')).toBe('python');
  });
});

describe('extractCode', () => {
  it('strips a ```python fence', () => {
    const raw = '```python\ndef f(x):\n    return x\n```';
    expect(extractCode(raw)).toBe('def f(x):\n    return x');
  });

  it('strips a ```js fence', () => {
    const raw = '```js\nfunction f(x) { return x; }\n```';
    expect(extractCode(raw)).toBe('function f(x) { return x; }');
  });

  it('strips a bare ``` fence', () => {
    const raw = '```\nplain code\n```';
    expect(extractCode(raw)).toBe('plain code');
  });

  it('trims un-fenced input unchanged', () => {
    expect(extractCode('  def f(): pass  ')).toBe('def f(): pass');
  });
});

describe('verifierFor(python)', () => {
  const spec = verifierFor('python');

  it('uses python3 with the isolated/no-bytecode flags', () => {
    expect(spec.language).toBe('python');
    expect(spec.bin).toBe('python3');
    expect(spec.args('/tmp/cand.py', '[1,2]')).toEqual([
      '-I',
      '-B',
      '/tmp/cand.py',
      '[1,2]',
    ]);
  });

  it('driver embeds the code and a JSON-printing harness calling fn', () => {
    const code = 'def boom(x):\n    raise ValueError("x")';
    const driver = spec.driver(code, 'boom');
    expect(driver).toContain(code);
    expect(driver).toContain('boom(*ARGS)');
    expect(driver).toContain('json.loads(sys.argv[1])');
    expect(driver).toContain('"triggered": True');
    expect(driver).toContain('"triggered": False');
    expect(driver).toContain('type(e).__name__');
  });
});

describe('verifierFor(javascript)', () => {
  const spec = verifierFor('javascript');

  it('uses node and a [file, argsJson] argv', () => {
    expect(spec.language).toBe('javascript');
    expect(spec.bin).toBe('node');
    expect(spec.args('/tmp/cand.js', '[1,2]')).toEqual(['/tmp/cand.js', '[1,2]']);
  });

  it('driver references the fn and parses process.argv[2]', () => {
    const code = 'function boom(x) { throw new TypeError("x"); }';
    const driver = spec.driver(code, 'boom');
    expect(driver).toContain(code);
    expect(driver).toContain('JSON.parse(process.argv[2])');
    expect(driver).toContain('"boom"');
    expect(driver).toContain('triggered');
    expect(driver).toContain('constructor.name');
  });
});

describe('determinism', () => {
  it('produces identical output for identical input', () => {
    for (const lang of ['python', 'javascript'] as Language[]) {
      const a = verifierFor(lang);
      const b = verifierFor(lang);
      const code = 'X';
      expect(a.driver(code, 'g')).toBe(b.driver(code, 'g'));
      expect(a.args('f', 'j')).toEqual(b.args('f', 'j'));
    }
    expect(detectLanguage('def f(): pass')).toBe(detectLanguage('def f(): pass'));
    expect(extractCode('```py\nz\n```')).toBe(extractCode('```py\nz\n```'));
  });
});
