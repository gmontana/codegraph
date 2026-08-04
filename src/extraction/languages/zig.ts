import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Zig extraction.
 *
 * Zig has no classes and no top-level named type declarations: a type is a
 * VALUE produced by a container expression (`struct`/`enum`/`union`/`opaque`)
 * and bound to a `const`, and a module is a `const` bound to `@import(...)`.
 * So one grammar node — `variable_declaration` — fans out to several CodeGraph
 * kinds depending on its right-hand side:
 *
 *   const Point  = struct { ... };   // → struct
 *   const Color  = enum { ... };     // → enum
 *   const Token  = union { ... };     // → struct  (no `union` NodeKind)
 *   const std    = @import("std");   // → import + `imports` ref
 *   const max    = 8;                // → constant
 *   var   count: usize = 0;          // → variable
 *
 * The node-type dispatch ladder in tree-sitter.ts keys on a single node type,
 * so this fan-out is done in the `visitNode` hook (the documented escape hatch
 * for languages whose AST shape doesn't fit the ladder — Pascal uses it too).
 * Everything UNAMBIGUOUS is left to the ladder: `function_declaration` (a free
 * function at file scope, a method when nested in a container scope the hook
 * pushed), and `call_expression`. Methods are detected purely by scope —
 * `isInsideClassLikeNode()` — because Zig has no receiver syntax; the `self`
 * parameter is an ordinary parameter, so `getReceiverType` is deliberately unset.
 *
 * Container members live as DIRECT children of the container node (there is no
 * `body` field), so `extractStruct`/`extractEnum` — which require one — can't be
 * reused; the hook walks members itself and routes each back through
 * `ctx.visitNode`, so methods/nested types/calls still flow through the core.
 */

/** Container-expression node types whose members are walked as a scope. */
const CONTAINER_KINDS = new Set([
  'struct_declaration',
  'union_declaration',
  'opaque_declaration',
  'enum_declaration',
]);

/** `@import`/`@embedFile`/`@cImport` builtins that introduce a module dependency. */
const IMPORT_BUILTINS = new Set(['@import', '@embedFile', '@cImport']);

/** Scope kinds under which a `const`/`var` is a real symbol, not a function local. */
const CONTAINER_SCOPE_KINDS = new Set([
  'file', 'module', 'namespace', 'struct', 'enum', 'class', 'interface', 'trait',
]);

/** Whether a declaration has a modifier as a direct child token. */
function hasModifier(node: SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === modifier) return true;
  }
  return false;
}

const hasPub = (node: SyntaxNode): boolean => hasModifier(node, 'pub');

/** Builtins and primitive spellings that can occur as identifier-shaped types. */
const BUILTIN_TYPES = new Set([
  'anyerror', 'anyframe', 'anyopaque', 'anytype', 'bool', 'comptime_float',
  'comptime_int', 'c_char', 'c_int', 'c_long', 'c_longdouble', 'c_longlong',
  'c_short', 'c_uint', 'c_ulong', 'c_ulonglong', 'c_ushort', 'f16', 'f32',
  'f64', 'f80', 'f128', 'i0', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'noreturn', 'type', 'u0', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'void',
]);

