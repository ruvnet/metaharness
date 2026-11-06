// SPDX-License-Identifier: MIT
//
// Adversarial surface-file fixtures for the ADR-071 gate. Every entry here is a
// payload that must be REJECTED by both `validateGeneratedCode` and
// `inspectVariant`. The first group evaded the 0.12.x regex-only gate; the rest
// are variations that probe the AST layer specifically.
//
// Shared by ast-gate.test.ts and by the post-publish registry verification.

export interface BypassFixture {
  id: string;
  code: string;
}

const wrap = (body: string): string => `// SPDX-License-Identifier: MIT
export function createPlan(task: string): Array<{ kind: string }> {
  ${body}
  return [{ kind: 'verify' }];
}
`;

/** Payloads that evaded the regex-only gate in <= 0.12.1. */
export const REPORTED_BYPASSES: readonly BypassFixture[] = [
  { id: 'getBuiltinModule-fs', code: wrap(`process.getBuiltinModule('fs').writeFileSync('/tmp/x', task);`) },
  { id: 'getBuiltinModule-child', code: wrap(`process.getBuiltinModule('child' + '_process').execFileSync('id');`) },
  { id: 'array-map-constructor', code: wrap(`[].map.constructor('return 1')();`) },
  { id: 'computed-process-key', code: wrap(`const k = 'bind' + 'ing'; (process as any)[k]('fs');`) },
  { id: 'computed-process-var', code: wrap(`const k = task; const p = process; (p as any)[k];`) },
];

/** Further variations the AST layer must catch. */
export const AST_VARIANTS: readonly BypassFixture[] = [
  { id: 'string-concat-constructor', code: wrap(`const f = ([] as any)['constr' + 'uctor']['constr' + 'uctor']; f('return 1')();`) },
  { id: 'template-constructor', code: wrap('const a = `uctor`; const f = ([] as any)[`constr${a}`]; f;') },
  { id: 'destructured-constructor', code: wrap(`const { constructor: C } = (() => 0) as any; C('return 1')();`) },
  { id: 'stashed-constructor-string', code: wrap(`const k = 'constructor'; const C = ({} as any)[k][k]; C('return 1')();`) },
  { id: 'fromCharCode-key', code: wrap(`const o: any = {}; o[String.fromCharCode(99, 111)];`) },
  { id: 'proto-chain', code: wrap(`const p = Object.getPrototypeOf(async () => {}); (p as any).constructor('return 1');`) },
  { id: 'optional-member', code: wrap(`const C = ((() => 0) as any)?.constructor; C;`) },
  { id: 'global-alias', code: wrap(`const g = global; (g as any).x = 1;`) },
  { id: 'this-escape', code: `export function createPlan(): unknown { return (function (this: any) { return this; })(); }\n` },
  { id: 'dynamic-import-indirect', code: `export async function createPlan(m: string): Promise<unknown> { return import(m); }\n` },
  { id: 'value-import', code: `import { readFileSync } from 'node:fs';\nexport const createPlan = () => readFileSync;\n` },
  { id: 'side-effect-import', code: `import './other.ts';\nexport const createPlan = () => [];\n` },
  { id: 're-export', code: `export * from 'node:os';\n` },
  { id: 'reexport-named', code: `export { hostname } from 'os';\n` },
  { id: 'import-equals', code: `import fs = require('fs');\nexport const createPlan = () => fs;\n` },
  { id: 'import-meta', code: `export const createPlan = () => import.meta.url;\n` },
  { id: 'reflect', code: wrap(`Reflect.apply(Math.max, null, [1]);`) },
  { id: 'timer-string', code: wrap(`setTimeout('1', 0);`) },
  { id: 'stack-trace-hook', code: wrap(`(Error as any).prepareStackTrace = (_e: unknown, s: unknown) => s;`) },
  { id: 'arguments-callee', code: `export function createPlan(): unknown { return arguments; }\n` },
  { id: 'unparseable', code: `export function createPlan( { return [ ;\n` },
];

export const ALL_BYPASS_FIXTURES: readonly BypassFixture[] = [...REPORTED_BYPASSES, ...AST_VARIANTS];
