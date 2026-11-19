// SPDX-License-Identifier: MIT
//
// AST allowlist layer of the ADR-071 safety gate.
//
// The regex layer in `safety.ts` matches text. This layer parses each surface
// file (TypeScript-aware, as an ES module) and walks the syntax tree, so it is
// independent of spelling, whitespace, comments and string concatenation in
// ways a pattern list cannot be. A parse failure is a REJECTION, never a pass.
//
// What a mutation surface may contain is pure policy logic over its arguments.
// The walker therefore rejects:
//   - any module loading: dynamic `import()`, `require`, value imports (only
//     `import type` is allowed), re-exports from another module, `import.meta`,
//     TS `import x = require(...)` / `export =`;
//   - references to ambient capability objects (process, the global object,
//     module-system bindings, dynamic-code constructors, reflection/proxy,
//     network and timer globals, WebAssembly);
//   - access to members that lead to constructors, prototypes, stack-frame
//     internals or Node loader internals, whether spelled `a.b`, `a['b']`,
//     `a[`b`]`, `a?.b`, or via destructuring `{ b: x } = a`;
//   - computed member keys that are built at runtime from strings (calls,
//     string concatenation, interpolated templates);
//   - the bare string values of those member names (so they cannot be stashed
//     in a variable and used as a computed key);
//   - `this` outside a class body (a non-module file is sloppy-mode CJS, where
//     a plain function call's `this` is the global object), `with`, `arguments`.
//
// Static analysis cannot prove `obj[k]` never resolves to a forbidden member
// when `k` is an arbitrary variable; the Tier-2 child process therefore also
// runs with string code generation disabled and under Node's permission model
// (see tier2-sandbox.ts). This layer is one of several, not the only one.
import { parse } from '@babel/parser';
/** Ambient identifiers a surface file may never reference or bind. */
export const BANNED_IDENTIFIERS = new Set([
    'process', 'globalThis', 'global', 'window', 'self', 'frames', 'top', 'parent',
    'require', 'module', 'exports', '__filename', '__dirname', 'arguments',
    'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
    'Reflect', 'Proxy', 'WebAssembly', 'Buffer', 'SharedArrayBuffer', 'Atomics',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebSocketStream', 'navigator',
    'importScripts', 'Worker', 'BroadcastChannel',
    'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
    'Deno', 'Bun',
]);
/** Member names that lead to constructors, prototypes, or runtime internals. */
export const BANNED_MEMBERS = new Set([
    'constructor', '__proto__', 'prototype',
    '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
    'caller', 'callee', 'prepareStackTrace', 'captureStackTrace',
    'getBuiltinModule', 'binding', '_linkedBinding', 'dlopen', 'mainModule',
    'globalThis', 'process', 'require',
]);
/** String literals that may never appear verbatim (stash-then-index guard). */
const BANNED_STRINGS = new Set([
    ...BANNED_MEMBERS,
    'eval', 'Function', 'child_process', 'node:child_process',
]);
/** Keys that hold TypeScript type-only subtrees (no runtime code). */
const TYPE_ONLY_KEYS = new Set([
    'typeAnnotation', 'typeParameters', 'returnType', 'superTypeParameters', 'implements',
    'typeArguments',
]);
/** Node types that are type-only declarations (no runtime code). */
const TYPE_ONLY_NODES = new Set([
    'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSDeclareMethod',
    'TSIndexSignature',
]);
/** Node keys that never contain child nodes we need to visit. */
const SKIP_KEYS = new Set([
    'loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments',
    'innerComments', 'comments', 'tokens', 'errors',
]);
function isNode(v) {
    return typeof v === 'object' && v !== null && typeof v.type === 'string';
}
/** Static name of a member key, or undefined when it is not statically known. */
function staticKeyName(key, computed) {
    if (!computed && key.type === 'Identifier')
        return key.name;
    if (!computed && key.type === 'PrivateName')
        return undefined;
    if (key.type === 'StringLiteral')
        return key.value;
    if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
        const q = key.quasis[0];
        return q?.value.cooked ?? q?.value.raw;
    }
    if (key.type === 'NumericLiteral')
        return String(key.value);
    return undefined;
}
/** True when an expression may evaluate to a string assembled from string pieces. */
function buildsString(n) {
    switch (n.type) {
        case 'StringLiteral':
            return true;
        case 'TemplateLiteral':
            return n.expressions.length > 0;
        case 'BinaryExpression':
            return n.operator === '+' && (buildsString(n.left) || buildsString(n.right));
        default:
            return false;
    }
}
/** Is this computed member key acceptable (not assembled from strings at runtime)? */
function isAcceptableComputedKey(key) {
    switch (key.type) {
        case 'Identifier':
        case 'NumericLiteral':
        case 'StringLiteral':
        case 'BigIntLiteral':
        case 'BooleanLiteral':
        case 'NullLiteral':
            return true;
        case 'TemplateLiteral':
            return key.expressions.length === 0;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
            return true; // its own key is checked when the walker visits it
        case 'UnaryExpression':
            return key.operator !== 'typeof' && isAcceptableComputedKey(key.argument);
        case 'UpdateExpression':
            return true;
        case 'BinaryExpression':
            if (key.operator === '+') {
                return !buildsString(key) &&
                    isAcceptableComputedKey(key.left) &&
                    isAcceptableComputedKey(key.right);
            }
            return isAcceptableComputedKey(key.left) && isAcceptableComputedKey(key.right);
        case 'ConditionalExpression':
            return isAcceptableComputedKey(key.consequent) && isAcceptableComputedKey(key.alternate);
        case 'TSAsExpression':
        case 'TSNonNullExpression':
        case 'TSSatisfiesExpression':
        case 'ParenthesizedExpression':
            return isAcceptableComputedKey(key.expression);
        default:
            return false; // calls, assignments, sequences, `${...}` templates, …
    }
}
/**
 * Analyse one surface file's source. Returns the list of reasons it is rejected;
 * an empty list means the AST layer admits it.
 */