function addReference(name: string, node: SyntaxNode, ownerId: string, ctx: ExtractorContext): void {
  if (!name || BUILTIN_TYPES.has(name)) return;
  ctx.addUnresolvedReference({
    fromNodeId: ownerId,
    referenceName: name,
    referenceKind: 'references',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** Return the type-name chain represented by a qualified Zig type expression. */
function qualifiedTypeName(node: SyntaxNode, source: string): string | null {
  const imported = directImportMember(node, source);
  if (imported) return imported;
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type === 'nullable_type') {
    const inner = node.namedChildCount > 0 ? node.namedChild(node.namedChildCount - 1) : null;
    return inner ? qualifiedTypeName(inner, source) : null;
  }
  if (node.type === 'error_union_type') {
    const ok = getChildByField(node, 'ok');
    return ok ? qualifiedTypeName(ok, source) : null;
  }
  if (node.type !== 'field_expression') return null;
  const object = getChildByField(node, 'object');
  const member = getChildByField(node, 'member');
  const left = object ? qualifiedTypeName(object, source) : null;
  return left && member ? `${left}.${getNodeText(member, source)}` : null;
}

/** Canonical spelling for `@import("file.zig").Type[.member]` expressions. */
function directImportMember(node: SyntaxNode, source: string): string | null {
  const text = getNodeText(node, source);
  const match = text.match(/^@import\s*\(\s*"([^"]+)"\s*\)((?:\s*\.\s*[A-Za-z_]\w*)+)$/);
  if (!match) return null;
  return `@import("${match[1]}")${match[2]!.replace(/\s+/g, '')}`;
}

/**
 * Walk only AST positions that Zig defines as types. Pointer alignment and
 * array-length expressions are intentionally skipped: their identifiers are
 * values, not type dependencies.
 */
function walkType(
  node: SyntaxNode,
  ownerId: string,
  ctx: ExtractorContext,
  typeParams: ReadonlySet<string>,
  seen: Set<string>,
): void {
  if (node.type === 'builtin_type' || node.type === 'builtin_function') return;
  if (node.type === 'identifier') {
    const name = getNodeText(node, ctx.source);
    if (!typeParams.has(name) && !seen.has(name)) {
      seen.add(name);
      addReference(name, node, ownerId, ctx);
    }
    return;
  }
  if (node.type === 'field_expression') {
    const object = getChildByField(node, 'object');
    if (object?.type === 'error_union_type') {
      const errorType = getChildByField(object, 'error');
      if (errorType) walkType(errorType, ownerId, ctx, typeParams, seen);
    }
    const name = qualifiedTypeName(node, ctx.source);
    if (name && !seen.has(name)) {
      seen.add(name);
      addReference(name, node, ownerId, ctx);
    }
    return;
  }
  if (node.type === 'parameter') {
    const type = getChildByField(node, 'type');
    if (type) walkType(type, ownerId, ctx, typeParams, seen);
    return;
  }
  if (node.type === 'function_signature') {
    const params = node.namedChildren.find((child: SyntaxNode) => child.type === 'parameters');
    if (params) walkType(params, ownerId, ctx, typeParams, seen);
    const result = getChildByField(node, 'type');
    if (result) walkType(result, ownerId, ctx, typeParams, seen);
    return;
  }
  if (node.type === 'pointer_type' || node.type === 'array_type' || node.type === 'slice_type') {
    const inner = node.namedChildCount > 0 ? node.namedChild(node.namedChildCount - 1) : null;
    if (inner) walkType(inner, ownerId, ctx, typeParams, seen);
    return;
  }
  if (node.type === 'call_expression') {
    const callee = getChildByField(node, 'function') ?? node.namedChild(0);
    const name = callee ? getNodeText(callee, ctx.source).replace(/\s+/g, '') : '';
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name) && !seen.has(name)) {
      seen.add(name);
      addReference(name, callee!, ownerId, ctx);
    }
    return;
  }
  for (const child of node.namedChildren) {
    walkType(child, ownerId, ctx, typeParams, seen);
  }
}

function declaredTypeParameters(node: SyntaxNode, source: string): string[] {
  const result: string[] = [];
  const params = node.namedChildren.find((child: SyntaxNode) => child.type === 'parameters');
  if (params) {
    for (const param of params.namedChildren) {
      if (!hasModifier(param, 'comptime')) continue;
      const type = getChildByField(param, 'type');
      const name = getChildByField(param, 'name');
      if (type && name && getNodeText(type, source) === 'type') {
        result.push(getNodeText(name, source));
      }
    }
  }
  return result;
}

function extractTypeReferences(node: SyntaxNode, ownerId: string, ctx: ExtractorContext): void {
  const typeParams = new Set(declaredTypeParameters(node, ctx.source));
  for (const scopeId of ctx.nodeStack) {
    const scope = ctx.nodes.find((candidate) => candidate.id === scopeId);
    for (const name of scope?.typeParameters ?? []) typeParams.add(name);
  }

  const params = node.namedChildren.find((child: SyntaxNode) => child.type === 'parameters');

  const seen = new Set<string>();
  if (params) walkType(params, ownerId, ctx, typeParams, seen);
  const type = getChildByField(node, 'type');
  if (type) walkType(type, ownerId, ctx, typeParams, seen);
}

/** `const` vs `var` — read the leading keyword token; default to const. */
function isConstDecl(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)?.type;
    if (t === 'const') return true;
    if (t === 'var') return false;
  }
  return true;
}

