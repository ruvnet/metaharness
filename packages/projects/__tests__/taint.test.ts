// SPDX-License-Identifier: MIT
//
// Tests for taint.ts — the deterministic SOURCE→SINK reachability heuristic. The
// load-bearing properties: a sink fed by untrusted input is 'high'; the same sink
// on a literal is 'low'; reachability does NOT leak across function boundaries;
// and the scan is fully deterministic.

import { describe, it, expect } from 'vitest';
import {
  taintScan,
  combineWithStatic,
  UNTRUSTED_SOURCES,
  SINKS,
  type TaintFinding,
} from '../src/taint.js';

describe('taintScan', () => {
  it('(1) eval(request.args...) in a function ⇒ reachable, high, source detected', () => {
    const src = [
      'def handler():',
      "    return eval(request.args.get('x'))",
    ].join('\n');
    const findings = taintScan(src);
    const evalF = findings.find((f) => f.sink === 'eval(');
    expect(evalF).toBeDefined();
    expect(evalF!.reachable).toBe(true);
    expect(evalF!.severity).toBe('high');
    expect(evalF!.source).toBe('request.args');
    expect(evalF!.fn).toBe('handler');
    expect(evalF!.cwe).toBe('CWE-95');
    expect(evalF!.line).toBe(2);
  });

  it('(2) eval("1+1") literal with no source ⇒ not reachable, low', () => {
    const src = ['def safe():', '    return eval("1+1")'].join('\n');
    const findings = taintScan(src);
    const evalF = findings.find((f) => f.sink === 'eval(');
    expect(evalF).toBeDefined();
    expect(evalF!.reachable).toBe(false);
    expect(evalF!.severity).toBe('low');
    expect(evalF!.source).toBeNull();
  });

  it('(3) per-function isolation — a source in fn A does not taint a sink in fn B', () => {
    const src = [
      'def a():',
      '    x = request.args.get("q")',
      '    return x',
      '',
      'def b():',
      '    return eval("2+2")',
    ].join('\n');
    const findings = taintScan(src);
    const evalF = findings.find((f) => f.sink === 'eval(');
    expect(evalF).toBeDefined();
    expect(evalF!.fn).toBe('b');
    expect(evalF!.reachable).toBe(false);
    expect(evalF!.severity).toBe('low');
    expect(evalF!.source).toBeNull();
  });

  it('(4) os.system + sys.argv ⇒ high, CWE-78', () => {
    const src = [
      'def run():',
      '    cmd = sys.argv[1]',
      '    os.system(cmd)',
    ].join('\n');
    const findings = taintScan(src);
    const sysF = findings.find((f) => f.sink === 'os.system(');
    expect(sysF).toBeDefined();
    expect(sysF!.reachable).toBe(true);
    expect(sysF!.severity).toBe('high');
    expect(sysF!.cwe).toBe('CWE-78');
    expect(sysF!.source).toBe('sys.argv');
  });

  it('(5) determinism — same input yields identical output', () => {
    const src = [
      'def a():',
      '    return eval(request.args.get("x"))',
      'def b():',
      '    return eval("ok")',
      'def c():',
      '    os.system(os.getenv("CMD"))',
    ].join('\n');
    const r1 = taintScan(src);
    const r2 = taintScan(src);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('yaml.load is medium regardless of taint', () => {
    const tainted = taintScan(['def f():', '    yaml.load(request.data)'].join('\n'));
    const clean = taintScan(['def g():', '    yaml.load("a: 1")'].join('\n'));
    expect(tainted.find((f) => f.sink === 'yaml.load(')!.severity).toBe('medium');
    expect(clean.find((f) => f.sink === 'yaml.load(')!.severity).toBe('medium');
    expect(tainted.find((f) => f.sink === 'yaml.load(')!.cwe).toBe('CWE-502');
  });

  it('subprocess shell=True with untrusted input ⇒ high CWE-78', () => {
    const src = [
      'def deploy():',
      '    target = request.form.get("t")',
      '    subprocess.run(target, shell=True)',
    ].join('\n');
    const f = taintScan(src).find((x) => x.sink === 'subprocess(shell=True)');
    expect(f).toBeDefined();
    expect(f!.reachable).toBe(true);
    expect(f!.severity).toBe('high');
    expect(f!.cwe).toBe('CWE-78');
  });

  it('module-level sink is attributed to <module>', () => {
    const src = ['eval(input())'].join('\n');
    const f = taintScan(src).find((x) => x.sink === 'eval(');
    expect(f!.fn).toBe('<module>');
    expect(f!.reachable).toBe(true);
    expect(f!.source).toBe('input(');
  });

  it('exposes non-empty source and sink catalogs', () => {
    expect(UNTRUSTED_SOURCES.length).toBeGreaterThan(0);
    expect(SINKS.length).toBeGreaterThan(0);
    expect(UNTRUSTED_SOURCES).toContain('request.args');
  });
});

describe('combineWithStatic', () => {
  it('bumps a finding to high when its fn is confirmed by a static tool', () => {
    const taint: TaintFinding[] = taintScan(
      ['def safe():', '    return eval("1+1")'].join('\n'),
    );
    expect(taint[0].severity).toBe('low');
    const combined = combineWithStatic(taint, ['safe']);
    expect(combined[0].severity).toBe('high');
    // Original array is not mutated.
    expect(taint[0].severity).toBe('low');
  });

  it('leaves findings untouched when fn is not in staticFns', () => {
    const taint = taintScan(['def safe():', '    return eval("1+1")'].join('\n'));
    const combined = combineWithStatic(taint, ['other']);
    expect(combined[0].severity).toBe('low');
  });
});