export function analyzeSurfaceSource(code) {
    let ast;
    try {
        ast = parse(code, {
            sourceType: 'module',
            plugins: ['typescript'],
            errorRecovery: false,
            allowReturnOutsideFunction: false,
            allowImportExportEverywhere: false,
        });
    }
    catch (e) {
        return [`unparseable source (${e.message.split('\n')[0]})`];
    }
    const findings = new Set();
    const add = (reason, n) => {
        const line = n?.loc?.start?.line;
        findings.add(line ? `${reason} (line ${line})` : reason);
    };
    const visit = (node, parent, parentKey, classDepth) => {
        if (TYPE_ONLY_NODES.has(node.type))
            return;
        switch (node.type) {
            case 'ImportExpression':
                add('dynamic import()', node);
                break;
            case 'Import':
                add('dynamic import()', node);
                break;
            case 'ImportDeclaration': {
                const specs = node.specifiers ?? [];
                const typeOnly = node.importKind === 'type' ||
                    (specs.length > 0 && specs.every((s) => s.importKind === 'type'));
                if (!typeOnly)
                    add(`value import of module ${JSON.stringify(node.source.value)}`, node);
                return; // nothing executable below a type-only import
            }
            case 'ExportAllDeclaration':
                if (node.exportKind !== 'type')
                    add('re-export from another module', node);
                return;
            case 'ExportNamedDeclaration':
                if (node.source && node.exportKind !== 'type') {
                    const specs = node.specifiers ?? [];
                    if (!(specs.length > 0 && specs.every((s) => s.exportKind === 'type'))) {
                        add('re-export from another module', node);
                    }
                }
                break;
            case 'TSImportEqualsDeclaration':
                if (node.importKind !== 'type')
                    add('TS import-equals (module loading)', node);
                return;
            case 'TSExternalModuleReference':
                add('TS external module reference', node);
                return;
            case 'TSExportAssignment':
                add('TS export assignment (CommonJS)', node);
                break;
            case 'MetaProperty': {
                const meta = node.meta.name;
                if (meta === 'import')
                    add('import.meta', node);
                break;
            }
            case 'WithStatement':
                add('with statement', node);
                break;
            case 'ThisExpression':
                if (classDepth === 0)
                    add('`this` outside a class body', node);
                break;
            case 'Identifier': {
                const name = node.name;
                // A non-computed member property / object key is a property NAME, not a
                // reference — those are checked by the member rules below.
                const isPropName = ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') &&
                    parentKey === 'property' && !parent.computed) ||
                    ((parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod' ||
                        parent?.type === 'ClassMethod' || parent?.type === 'ClassProperty' ||
                        parent?.type === 'ClassAccessorProperty' || parent?.type === 'TSPropertySignature' ||
                        parent?.type === 'TSEnumMember') &&
                        parentKey === 'key' && !parent.computed);
                if (!isPropName && BANNED_IDENTIFIERS.has(name))
                    add(`reference to restricted global "${name}"`, node);
                break;
            }
            case 'MemberExpression':
            case 'OptionalMemberExpression': {
                const prop = node.property;
                const computed = node.computed === true;
                const nm = staticKeyName(prop, computed);
                if (nm !== undefined && BANNED_MEMBERS.has(nm))
                    add(`access to restricted member "${nm}"`, node);
                if (computed && !isAcceptableComputedKey(prop))
                    add('computed member key built at runtime', node);
                break;
            }
            case 'ObjectPattern': {
                for (const p of node.properties ?? []) {
                    if (p.type !== 'ObjectProperty')
                        continue;
                    const key = p.key;
                    const nm = staticKeyName(key, p.computed === true);
                    if (nm !== undefined && BANNED_MEMBERS.has(nm))
                        add(`destructuring of restricted member "${nm}"`, p);
                    if (p.computed === true && !isAcceptableComputedKey(key))
                        add('computed destructuring key built at runtime', p);
                }
                break;
            }
            case 'StringLiteral':
                if (BANNED_STRINGS.has(node.value))
                    add(`restricted string literal ${JSON.stringify(node.value)}`, node);
                break;
            case 'TemplateLiteral': {
                for (const q of node.quasis ?? []) {
                    const v = q.value.cooked ?? q.value.raw;
                    if (BANNED_STRINGS.has(v))
                        add(`restricted string literal ${JSON.stringify(v)}`, node);
                }
                break;
            }
            case 'Decorator':
                add('decorator', node);
                break;
            default:
                break;
        }
        const nextClassDepth = node.type === 'ClassBody' ? classDepth + 1 : classDepth;
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key) || TYPE_ONLY_KEYS.has(key))
                continue;
            const v = node[key];
            if (Array.isArray(v)) {
                for (const child of v)
                    if (isNode(child))
                        visit(child, node, key, nextClassDepth);
            }
            else if (isNode(v)) {
                visit(v, node, key, nextClassDepth);
            }
        }
    };
    visit(ast, null, '', 0);
    return [...findings];
}
//# sourceMappingURL=safety-ast.js.map