/** The bound name of a `variable_declaration` — its first `identifier` child
 *  (the type annotation's identifiers are nested under the `type` field). */
function declName(node: SyntaxNode, source: string): string | null {
  const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return id ? getNodeText(id, source) : null;
}

/** The right-hand side of a `variable_declaration`: the first named child that
 *  begins after the `=` token. Returns null for a bare `var x: T;` (no value). */
function rhsValue(node: SyntaxNode): SyntaxNode | null {
  let eqEnd = -1;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === '=') { eqEnd = c.endIndex; break; }
  }
  if (eqEnd < 0) return null;
  return node.namedChildren.find((c: SyntaxNode) => c.startIndex >= eqEnd) ?? null;
}

/** The imported module/file for an `@import`-family builtin, or null. The string
 *  argument is returned verbatim ("std", "builtin", "./foo.zig"); a `@cImport`
 *  with no string argument resolves to the conventional "c" module. */
function importTarget(builtin: SyntaxNode, source: string): string | null {
  const name = builtinName(builtin, source);
  if (!IMPORT_BUILTINS.has(name)) return null;
  const args = builtin.namedChildren.find((c: SyntaxNode) => c.type === 'arguments');
  const str = args?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
  if (!str) return name === '@cImport' ? 'c' : null;
  return getNodeText(str, source).replace(/^"/, '').replace(/"$/, '');
}

function nestedImportTarget(node: SyntaxNode, source: string): string | null {
  if (node.type === 'builtin_function') return importTarget(node, source);
  for (const child of node.namedChildren) {
    const target = nestedImportTarget(child, source);
    if (target) return target;
  }
  return null;
}

function builtinName(node: SyntaxNode, source: string): string {
  const id = node.namedChildren.find((child: SyntaxNode) => child.type === 'builtin_identifier');
  return id ? getNodeText(id, source) : '';
}

function cIncludes(node: SyntaxNode, source: string): string[] {
  const headers: string[] = [];
  const visit = (current: SyntaxNode): void => {
    if (current.type === 'builtin_function' && builtinName(current, source) === '@cInclude') {
      const args = current.namedChildren.find((child: SyntaxNode) => child.type === 'arguments');
      const str = args?.namedChildren.find((child: SyntaxNode) => child.type === 'string');
      if (str) headers.push(getNodeText(str, source).replace(/^"|"$/g, ''));
      return;
    }
    for (const child of current.namedChildren) visit(child);
  };
  visit(node);
  return headers;
}

/** The CodeGraph kind of the innermost scope on the stack ('file' when empty). */
function scopeKind(ctx: ExtractorContext): string {
  if (ctx.nodeStack.length === 0) return 'file';
  const top = ctx.nodeStack[ctx.nodeStack.length - 1];
  return ctx.nodes.find((n) => n.id === top)?.kind ?? 'file';
}

/**
 * Create the type node for a container-valued declaration and walk its members
 * under that scope, so nested `function_declaration`s become methods (via the
 * core ladder's `isInsideClassLikeNode()` check) and nested types recurse here.
 * An `enum`'s `container_field`s are its members (→ `enum_member`); a struct's
 * are fields (→ `field`).
 */
function extractContainer(
  decl: SyntaxNode,
  value: SyntaxNode,
  name: string,
  ctx: ExtractorContext,
  typeParameters?: string[],
): void {
  const isEnum = value.type === 'enum_declaration';
  const isTaggedUnion = value.type === 'union_declaration' && hasModifier(value, 'enum');
  const owner = ctx.createNode(isEnum ? 'enum' : 'struct', name, decl, {
    docstring: getPrecedingDocstring(decl, ctx.source),
    visibility: hasPub(decl) ? 'public' : 'private',
    isExported: hasPub(decl),
    decorators: isTaggedUnion ? ['tagged_union'] : undefined,
    typeParameters,
  });
  if (!owner) return;

  ctx.pushScope(owner.id);
  for (const child of value.namedChildren) {
    if (child.type === 'container_field') {
      const nameNode = getChildByField(child, 'name') ?? child;
      const member = getNodeText(nameNode, ctx.source);
      if (isEnum) {
        if (member !== '_') ctx.createNode('enum_member', member, child);
      } else {
        const typeNode = getChildByField(child, 'type');
        const field = ctx.createNode('field', member, child, {
          signature: typeNode ? `: ${getNodeText(typeNode, ctx.source)}` : undefined,
        });
        if (field) extractTypeReferences(child, field.id, ctx);
        if (isTaggedUnion && member !== '_') ctx.createNode('enum_member', member, child);
      }
    } else {
      // function_declaration → method, nested variable_declaration → back here,
      // test_declaration → test, comptime_declaration → descend for calls.
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
}

/** An `error { A, B }` set bound to a const → an enum whose members are the
 *  error names, so `MyError.A` navigation and impact analysis resolve. */
function extractErrorSet(decl: SyntaxNode, value: SyntaxNode, name: string, ctx: ExtractorContext): void {
  const owner = ctx.createNode('enum', name, decl, {
    docstring: getPrecedingDocstring(decl, ctx.source),
    visibility: hasPub(decl) ? 'public' : 'private',
    isExported: hasPub(decl),
  });
  if (!owner) return;
  ctx.pushScope(owner.id);
  for (const child of value.namedChildren) {
    if (child.type === 'identifier') {
      ctx.createNode('enum_member', getNodeText(child, ctx.source), child);
    }
  }
  ctx.popScope();
}

/** `const m = @import("foo.zig")` → an `import` node plus an `imports` reference
 *  the resolver maps to the target file (internal) or leaves external (std). */
function extractImport(decl: SyntaxNode, value: SyntaxNode, ctx: ExtractorContext): boolean {
  const target = nestedImportTarget(value, ctx.source);
  if (!target) return false;
  const targets = builtinName(value, ctx.source) === '@cImport'
    ? cIncludes(value, ctx.source)
    : [target];
  if (targets.length === 0) targets.push(target);
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  for (const imported of new Set(targets)) {
    ctx.createNode('import', imported, decl, { signature: getNodeText(decl, ctx.source).trim() });
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: imported,
        referenceKind: 'imports',
        line: decl.startPosition.row + 1,
        column: decl.startPosition.column,
      });
    }
  }
  return true;
}

/** Route a `variable_declaration` to the right extraction based on its RHS. */
function visitVarDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = declName(node, ctx.source);
  if (!name) return false;
  const value = rhsValue(node);

  if (value) {
    if (CONTAINER_KINDS.has(value.type)) {
      extractContainer(node, value, name, ctx);
      return true;
    }
    if (value.type === 'error_set_declaration') {
      extractErrorSet(node, value, name, ctx);
      return true;
    }
    if ((value.type === 'builtin_function' || directImportMember(value, ctx.source)) &&
        extractImport(node, value, ctx)) {
      return true;
    }
  }

  // A plain value is a symbol only at container scope; inside a function body it
  // is a local and must not become a node.
  if (!CONTAINER_SCOPE_KINDS.has(scopeKind(ctx))) return true;
  const valText = value ? getNodeText(value, ctx.source).slice(0, 80) : undefined;
  const symbol = ctx.createNode(isConstDecl(node) ? 'constant' : 'variable', name, node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: valText ? `= ${valText}${valText.length >= 80 ? '...' : ''}` : undefined,
    visibility: hasPub(node) ? 'public' : 'private',
    isExported: hasPub(node),
  });
  if (symbol) extractTypeReferences(node, symbol.id, ctx);
  return true;
}

/** Emit Zig references that the language-neutral walkers cannot represent. */
function extractReferences(node: SyntaxNode, ownerId: string, ctx: ExtractorContext): void {
  if (node.type === 'variable_declaration') {
    extractTypeReferences(node, ownerId, ctx);
    return;
  }

  if (node.type === 'struct_initializer') {
    const type = node.namedChild(0);
    const name = type ? getNodeText(type, ctx.source).replace(/\s+/g, '') : '';
    if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) {
      ctx.addUnresolvedReference({
        fromNodeId: ownerId,
        referenceName: name,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
    return;
  }

  if (node.type !== 'builtin_function') {
    extractTypeReferences(node, ownerId, ctx);
    return;
  }
  if (builtinName(node, ctx.source) !== '@call') return;
  const args = node.namedChildren.find((child: SyntaxNode) => child.type === 'arguments');
  const callee = args?.namedChild(1);
  const name = callee ? getNodeText(callee, ctx.source).replace(/\s+/g, '') : '';
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) return;
  ctx.addUnresolvedReference({
    fromNodeId: ownerId,
    referenceName: name,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** `test "name" { ... }` (or unnamed `test { ... }`) → a `function` node whose
 *  body is walked, so a test shows up in `callers`/blast-radius of what it
 *  exercises — the thing CodeGraph is for when triaging a Zig change. */
function visitTest(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const str = node.namedChildren.find((c: SyntaxNode) => c.type === 'string' || c.type === 'identifier');
  const name = str ? getNodeText(str, ctx.source).replace(/^"/, '').replace(/"$/, '') : 'test';
  const fn = ctx.createNode('function', name, node, { signature: 'test' });
  const body = node.namedChildren.find((c: SyntaxNode) => c.type === 'block');
  if (fn && body) {
    ctx.pushScope(fn.id);
    ctx.visitFunctionBody(body, fn.id);
    ctx.popScope();
  }
  return true;
}

/** A type factory `fn Name(...) type { return struct {...}; }` — return the
 *  container the function produces, or null if it isn't one. Only a direct
 *  `return` statement is considered; nested scopes (the container's own methods)
 *  are not searched. A returned `struct {...}` is a type DEFINITION
 *  (struct_declaration); a returned `.{...}` value is not, so plain functions
 *  are never mistaken for factories. */
function returnedContainer(fnNode: SyntaxNode): SyntaxNode | null {
  const body = getChildByField(fnNode, 'body');
  if (!body) return null;
  for (const stmt of body.namedChildren) {
    const ret = stmt.type === 'return_expression'
      ? stmt
      : stmt.namedChildren.find((c: SyntaxNode) => c.type === 'return_expression');
    const val = ret?.namedChildren[0];
    if (val && CONTAINER_KINDS.has(val.type)) return val;
  }
  return null;
}

/** Zig generic types ARE functions returning an anonymous container
 *  (`fn List(comptime T: type) type { return struct {...}; }` — the ArrayList
 *  idiom). Index such a factory as the type it yields: a struct/enum named for
 *  the function, with the container's declarations as methods, so `List.append`
 *  navigates like any other type. A normal function returns false and falls
 *  through to the core ladder unchanged. */
function visitFnDecl(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const container = returnedContainer(node);
  if (!container) return false;
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return false;
  extractContainer(
    node,
    container,
    getNodeText(nameNode, ctx.source),
    ctx,
    declaredTypeParameters(node, ctx.source),
  );
  return true;
}

export const zigExtractor: LanguageExtractor = {
  // function_declaration is BOTH the free-function and the method node type;
  // the ladder picks method when it fires inside a pushed container scope.
  functionTypes: ['function_declaration'],
  classTypes: [],
  methodTypes: ['function_declaration'],
  interfaceTypes: [],
  // Containers, imports, constants and fields are all reached through
  // variable_declaration and handled in visitNode — so these stay empty.
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  variableTypes: [],
  callTypes: ['call_expression'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type', // Zig: a function's return type is the `type` field.

  getSignature: (node, source) => {
    const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameters');
    const ret = getChildByField(node, 'type');
    if (!params && !ret) return undefined;
    if (params && ret) return source.slice(params.startIndex, ret.endIndex).trim();
    return params ? getNodeText(params, source) : getNodeText(ret!, source);
  },

  // `pub` is Zig's only visibility marker (visible to importers); everything
  // else is file-private. `export`/`extern` are linkage, not source visibility.
  getVisibility: (node) => (hasPub(node) ? 'public' : 'private'),
  isExported: (node) => hasPub(node) || hasModifier(node, 'export'),
  extractModifiers: (node) => {
    const modifiers = ['inline', 'noinline'].filter((modifier) => hasModifier(node, modifier));
    return modifiers.length > 0 ? modifiers : undefined;
  },
  getTypeParameters: (node, source) => {
    const names = declaredTypeParameters(node, source);
    return names.length > 0 ? names : undefined;
  },
  extractReferences,

  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    if (node.type === 'variable_declaration') return visitVarDecl(node, ctx);
    if (node.type === 'function_declaration') return visitFnDecl(node, ctx);
    if (node.type === 'test_declaration') return visitTest(node, ctx);
    return false;
  },

};
